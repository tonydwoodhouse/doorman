#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Install (or remove) the doorman toolkit in a target workspace.

.DESCRIPTION
  This is the vendored install: a self-contained copy committed to the project, for CI and for
  anyone not using the Claude Code plugin. Copies scripts/ (plus installer/doorman.config.json)
  into <Workspace>/<ToolsDir> (default tools/doorman). Never copies per-developer artifacts
  (node_modules, storageState*.json, *.png). Existing files are skipped unless -Force is given,
  so re-running is safe and won't clobber a customized doorman.config.json.

.PARAMETER Workspace
  Path to the target repo root. Defaults to the current directory.

.PARAMETER ToolsDir
  Where to place the toolkit, relative to the workspace. Default: tools/doorman

.PARAMETER InstallSkill
  Also copy the Claude Code skill template to <Workspace>/.claude/skills/get-past-login/SKILL.md
  (the skill reads the workspace's doorman.config.json when it runs).

.PARAMETER Bootstrap
  After copying, run `npm install` and `npx playwright install chromium` in the toolkit folder.

.PARAMETER Force
  Overwrite files that already exist in the target.

.PARAMETER Uninstall
  Remove what this installer added: the toolkit files, the CLAUDE.md section, the skill, and any
  saved session (which holds live credentials). Files it did not install are left in place and
  reported. Nothing else in the workspace is touched.

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
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptsDir = Join-Path $scriptRoot 'scripts'      # the runtime, shared with the plugin
$installerDir = Join-Path $scriptRoot 'installer'  # inputs only this installer uses

if (-not (Test-Path $scriptsDir))   { throw "scripts/ not found next to install.ps1 ($scriptsDir)" }
if (-not (Test-Path $installerDir)) { throw "installer/ not found next to install.ps1 ($installerDir)" }
if (-not (Test-Path $Workspace))    { throw "Workspace not found: $Workspace" }

$dest = Join-Path $Workspace $ToolsDir
$claudePath = Join-Path $Workspace 'CLAUDE.md'
$claudeSectionStart = '<!-- doorman:start -->'
$claudeSectionEnd = '<!-- doorman:end -->'
$skillDir = Join-Path $Workspace '.claude/skills/get-past-login'
$skillDest = Join-Path $skillDir 'SKILL.md'

# The payload: everything in scripts/ except per-developer artifacts, plus the placeholder config
# from installer/ (the plugin has no use for it, so it doesn't live in scripts/). Enumerated rather
# than listed, so a new script is picked up automatically. This list doubles as the manifest for
# -Uninstall, so it only ever removes what it installed.
$skip = @('node_modules', 'storageState.json', 'sessionStorage.json')
$payload = @(
  Get-ChildItem -Path $scriptsDir -Force |
    Where-Object { $skip -notcontains $_.Name -and $_.Name -notlike '*.png' } |
    ForEach-Object { [pscustomobject]@{ Name = $_.Name; FullName = $_.FullName } }
) + [pscustomobject]@{ Name = 'doorman.config.json'; FullName = (Join-Path $installerDir 'doorman.config.json') }

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

  if (Test-Path $skillDest) {
    Remove-Item $skillDest -Force
    $removed.Add('.claude/skills/get-past-login/SKILL.md')
    Remove-EmptyDirs $skillDir
  }

  if (Test-Path $claudePath) {
    $claudeContent = Get-Content -Raw -Path $claudePath
    if ($claudeContent.Contains($claudeSectionStart) -and $claudeContent.Contains($claudeSectionEnd)) {
      $pattern = "(?s)$([regex]::Escape($claudeSectionStart)).*?$([regex]::Escape($claudeSectionEnd))"
      $stripped = [regex]::Replace($claudeContent, $pattern, '')
      $stripped = ($stripped -replace "(\r?\n){3,}", "`n`n").Trim()
      if ($stripped.Length -eq 0) {
        Remove-Item $claudePath -Force
        $removed.Add('CLAUDE.md (contained nothing else)')
      } else {
        # -NoNewline: the trailing newline is explicit, so this matches install.sh byte for byte
        # instead of letting Set-Content append a second one.
        Set-Content -Path $claudePath -Value ($stripped + "`n") -Encoding utf8NoBOM -NoNewline
        $removed.Add('CLAUDE.md (doorman section only)')
      }
    }
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

# The agent instructions live in installer/CLAUDE.section.md so both installers emit identical
# text; {{TOOLS_DIR}} is the only substitution.
$sectionTemplate = Join-Path $installerDir 'CLAUDE.section.md'
if (-not (Test-Path $sectionTemplate)) { throw "Missing $sectionTemplate" }
$claudeSection = ((Get-Content -Raw -Path $sectionTemplate) -replace '\{\{TOOLS_DIR\}\}', $ToolsDir).TrimEnd()

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
  $skillSrc = Join-Path $installerDir 'get-past-login.SKILL.template.md'
  New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
  if ((Test-Path $skillDest) -and -not $Force) {
    Write-Host "  skip (exists): .claude/skills/get-past-login/SKILL.md" -ForegroundColor DarkYellow
  } else {
    Copy-Item $skillSrc $skillDest -Force
    Write-Host "  copied: .claude/skills/get-past-login/SKILL.md (reads doorman.config.json)" -ForegroundColor Green
  }
}

# CLAUDE.md is written last, so a failure above never leaves a workspace advertising a toolkit
# whose scripts didn't land.
if (Test-Path $claudePath) {
  $claudeContent = Get-Content -Raw -Path $claudePath
  $hasStart = $claudeContent.Contains($claudeSectionStart)
  $hasEnd = $claudeContent.Contains($claudeSectionEnd)
  if ($hasStart -xor $hasEnd) {
    throw "CLAUDE.md contains an incomplete doorman instruction block. Restore or remove it before reinstalling."
  }

  if ($hasStart) {
    $pattern = "(?s)$([regex]::Escape($claudeSectionStart)).*?$([regex]::Escape($claudeSectionEnd))"
    $updatedClaudeContent = [regex]::Replace($claudeContent, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $claudeSection })
  } else {
    $updatedClaudeContent = $claudeContent.TrimEnd() + "`n`n" + $claudeSection + "`n"
  }
} else {
  $updatedClaudeContent = $claudeSection + "`n"
}

# -NoNewline: the content above already ends with exactly one newline. Without it Set-Content
# appends a second, and the file stops matching install.sh's output byte for byte.
Set-Content -Path $claudePath -Value $updatedClaudeContent -Encoding utf8NoBOM -NoNewline
Write-Host "  updated: CLAUDE.md (doorman instructions)" -ForegroundColor Green

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
    # rather than rewriting the file keeps this in step with installer/doorman.config.json.
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

Next steps (or just ask Claude to do them):
  1. Check  $ToolsDir/doorman.config.json  — baseUrl was detected where possible; set
     loginPath, defaultCheckPath and ideally authenticatedSelector for this app.
     ("configured": false in that file means detection found nothing.)
$(if (-not $Bootstrap) { "  2. cd $ToolsDir && npm install && npx playwright install chromium" })
  3. Start your app, then:  cd $ToolsDir && node ensure.mjs
     (checks the session, and opens a sign-in window if one is needed)
  4. Screenshot:  node shot.mjs /some/route
"@
