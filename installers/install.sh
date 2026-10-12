#!/usr/bin/env bash
# Install (or remove) the doorman toolkit in a target workspace (macOS / Linux / Git Bash).
#
# This is the vendored install: a self-contained copy committed to the project, for CI and for
# anyone not using the Claude Code or Codex plugin. Copies scripts/ (plus
# config/doorman.config.example.json) into <workspace>/<tools-dir> (default tools/doorman). Never
# copies per-developer artifacts (node_modules, storageState*.json, *.png). Existing files are
# skipped unless --force, so re-running won't clobber a customized doorman.config.json.
#
# Usage:
#   ./install.sh [--workspace PATH] [--tools-dir REL] [--install-skill] [--bootstrap] [--force]
#   ./install.sh [--workspace PATH] [--tools-dir REL] --uninstall
#
# --uninstall removes only what this installer added: the toolkit files, the CLAUDE.md and
# AGENTS.md sections, the skills, and any saved session (which holds live credentials). Anything
# else is left in place and reported.
#
# Examples:
#   ./install.sh --workspace ~/src/my-app --install-skill --bootstrap
#   cd ~/src/my-app && /path/to/doorman/installers/install.sh   # installs into the cwd
set -euo pipefail

workspace="$(pwd)"
tools_dir="tools/doorman"
install_skill=0
bootstrap=0
force=0
uninstall=0

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) workspace="$2"; shift 2 ;;
    --tools-dir) tools_dir="$2"; shift 2 ;;
    --install-skill) install_skill=1; shift ;;
    --bootstrap) bootstrap=1; shift ;;
    --force) force=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"      # installers/ — also where the
                                                                   # section/skill templates live
repo_root="$(cd "$script_root/.." && pwd)"
scripts_dir="$repo_root/scripts"   # the runtime, shared with both plugins
config_dir="$repo_root/config"     # the placeholder config this installer starts from
[ -d "$scripts_dir" ] || { echo "scripts/ not found next to installers/ ($scripts_dir)" >&2; exit 1; }
[ -d "$config_dir" ]  || { echo "config/ not found next to installers/ ($config_dir)" >&2; exit 1; }
[ -d "$workspace" ]   || { echo "Workspace not found: $workspace" >&2; exit 1; }

dest="$workspace/$tools_dir"
claude_path="$workspace/CLAUDE.md"
agents_path="$workspace/AGENTS.md"
section_start='<!-- doorman:start -->'
section_end='<!-- doorman:end -->'
claude_skill_dir="$workspace/.claude/skills/get-past-login"
claude_skill_dest="$claude_skill_dir/SKILL.md"
codex_skill_dir="$workspace/.agents/skills/get-past-login"
codex_skill_dest="$codex_skill_dir/SKILL.md"

