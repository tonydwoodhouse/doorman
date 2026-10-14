#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Install (or remove) the doorman toolkit in a target workspace.

.DESCRIPTION
  This is the vendored install: a self-contained copy committed to the project, for CI and for
  anyone not using the Claude Code or Codex plugin. Copies scripts/ (plus
  config/doorman.config.example.json) into <Workspace>/<ToolsDir> (default tools/doorman). Never
  copies per-developer artifacts (node_modules, storageState*.json, *.png). Existing files are
  skipped unless -Force is given, so re-running is safe.

  Every file it writes is recorded, with its SHA-256, in <Workspace>/.doorman/install-manifest.json
  (the receipt; commit it with the toolkit). A re-run updates the files it installed and that nobody
  has changed since; a file someone changed, or one doorman didn't put there, is skipped unless
  -Force — and -Force keeps a .bak of anything it overwrites that doorman didn't write.

  doorman.config.json is yours, not the installer's: it is created once (by detect.mjs, which fills
  in baseUrl) and never overwritten after that — not even by -Force. An upgrade checks it and
  reports problems instead. -ResetConfig replaces it, keeping the old one as a timestamped .bak.

.PARAMETER Workspace
  Path to the target repo root. Defaults to the current directory.

.PARAMETER ToolsDir
  Where to place the toolkit, relative to the workspace. Default: tools/doorman

.PARAMETER InstallSkill
  Also copy a per-project skill into the workspace for agents that don't have the plugin: the
  Claude Code skill at <Workspace>/.claude/skills/get-past-login/SKILL.md and the Codex skill at
  <Workspace>/.agents/skills/get-past-login/SKILL.md. Both read the workspace's
  doorman.config.json when they run.

.PARAMETER Bootstrap
  After copying, run `npm install` and `npx playwright install chromium` in the toolkit folder.

.PARAMETER Force
  Overwrite the toolkit files that already exist in the target. Never doorman.config.json.

.PARAMETER ResetConfig
  Replace doorman.config.json with a freshly detected one. The old file is kept beside it as
  doorman.config.json.<timestamp>.bak.

.PARAMETER Uninstall
  Remove what this installer added, as recorded in <Workspace>/.doorman/install-manifest.json: each
  listed file that is still exactly as installed (a changed file is kept and reported; a file
  -Force replaced gets its original back), the CLAUDE.md and AGENTS.md sections, and any saved
  session (which holds live credentials). Directories go only once empty. Without a receipt it
  removes nothing.

.EXAMPLE
  ./install.ps1 -Workspace C:\src\my-app -InstallSkill -Bootstrap

.EXAMPLE
  ./install.ps1 -Workspace C:\src\my-app -Uninstall

