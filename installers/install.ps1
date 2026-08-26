#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Install (or remove) the doorman toolkit in a target workspace.

.DESCRIPTION
  This is the vendored install: a self-contained copy committed to the project, for CI and for
  anyone not using the Claude Code or Codex plugin. Copies scripts/ (plus
  config/doorman.config.example.json) into <Workspace>/<ToolsDir> (default tools/doorman). Never
  copies per-developer artifacts (node_modules, storageState*.json, *.png). Existing files are
  skipped unless -Force is given, so re-running is safe and won't clobber a customized
  doorman.config.json.

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
  Overwrite files that already exist in the target.

.PARAMETER Uninstall
  Remove what this installer added: the toolkit files, the CLAUDE.md and AGENTS.md sections, the
  skills, and any saved session (which holds live credentials). Files it did not install are left
  in place and reported. Nothing else in the workspace is touched.

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
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
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

# The payload: everything in scripts/ except per-developer artifacts, plus the placeholder config
# from config/ (the plugins have no use for it, so it doesn't live in scripts/). Enumerated rather
# than listed, so a new script is picked up automatically. This list doubles as the manifest for
# -Uninstall, so it only ever removes what it installed.
$skip = @('node_modules', 'storageState.json', 'sessionStorage.json')
$payload = @(
  Get-ChildItem -Path $scriptsDir -Force |
    Where-Object { $skip -notcontains $_.Name -and $_.Name -notlike '*.png' } |
    ForEach-Object { [pscustomobject]@{ Name = $_.Name; FullName = $_.FullName } }
) + [pscustomobject]@{ Name = 'doorman.config.json'; FullName = (Join-Path $configDir 'doorman.config.example.json') }

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

  if (Test-Path $dest) {
    foreach ($item in $payload) {
      $target = Join-Path $dest $item.Name
      if (Test-Path $target) {
        Remove-Item $target -Force -Recurse
        $removed.Add("$ToolsDir/$($item.Name)")
      }
    }
    # Saved sessions are live credentials — removing the toolkit should not leave them behind.
    foreach ($pattern in @('storageState*.json', 'sessionStorage*.json', 'auth-check*.png', 'shot-*.png')) {
      Get-ChildItem -Path $dest -Filter $pattern -File -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force
        $removed.Add("$ToolsDir/$($_.Name)")
      }
    }
    Get-ChildItem -Path $dest -Force | ForEach-Object { $left.Add("$ToolsDir/$($_.Name)") }
    if ($left.Count -eq 0) { Remove-EmptyDirs $dest }
  }

  if (Test-Path $claudeSkillDest) {
    Remove-Item $claudeSkillDest -Force
    $removed.Add('.claude/skills/get-past-login/SKILL.md')
    Remove-EmptyDirs $claudeSkillDir
  }
  if (Test-Path $codexSkillDest) {
    Remove-Item $codexSkillDest -Force
    $removed.Add('.agents/skills/get-past-login/SKILL.md')
    Remove-EmptyDirs $codexSkillDir
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

  if ($removed.Count -eq 0) {
    Write-Host "Nothing to remove — no doorman toolkit found in $Workspace" -ForegroundColor Yellow
    return
  }
  Write-Host "`nRemoved:" -ForegroundColor Cyan
  foreach ($line in $removed) { Write-Host "  - $line" }
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

# Whether this run creates the config, which decides if URL detection may write to it below.
$configPath = Join-Path $dest 'doorman.config.json'
$configIsNew = -not (Test-Path $configPath) -or $Force

$copied = 0; $skipped = 0
foreach ($item in $payload) {
  $target = Join-Path $dest $item.Name
  if ((Test-Path $target) -and -not $Force) {
    Write-Host "  skip (exists): $($item.Name)" -ForegroundColor DarkYellow
    $skipped++
  } else {
    Copy-Item $item.FullName $target -Force
    Write-Host "  copied: $($item.Name)" -ForegroundColor Green
    $copied++
  }
}

if ($InstallSkill) {
  New-Item -ItemType Directory -Force -Path $claudeSkillDir | Out-Null
  if ((Test-Path $claudeSkillDest) -and -not $Force) {
    Write-Host "  skip (exists): .claude/skills/get-past-login/SKILL.md" -ForegroundColor DarkYellow
  } else {
    Copy-Item (Join-Path $scriptRoot 'get-past-login.SKILL.template.md') $claudeSkillDest -Force
    Write-Host "  copied: .claude/skills/get-past-login/SKILL.md (reads doorman.config.json)" -ForegroundColor Green
  }

  New-Item -ItemType Directory -Force -Path $codexSkillDir | Out-Null
  if ((Test-Path $codexSkillDest) -and -not $Force) {
    Write-Host "  skip (exists): .agents/skills/get-past-login/SKILL.md" -ForegroundColor DarkYellow
  } else {
    Copy-Item (Join-Path $scriptRoot 'get-past-login.codex.SKILL.template.md') $codexSkillDest -Force
    Write-Host "  copied: .agents/skills/get-past-login/SKILL.md (reads doorman.config.json)" -ForegroundColor Green
  }
}

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

# Fill in baseUrl from the project's own files, so the developer usually has nothing to edit.
# detect.mjs uses Node builtins only, so this runs before npm install. It is never fatal: when
# it finds nothing it writes "configured": false, which keeps every script stopping with
# instructions rather than testing the shipped placeholder URL.
if ($configIsNew) {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "`nDetecting the dev server URL from this project..." -ForegroundColor Cyan
    Push-Location $dest
    try {
      & node detect.mjs --write --root $Workspace
    } catch {
      Write-Host "  detection failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
    } finally { Pop-Location }
  } else {
    # No Node, so nothing can detect or guard. Mark it unconfigured by hand — inserting the line
    # rather than rewriting the file keeps this in step with config/doorman.config.example.json.
    Write-Host "`n  node not found, so the URL could not be detected." -ForegroundColor DarkYellow
    $configLines = @(Get-Content -Path $configPath)
    $configLines = @($configLines[0], '  "configured": false,') + $configLines[1..($configLines.Count - 1)]
    # -NoNewline + explicit LF joins: Set-Content would otherwise write CRLF and the file would
    # stop matching install.sh's output byte for byte.
    Set-Content -Path $configPath -Value (($configLines -join "`n") + "`n") -Encoding utf8NoBOM -NoNewline
    Write-Host "  marked $ToolsDir/doorman.config.json unconfigured — set baseUrl by hand." -ForegroundColor DarkYellow
  }
}

if ($Bootstrap) {
  Write-Host "`nBootstrapping (npm install + playwright chromium)..." -ForegroundColor Cyan
  Push-Location $dest
  try {
    & npm install
    & npx playwright install chromium
  } finally { Pop-Location }
}

Write-Host "`n✅ Installed to $dest  ($copied copied, $skipped skipped)" -ForegroundColor Cyan
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