# The payload: everything in scripts/ except per-developer artifacts, plus the placeholder config
# from config/ (the plugins have no use for it, so it doesn't live in scripts/). Enumerated rather
# than listed, so a new script is picked up automatically. This list doubles as the manifest for
# --uninstall, so it only ever removes what it installed.
payload_names=()
for src in "$scripts_dir"/* "$scripts_dir"/.gitignore; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  case "$name" in
    node_modules|storageState.json|sessionStorage.json|*.png) continue ;;
  esac
  payload_names+=("$name")
done
payload_names+=("doorman.config.json")

# Where each payload file comes from.
payload_src() {
  case "$1" in
    doorman.config.json) echo "$config_dir/doorman.config.example.json" ;;
    *) echo "$scripts_dir/$1" ;;
  esac
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

# Walk up from a directory removing it and its now-empty parents, never past the workspace.
# rmdir refuses to delete anything non-empty, so a directory with other content survives.
prune_empty_dirs() {
  local dir="$1"
  while [ "$dir" != "$workspace" ] && [ -d "$dir" ]; do
    rmdir "$dir" 2>/dev/null || break
    removed+=("${dir#"$workspace"/}/ (empty directory)")
    dir="$(dirname "$dir")"
  done
}

# 0 = section removed, 1 = no section present, 2 = the file held nothing else and was deleted.
remove_section() {
  local path="$1"
  [ -e "$path" ] || return 1
  grep -Fq "$section_start" "$path" || return 1
  grep -Fq "$section_end" "$path" || return 1
  local out
  out="$(mktemp "${path}.tmp.XXXXXX")"
  # Drop the marked block, squeeze the blank-line run it leaves, trim leading/trailing blanks.
  awk -v start="$section_start" -v end="$section_end" '
    $0 == start { skipping = 1; next }
    skipping && $0 == end { skipping = 0; next }
    !skipping { print }
  ' "$path" | cat -s | sed '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;};/\n$/ba' > "$out"
  if [ -s "$out" ]; then
    mv "$out" "$path"
    return 0
  fi
  rm -f "$out" "$path"
  return 2
}

if [ "$uninstall" -eq 1 ]; then
  removed=()
  left=()

  if [ -d "$dest" ]; then
    for name in "${payload_names[@]}"; do
      if [ -e "$dest/$name" ]; then
        rm -rf "$dest/$name"
        removed+=("$tools_dir/$name")
      fi
    done
    # Saved sessions are live credentials — removing the toolkit should not leave them behind.
    for pattern in 'storageState*.json' 'sessionStorage*.json' 'auth-check*.png' 'shot-*.png'; do
      while IFS= read -r found; do
        [ -n "$found" ] || continue
        rm -f "$found"
        removed+=("$tools_dir/$(basename "$found")")
      done < <(find "$dest" -maxdepth 1 -type f -name "$pattern" 2>/dev/null)
    done
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      left+=("$tools_dir/$(basename "$entry")")
    done < <(find "$dest" -mindepth 1 -maxdepth 1 2>/dev/null)
    if [ "${#left[@]}" -eq 0 ]; then
      prune_empty_dirs "$dest"
    fi
  fi

  if [ -e "$claude_skill_dest" ]; then
    rm -f "$claude_skill_dest"
    removed+=(".claude/skills/get-past-login/SKILL.md")
    prune_empty_dirs "$claude_skill_dir"
  fi
  if [ -e "$codex_skill_dest" ]; then
    rm -f "$codex_skill_dest"
    removed+=(".agents/skills/get-past-login/SKILL.md")
    prune_empty_dirs "$codex_skill_dir"
  fi

  claude_status=0
  remove_section "$claude_path" || claude_status=$?
  case "$claude_status" in
    0) removed+=("CLAUDE.md (doorman section only)") ;;
    2) removed+=("CLAUDE.md (contained nothing else)") ;;
  esac

  agents_status=0
  remove_section "$agents_path" || agents_status=$?
  case "$agents_status" in
    0) removed+=("AGENTS.md (doorman section only)") ;;
    2) removed+=("AGENTS.md (contained nothing else)") ;;
  esac

  if [ "${#removed[@]}" -eq 0 ]; then
    echo "Nothing to remove — no doorman toolkit found in $workspace"
    exit 0
  fi
  echo ""
  echo "Removed:"
  for line in "${removed[@]}"; do echo "  - $line"; done
  if [ "${#left[@]}" -gt 0 ]; then
    echo ""
    echo "Left in place (not installed by this script — delete manually if you want them gone):"
    for line in "${left[@]}"; do echo "  - $line"; done
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
mkdir -p "$dest"

# Whether this run creates the config, which decides if URL detection may write to it below.
config_path="$dest/doorman.config.json"
config_is_new=1
[ -e "$config_path" ] && [ "$force" -ne 1 ] && config_is_new=0

copy_one() {  # $1 = src file, $2 = dest file, $3 = label
  if [ -e "$2" ] && [ "$force" -ne 1 ]; then
    echo "  skip (exists): $3"
  else
    cp "$1" "$2"
    echo "  copied: $3"
  fi
}

for name in "${payload_names[@]}"; do
  copy_one "$(payload_src "$name")" "$dest/$name" "$name"
done

if [ "$install_skill" -eq 1 ]; then
  mkdir -p "$claude_skill_dir"
  copy_one "$script_root/get-past-login.SKILL.template.md" "$claude_skill_dest" ".claude/skills/get-past-login/SKILL.md (reads doorman.config.json)"
  mkdir -p "$codex_skill_dir"
  copy_one "$script_root/get-past-login.SKILL.template.md" "$codex_skill_dest" ".agents/skills/get-past-login/SKILL.md (reads doorman.config.json)"
fi

# CLAUDE.md/AGENTS.md are written last, so a failure above never leaves a workspace advertising a
# toolkit whose scripts didn't land. The text lives in installers/CLAUDE.section.md and
# installers/AGENTS.section.md so every installer emits identical instructions per file;
# {{TOOLS_DIR}} is the only substitution.
section_for() {  # $1 = template filename
  local template="$script_root/$1"
  [ -e "$template" ] || { echo "Missing $template" >&2; exit 1; }
  sed "s|{{TOOLS_DIR}}|$tools_dir|g" "$template"
}

update_instruction_file() {  # $1 = target path, $2 = section text, $3 = label (for error messages)
  local path="$1" section="$2" label="$3"
  if [ -e "$path" ]; then
    local has_start=0 has_end=0
    grep -Fq "$section_start" "$path" && has_start=1
    grep -Fq "$section_end" "$path" && has_end=1
    if [ "$has_start" -ne "$has_end" ]; then
      echo "$label contains an incomplete doorman instruction block. Restore or remove it before reinstalling." >&2
      exit 1
    fi

    if [ "$has_start" -eq 1 ]; then
      local section_tmp output_tmp
      section_tmp="$(mktemp)"
      output_tmp="$(mktemp "${path}.tmp.XXXXXX")"
      printf '%s\n' "$section" > "$section_tmp"
      if ! awk -v start="$section_start" -v end="$section_end" -v section="$section_tmp" '
        $0 == start {
          while ((getline line < section) > 0) print line
          close(section)
          skipping = 1
          next
        }
        skipping && $0 == end {
          skipping = 0
          next
        }
        !skipping { print }
      ' "$path" > "$output_tmp"; then
        rm -f "$section_tmp" "$output_tmp"
        exit 1
      fi
      if ! mv "$output_tmp" "$path"; then
        rm -f "$section_tmp" "$output_tmp"
        exit 1
      fi
      rm -f "$section_tmp"
    else
      printf '\n%s\n' "$section" >> "$path"
    fi
  else
    printf '%s\n' "$section" > "$path"
  fi
  echo "  updated: $label (doorman instructions)"
}
update_instruction_file "$claude_path" "$(section_for CLAUDE.section.md)" "CLAUDE.md"
update_instruction_file "$agents_path" "$(section_for AGENTS.section.md)" "AGENTS.md"

# Fill in baseUrl from the project's own files, so the developer usually has nothing to edit.
# detect.mjs uses Node builtins only, so this runs before npm install. It is never fatal: when
# it finds nothing it writes "configured": false, which keeps every script stopping with
# instructions rather than testing the shipped placeholder URL.
if [ "$config_is_new" -eq 1 ]; then
  echo ""
  if command -v node >/dev/null 2>&1; then
    echo "Detecting the dev server URL from this project..."
    ( cd "$dest" && node detect.mjs --write --root "$workspace" ) || true
  else
    # No Node, so nothing can detect or guard. Mark it unconfigured by hand — inserting the line
    # rather than rewriting the file keeps this in step with config/doorman.config.example.json.
    echo "  node not found, so the URL could not be detected."
    { echo '{'; echo '  "configured": false,'; tail -n +2 "$config_path"; } > "$config_path.tmp" \
      && mv "$config_path.tmp" "$config_path"
    echo "  marked $tools_dir/doorman.config.json unconfigured — set baseUrl by hand."
  fi
fi

if [ "$bootstrap" -eq 1 ]; then
  echo ""
  echo "Bootstrapping (npm install + playwright chromium)..."
  ( cd "$dest" && npm install && npx playwright install chromium )
fi

echo ""
echo "✅ Installed to $dest"
echo ""
echo "Next steps (or just ask your AI assistant to do them):"
echo "  1. Check  $tools_dir/doorman.config.json  — baseUrl was detected where possible; set"
echo "     loginPath, defaultCheckPath and ideally authenticatedSelector for this app."
echo "     (\"configured\": false in that file means detection found nothing.)"
[ "$bootstrap" -eq 1 ] || echo "  2. cd $tools_dir && npm install && npx playwright install chromium"
echo "  3. Start your app, then:  cd $tools_dir && node ensure.mjs"
echo "     (checks the session, and opens a sign-in window if one is needed)"
echo "  4. Screenshot:  node shot.mjs /some/route"