.NOTES
  Requires PowerShell 7+. Windows ships with Windows PowerShell 5.1, which is NOT enough —
  install PowerShell 7 (https://aka.ms/powershell) or use install.sh from Git Bash.
#>
#Requires -Version 7.0
[CmdletBinding()]
param(
  [string]$Workspace = (Get-Location).Path,
  [string]$ToolsDir = 'tools/doorman',
  [switch]$InstallSkill,
  [switch]$Bootstrap,
  [switch]$Force,
  [switch]$ResetConfig,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
# Normalized, because it is also the prefix of every path in the receipt.
$ToolsDir = (($ToolsDir -replace '\\', '/') -replace '^\./', '') -replace '/+$', ''
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path   # installers/ — also where the
                                                                  # section/skill templates live
$repoRoot = Split-Path -Parent $scriptRoot
$scriptsDir = Join-Path $repoRoot 'scripts'   # the runtime, shared with both plugins
$configDir = Join-Path $repoRoot 'config'     # the placeholder config this installer starts from

if (-not (Test-Path $scriptsDir)) { throw "scripts/ not found next to installers/ ($scriptsDir)" }
if (-not (Test-Path $configDir))  { throw "config/ not found next to installers/ ($configDir)" }
if (-not (Test-Path $Workspace))  { throw "Workspace not found: $Workspace" }

$dest = Join-Path $Workspace $ToolsDir
$claudePath = Join-Path $Workspace 'CLAUDE.md'
$agentsPath = Join-Path $Workspace 'AGENTS.md'
$sectionStart = '<!-- doorman:start -->'
$sectionEnd = '<!-- doorman:end -->'
$claudeSkillDir = Join-Path $Workspace '.claude/skills/get-past-login'
$claudeSkillDest = Join-Path $claudeSkillDir 'SKILL.md'
$codexSkillDir = Join-Path $Workspace '.agents/skills/get-past-login'
$codexSkillDest = Join-Path $codexSkillDir 'SKILL.md'

# The payload — the files the installer manages: everything in scripts/ except per-developer
# artifacts, plus the example config from config/ (the plugins have no use for it, so it doesn't
# live in scripts/). Enumerated rather than listed, so a new script is picked up automatically.
# doorman.config.json is deliberately not in it: that file is the developer's (see below).
$skipPatterns = @('node_modules', 'storageState*.json', 'sessionStorage*.json', '*.png', 'doorman.config.json')
$payload = @(
  Get-ChildItem -Path $scriptsDir -Force |
    Where-Object { $name = $_.Name; -not ($skipPatterns | Where-Object { $name -like $_ }) } |
    ForEach-Object { [pscustomobject]@{ Name = $_.Name; FullName = $_.FullName } }
) + [pscustomobject]@{ Name = 'doorman.config.example.json'; FullName = (Join-Path $configDir 'doorman.config.example.json') }
$configName = 'doorman.config.json'
$configPath = Join-Path $dest $configName

# ---------------------------------------------------------------------------
# The receipt: what the installer wrote, so a re-run and -Uninstall can tell its files from yours
# ---------------------------------------------------------------------------
# One entry per line, in the same fixed layout install.sh writes, so either installer can update or
# remove what the other installed.
$receiptDir = Join-Path $Workspace '.doorman'
$receiptPath = Join-Path $receiptDir 'install-manifest.json'
$version = try { (Get-Content -Raw (Join-Path $repoRoot '.claude-plugin/plugin.json') | ConvertFrom-Json).version } catch { 'unknown' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$receiptEntries = [System.Collections.Generic.List[object]]::new()
$receiptTools = $null

# Carriage returns are ignored, so a checkout that converts line endings (core.autocrlf) still counts
# as unchanged — and the hash matches the one install.sh computes.
function Get-ContentHash([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ([Array]::IndexOf($bytes, [byte]13) -ge 0) {
    $kept = [System.Collections.Generic.List[byte]]::new($bytes.Length)
    foreach ($b in $bytes) { if ($b -ne 13) { $kept.Add($b) } }
    $bytes = $kept.ToArray()
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Read-Receipt {
  if (-not (Test-Path $receiptPath)) { return $false }
  $data = Get-Content -Raw -Path $receiptPath | ConvertFrom-Json
  $script:receiptTools = $data.toolsDir
  foreach ($f in @($data.files)) {
    if ($null -eq $f) { continue }
    $receiptEntries.Add([pscustomobject]@{
      path = $f.path; sha256 = $f.sha256; action = $f.action; version = $f.version; backup = [string]$f.backup
    })
  }
  return $true
}

function Find-Entry([string]$rel) {
  foreach ($entry in $receiptEntries) { if ($entry.path -eq $rel) { return $entry } }
  return $null
}

function Set-Entry([string]$rel, [string]$hash, [string]$action, [string]$backup) {
  $entry = Find-Entry $rel
  if ($entry) {
    $entry.sha256 = $hash; $entry.action = $action; $entry.version = $version; $entry.backup = $backup
  } else {
    $receiptEntries.Add([pscustomobject]@{ path = $rel; sha256 = $hash; action = $action; version = $version; backup = $backup })
  }
}

function Write-Receipt {
  New-Item -ItemType Directory -Force -Path $receiptDir | Out-Null
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add('{')
  $lines.Add('  "about": "Written by the doorman installer: the files it installed, so a re-run and --uninstall touch only those. Commit it; do not edit it.",')
  $lines.Add("  ""toolsDir"": ""$ToolsDir"",")
  $lines.Add('  "files": [')
  # Sorted by path, ordinal, so the file is the same whichever installer wrote it.
  # (List.Sort in place: [Array]::Sort would be handed copies by PowerShell and sort nothing.)
  $entries = [System.Collections.Generic.List[object]]::new($receiptEntries)
  $entries.Sort([System.Comparison[object]]{ param($x, $y) [string]::CompareOrdinal($x.path, $y.path) })
  for ($i = 0; $i -lt $entries.Count; $i++) {
    $e = $entries[$i]
    $comma = if ($i -lt $entries.Count - 1) { ',' } else { '' }
    $lines.Add("    {""path"": ""$($e.path)"", ""sha256"": ""$($e.sha256)"", ""action"": ""$($e.action)"", ""version"": ""$($e.version)"", ""backup"": ""$($e.backup)""}$comma")
  }
  $lines.Add('  ]')
  $lines.Add('}')
  # LF and no BOM, byte for byte what install.sh writes.
  Set-Content -Path "$receiptPath.tmp" -Value (($lines -join "`n") + "`n") -Encoding utf8NoBOM -NoNewline
  Move-Item -Force "$receiptPath.tmp" $receiptPath
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
if ($Uninstall) {
  $removed = [System.Collections.Generic.List[string]]::new()
  $left = [System.Collections.Generic.List[string]]::new()
  $workspaceFull = (Resolve-Path $Workspace).Path

  # Remove a directory and its now-empty parents, never past the workspace. Anything holding
  # other content survives untouched.
  function Remove-EmptyDirs([string]$dir) {
    while ($dir -and (Test-Path $dir)) {
      $full = (Resolve-Path $dir).Path
      if ($full -eq $workspaceFull) { break }
      if (Get-ChildItem -Path $dir -Force) { break }
      $rel = $full.Substring($workspaceFull.Length).TrimStart('\', '/') -replace '\\', '/'
      Remove-Item $dir -Force
      $removed.Add("$rel/ (empty directory)")
      $dir = Split-Path -Parent $dir
    }
  }

  # Strip a marked section from a file. Returns 0 = section removed, 1 = no section present,
  # 2 = the file held nothing else and was deleted.
  function Remove-Section([string]$path, [string]$label) {
    if (-not (Test-Path $path)) { return 1 }
    $content = Get-Content -Raw -Path $path
    if (-not ($content.Contains($sectionStart) -and $content.Contains($sectionEnd))) { return 1 }
    $pattern = "(?s)$([regex]::Escape($sectionStart)).*?$([regex]::Escape($sectionEnd))"
    $stripped = [regex]::Replace($content, $pattern, '')
    $stripped = ($stripped -replace "(\r?\n){3,}", "`n`n").Trim()
    if ($stripped.Length -eq 0) {
      Remove-Item $path -Force
      return 2
    }
    Set-Content -Path $path -Value ($stripped + "`n") -Encoding utf8NoBOM -NoNewline
    return 0
  }

  if (-not (Read-Receipt)) {
    if ((Test-Path $dest) -or (Test-Path $claudeSkillDest) -or (Test-Path $codexSkillDest)) {
      [Console]::Error.WriteLine(@"
No install receipt at .doorman/install-manifest.json, so nothing here can be shown to be
doorman's — and nothing was removed. (Copies installed before 0.2.0 have no receipt.)
Re-run the installer with -Force to adopt this copy, then uninstall; or delete $ToolsDir
and the doorman section of CLAUDE.md and AGENTS.md yourself.
"@)
      exit 1
    }
    Write-Host "Nothing to remove — no doorman toolkit found in $Workspace" -ForegroundColor Yellow
    return
  }
  $toolsRel = if ($receiptTools) { $receiptTools } else { $ToolsDir }
  $kept = [System.Collections.Generic.List[string]]::new()

  foreach ($entry in $receiptEntries) {
    $target = Join-Path $Workspace $entry.path
    if (-not (Test-Path $target)) { continue }
    if ((Get-ContentHash $target) -ne $entry.sha256) { $kept.Add($entry.path); continue }
    Remove-Item $target -Force
    $backupPath = if ($entry.backup) { Join-Path $Workspace $entry.backup } else { $null }
    if ($backupPath -and (Test-Path $backupPath)) {
      Move-Item $backupPath $target
      $removed.Add("$($entry.path) (put back the version that was there before)")
    } else {
      $removed.Add($entry.path)
      Remove-EmptyDirs (Split-Path -Parent $target)
    }
  }

  # Saved sessions are live credentials — removing the toolkit should not leave them behind.
  $sessionDir = Join-Path $Workspace $toolsRel
  if (Test-Path $sessionDir) {
    foreach ($pattern in @('storageState*.json', 'sessionStorage*.json', 'auth-check*.png', 'shot-*.png', '.*.tmp')) {
      Get-ChildItem -Path $sessionDir -Filter $pattern -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force
        $removed.Add("$toolsRel/$($_.Name)")
      }
    }
  }

  $claudeStatus = Remove-Section $claudePath 'CLAUDE.md'
  switch ($claudeStatus) {
    0 { $removed.Add('CLAUDE.md (doorman section only)') }
    2 { $removed.Add('CLAUDE.md (contained nothing else)') }
  }
  $agentsStatus = Remove-Section $agentsPath 'AGENTS.md'
  switch ($agentsStatus) {
    0 { $removed.Add('AGENTS.md (doorman section only)') }
    2 { $removed.Add('AGENTS.md (contained nothing else)') }
  }

  # Whatever is still in the toolkit folder, other than the files kept above, wasn't installed here.
  if (Test-Path $sessionDir) {
    Get-ChildItem -Path $sessionDir -Force | ForEach-Object {
      $rel = "$toolsRel/$($_.Name)"
      if (-not $kept.Contains($rel)) { $left.Add($rel) }
    }
    Remove-EmptyDirs $sessionDir
  }

  # The receipt goes last, so an interrupted uninstall can simply be run again.
  Remove-Item $receiptPath -Force
  Remove-EmptyDirs $receiptDir

  Write-Host "`nRemoved:" -ForegroundColor Cyan
  foreach ($line in $removed) { Write-Host "  - $line" }
  if ($removed.Count -eq 0) { Write-Host '  (nothing)' }
  if ($kept.Count -gt 0) {
    Write-Host "`nKept — changed since doorman installed them, so they may hold your work (delete them if not):" -ForegroundColor DarkYellow
    foreach ($line in $kept) { Write-Host "  - $line" }
  }
  if ($left.Count -gt 0) {
    Write-Host "`nLeft in place (not installed by this script — delete manually if you want them gone):" -ForegroundColor DarkYellow
    foreach ($line in $left) { Write-Host "  - $line" }
  }
  return
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

# The agent instructions live in installers/CLAUDE.section.md and installers/AGENTS.section.md so
# every installer emits identical text per file; {{TOOLS_DIR}} is the only substitution.
function Get-Section([string]$name) {
  $template = Join-Path $scriptRoot $name
  if (-not (Test-Path $template)) { throw "Missing $template" }
  return ((Get-Content -Raw -Path $template) -replace '\{\{TOOLS_DIR\}\}', $ToolsDir).TrimEnd()
}
$claudeSection = Get-Section 'CLAUDE.section.md'
$agentsSection = Get-Section 'AGENTS.section.md'

New-Item -ItemType Directory -Force -Path $dest | Out-Null

[void](Read-Receipt)
$script:unchanged = 0

# Install one managed file, deciding from the receipt whether whatever is already there is ours.
function Install-ManagedFile([string]$src, [string]$rel) {
  $target = Join-Path $Workspace $rel
  $newHash = Get-ContentHash $src
  if (-not (Test-Path $target)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item $src $target -Force
    Set-Entry $rel $newHash 'created' ''
    Write-Host "  copied: $rel" -ForegroundColor Green
    return
  }
  $current = Get-ContentHash $target
  $entry = Find-Entry $rel
  if ($current -eq $newHash -and $entry) {
    # Ours, and already exactly this version.
    Set-Entry $rel $newHash $entry.action $entry.backup
    $script:unchanged++
    return
  }
  if ($current -eq $newHash) {
    # The same content, but not recorded as ours (a copy from before 0.2.0, or someone's own).
    # Claiming it would let an uninstall delete it, so that takes -Force like any other file.
    if (-not $Force) {
      Write-Host "  skip (identical, but not installed by doorman — -Force adopts it): $rel" -ForegroundColor DarkYellow
      return
    }
    Set-Entry $rel $newHash 'adopted' ''
    Write-Host "  adopted: $rel" -ForegroundColor Green
    return
  }
  if ($entry -and $current -eq $entry.sha256) {
    # Ours, and nobody has touched it since: safe to update.
    Copy-Item $src $target -Force
    Set-Entry $rel $newHash 'updated' $entry.backup
    Write-Host "  updated: $rel" -ForegroundColor Green
    return
  }
  if (-not $Force) {
    $why = if ($entry) { 'changed since installed' } else { 'exists, not installed by doorman' }
    Write-Host "  skip ($why — -Force replaces it, keeping a .bak): $rel" -ForegroundColor DarkYellow
    return
  }
  # Overwriting content doorman didn't write: keep it beside the new file first.
  $backup = "$rel.$stamp.bak"
  Copy-Item $target (Join-Path $Workspace $backup) -Force
  Copy-Item $src $target -Force
  Set-Entry $rel $newHash 'replaced' $backup
  Write-Host "  replaced: $rel (the previous file is kept as $(Split-Path -Leaf $backup))" -ForegroundColor Yellow
}

foreach ($item in $payload) {
  Install-ManagedFile $item.FullName "$ToolsDir/$($item.Name)"
}
if ($InstallSkill) {
  $skillTemplate = Join-Path $scriptRoot 'get-past-login.SKILL.template.md'
  Install-ManagedFile $skillTemplate '.claude/skills/get-past-login/SKILL.md'
  Install-ManagedFile $skillTemplate '.agents/skills/get-past-login/SKILL.md'
}
if ($script:unchanged -gt 0) { Write-Host "  up to date: $($script:unchanged) file(s)" }

# CLAUDE.md/AGENTS.md are written last, so a failure above never leaves a workspace advertising a
# toolkit whose scripts didn't land.
function Update-InstructionFile([string]$path, [string]$section, [string]$label) {
  if (Test-Path $path) {
    $content = Get-Content -Raw -Path $path
    $hasStart = $content.Contains($sectionStart)
    $hasEnd = $content.Contains($sectionEnd)
    if ($hasStart -xor $hasEnd) {
      throw "$label contains an incomplete doorman instruction block. Restore or remove it before reinstalling."
    }
    if ($hasStart) {
      $pattern = "(?s)$([regex]::Escape($sectionStart)).*?$([regex]::Escape($sectionEnd))"
      $updated = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $section })
    } else {
      $updated = $content.TrimEnd() + "`n`n" + $section + "`n"
    }
  } else {
    $updated = $section + "`n"
  }
  # -NoNewline: the content above already ends with exactly one newline. Without it Set-Content
  # appends a second, and the file stops matching install.sh's output byte for byte.
  Set-Content -Path $path -Value $updated -Encoding utf8NoBOM -NoNewline
  Write-Host "  updated: $label (doorman instructions)" -ForegroundColor Green
}
Update-InstructionFile $claudePath $claudeSection 'CLAUDE.md'
Update-InstructionFile $agentsPath $agentsSection 'AGENTS.md'

# The config. It belongs to the developer, so an existing one is only ever checked, never written —
# -Force included. -ResetConfig is the one way to replace it, and keeps the old one beside it.
Write-Host ''
if ($ResetConfig -and (Test-Path $configPath)) {
  $backup = "$configPath.$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
  Move-Item $configPath $backup
  Write-Host "  backed up: $ToolsDir/$configName -> $(Split-Path -Leaf $backup)" -ForegroundColor DarkYellow
}
$haveNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
$configCreated = $false
if (Test-Path $configPath) {
  Write-Host "Keeping your $ToolsDir/$configName (installs never change it; -ResetConfig replaces it)." -ForegroundColor Cyan
  if ($haveNode) {
    Push-Location $dest
    try {
      & node check-config.mjs
      if ($LASTEXITCODE -ne 0) {
        Write-Host "  Left as it is — fix the above in $ToolsDir/$configName. New settings are in $configName's example beside it." -ForegroundColor DarkYellow
      }
    } finally { Pop-Location }
  }
} else {
  # Created by detect.mjs, which fills in baseUrl from the project's own files (and starts from the
  # plugin's config when the project has one). Node builtins only, so this runs before npm install.
  # It is never fatal: when it finds nothing it writes "configured": false, which keeps every
  # script stopping with instructions rather than testing the placeholder URL.
  if ($haveNode) {
    Write-Host "Creating $ToolsDir/$configName — detecting the dev server URL from this project..." -ForegroundColor Cyan
    Push-Location $dest
    try {
      & node detect.mjs --write --root $Workspace
    } catch {
      Write-Host "  detection failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
    } finally { Pop-Location }
  }
  if (-not (Test-Path $configPath)) {
    # No Node (or detection failed), so nothing can detect or guard. Start from the example, marked
    # unconfigured — inserting the line rather than rewriting keeps it in step with the example.
    if (-not $haveNode) { Write-Host '  node not found, so the URL could not be detected.' -ForegroundColor DarkYellow }
    $configLines = @(Get-Content -Path (Join-Path $configDir 'doorman.config.example.json'))
    $configLines = @($configLines[0], '  "configured": false,') + $configLines[1..($configLines.Count - 1)]
    # -NoNewline + explicit LF joins: Set-Content would otherwise write CRLF and the file would
    # stop matching install.sh's output byte for byte.
    Set-Content -Path $configPath -Value (($configLines -join "`n") + "`n") -Encoding utf8NoBOM -NoNewline
    Write-Host "  created $ToolsDir/$configName from the example, marked unconfigured — set baseUrl by hand." -ForegroundColor DarkYellow
  }
  $configCreated = $true
}

# Recorded as created, so an uninstall removes it only if it was never edited — which, for a config
# someone has actually used, means it is kept.
if ($configCreated -and (Test-Path $configPath)) {
  Set-Entry "$ToolsDir/$configName" (Get-ContentHash $configPath) 'created' ''
}
Write-Receipt

if ($Bootstrap) {
  Write-Host "`nBootstrapping (npm install + playwright chromium)..." -ForegroundColor Cyan
  Push-Location $dest
  try {
    & npm install
    & npx playwright install chromium
  } finally { Pop-Location }
}

Write-Host "`n✅ Installed to $dest" -ForegroundColor Cyan
Write-Host @"

Next steps (or just ask your AI assistant to do them):
  1. Check  $ToolsDir/doorman.config.json  — baseUrl was detected where possible; set
     loginPath, defaultCheckPath and ideally authenticatedSelector for this app.
     ("configured": false in that file means detection found nothing.)
$(if (-not $Bootstrap) { "  2. cd $ToolsDir && npm install && npx playwright install chromium" })
  3. Start your app, then:  cd $ToolsDir && node ensure.mjs
     (checks the session, and opens a sign-in window if one is needed)
  4. Screenshot:  node shot.mjs /some/route
"@
