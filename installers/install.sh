#!/usr/bin/env bash
# Install (or remove) the doorman toolkit in a target workspace (macOS / Linux / Git Bash).
#
# This is the vendored install: a self-contained copy committed to the project, for CI and for
# anyone not using the Claude Code or Codex plugin. Copies scripts/ (plus
# config/doorman.config.example.json) into <workspace>/<tools-dir> (default tools/doorman). Never
# copies per-developer artifacts (node_modules, storageState*.json, *.png). Existing files are
# skipped unless --force.
#
# doorman.config.json is yours, not the installer's: it is created once (by detect.mjs, which fills
# in baseUrl) and never overwritten after that — not even by --force. An upgrade checks it and
# reports problems instead. --reset-config replaces it, keeping the old one as a timestamped .bak.
#
# Usage:
#   ./install.sh [--workspace PATH] [--tools-dir REL] [--install-skill] [--bootstrap] [--force]
#                [--reset-config]
#   ./install.sh [--workspace PATH] [--tools-dir REL] --uninstall
#
# Every file it writes is recorded, with its SHA-256, in <workspace>/.doorman/install-manifest.json
# (the receipt; commit it with the toolkit). A re-run updates the files it installed and that nobody
# has changed since; a file someone changed, or one doorman didn't put there, is skipped unless
# --force — and --force keeps a .bak of anything it overwrites that doorman didn't write.
#
# --uninstall removes only what the receipt lists, and only where the file is still exactly as
# installed (a changed file is kept and reported; a file --force replaced gets its original back),
# plus the CLAUDE.md and AGENTS.md sections and any saved session (which holds live credentials).
# Directories go only once empty. Without a receipt it removes nothing.
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
reset_config=0
uninstall=0

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) workspace="$2"; shift 2 ;;
    --tools-dir) tools_dir="$2"; shift 2 ;;
    --install-skill) install_skill=1; shift ;;
    --bootstrap) bootstrap=1; shift ;;
    --force) force=1; shift ;;
    --reset-config) reset_config=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# Normalized, because it is also the prefix of every path in the receipt.
tools_dir="${tools_dir#./}"
tools_dir="${tools_dir%/}"

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

# The payload — the files the installer manages: everything in scripts/ except per-developer
# artifacts, plus the example config from config/ (the plugins have no use for it, so it doesn't
# live in scripts/). Enumerated rather than listed, so a new script is picked up automatically.
# doorman.config.json is deliberately not in it: that file is the developer's (see below).
payload_names=()
for src in "$scripts_dir"/* "$scripts_dir"/.gitignore; do
  [ -e "$src" ] || continue
  name="${src##*/}"
  case "$name" in
    node_modules|storageState*.json|sessionStorage*.json|*.png|doorman.config.json) continue ;;
  esac
  payload_names+=("$name")
done
payload_names+=("doorman.config.example.json")

config_name="doorman.config.json"
config_path="$dest/$config_name"

# ---------------------------------------------------------------------------
# The receipt: what the installer wrote, so a re-run and --uninstall can tell its files from yours
# ---------------------------------------------------------------------------
# One entry per line, in a fixed layout, so it can be read back without jq. install.ps1 writes the
# identical layout, so either installer can update or remove what the other installed.
receipt_dir="$workspace/.doorman"
receipt="$receipt_dir/install-manifest.json"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$repo_root/.claude-plugin/plugin.json" | head -n 1)"
[ -n "$version" ] || version="unknown"
stamp="$(date +%Y%m%d-%H%M%S)"

if command -v sha256sum >/dev/null 2>&1; then hasher=(sha256sum); else hasher=(shasum -a 256); fi

# Hash files into HASHES (in argument order). Carriage returns are ignored, so a checkout that
# converts line endings (core.autocrlf) still counts as unchanged. Every process start is slow on
# Git Bash, so the whole batch costs a handful of them however many files there are: the files
# containing a CR are copied CR-free by one awk (RS='\r' with ORS='' drops exactly the CRs) and
# hashed together.
hash_files() {
  HASHES=()
  [ "$#" -gt 0 ] || return 0
  local with_cr=() f h rest i=0 n=0 tmp
  while IFS= read -r f; do with_cr+=("$f"); done < <(grep -lU $'\r' "$@" 2>/dev/null || true)
  while read -r h rest; do HASHES+=("${h#\\}"); done < <("${hasher[@]}" "$@")
  [ "${#with_cr[@]}" -gt 0 ] || return 0
  tmp="$(mktemp -d)"
  awk -v RS='\r' -v ORS='' -v dir="$tmp" \
    'FNR == 1 { if (out) close(out); out = sprintf("%s/%06d", dir, ++n) } { print > out }' "${with_cr[@]}"
  local stripped=()
  while read -r h rest; do stripped+=("${h#\\}"); done < <("${hasher[@]}" "$tmp"/*)
  rm -rf "$tmp"
  for f in "$@"; do
    case " ${with_cr[*]} " in
      *" $f "*)
        # with_cr is in argument order (grep reports files in the order given), so the next
        # stripped hash belongs to this file.
        HASHES[$i]="${stripped[$n]}"; n=$((n + 1)) ;;
    esac
    i=$((i + 1))
  done
}

# Parallel arrays rather than an associative one: macOS still ships bash 3.2.
r_paths=(); r_hashes=(); r_actions=(); r_versions=(); r_backups=()

load_receipt() {
  [ -f "$receipt" ] || return 1
  local p h a v b
  # One sed for the whole file: each entry line becomes path|sha256|action|version|backup.
  while IFS='|' read -r p h a v b; do
    r_paths+=("$p"); r_hashes+=("$h"); r_actions+=("$a"); r_versions+=("$v"); r_backups+=("${b%$'\r'}")
  done < <(sed -n 's/.*"path": *"\([^"]*\)", *"sha256": *"\([^"]*\)", *"action": *"\([^"]*\)", *"version": *"\([^"]*\)", *"backup": *"\([^"]*\)".*/\1|\2|\3|\4|\5/p' "$receipt")
}

# Sets entry_index to the receipt index of $1, or -1. (A variable, not output: no subshell.)
find_entry() {
  local i=0
  entry_index=-1
  while [ "$i" -lt "${#r_paths[@]}" ]; do
    if [ "${r_paths[$i]}" = "$1" ]; then entry_index=$i; return 0; fi
    i=$((i + 1))
  done
  return 1
}

record() {  # $1 = path, $2 = sha256, $3 = action, $4 = backup (or "")
  if find_entry "$1"; then
    r_hashes[$entry_index]="$2"; r_actions[$entry_index]="$3"; r_versions[$entry_index]="$version"
    r_backups[$entry_index]="$4"
  else
    r_paths+=("$1"); r_hashes+=("$2"); r_actions+=("$3"); r_versions+=("$version"); r_backups+=("$4")
  fi
}

write_receipt() {
  mkdir -p "$receipt_dir"
  local i=0 tab
  tab="$(printf '\t')"
  {
    echo '{'
    echo '  "about": "Written by the doorman installer: the files it installed, so a re-run and --uninstall touch only those. Commit it; do not edit it.",'
    printf '  "toolsDir": "%s",\n' "$tools_dir"
    echo '  "files": ['
    # Sorted by path, in byte order, so the file is the same whichever installer wrote it.
    while [ "$i" -lt "${#r_paths[@]}" ]; do
      printf '%s\t    {"path": "%s", "sha256": "%s", "action": "%s", "version": "%s", "backup": "%s"}\n' \
        "${r_paths[$i]}" "${r_paths[$i]}" "${r_hashes[$i]}" "${r_actions[$i]}" "${r_versions[$i]}" "${r_backups[$i]}"
      i=$((i + 1))
    done | LC_ALL=C sort -t "$tab" -k1,1 | cut -f2- | sed '$!s/$/,/'
    echo '  ]'
    echo '}'
  } > "$receipt.tmp"
  mv "$receipt.tmp" "$receipt"
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
  kept=()
  left=()

  if ! load_receipt; then
    if [ -e "$dest" ] || [ -e "$claude_skill_dest" ] || [ -e "$codex_skill_dest" ]; then
      echo "No install receipt at .doorman/install-manifest.json, so nothing here can be shown to be" >&2
      echo "doorman's — and nothing was removed. (Copies installed before 0.2.0 have no receipt.)" >&2
      echo "Re-run the installer with --force to adopt this copy, then uninstall; or delete $tools_dir" >&2
      echo "and the doorman section of CLAUDE.md and AGENTS.md yourself." >&2
      exit 1
    fi
    echo "Nothing to remove — no doorman toolkit found in $workspace"
    exit 0
  fi
  receipt_tools="$(sed -n 's/.*"toolsDir": *"\([^"]*\)".*/\1/p' "$receipt" | head -n 1)"
  receipt_tools="${receipt_tools:-$tools_dir}"

  present=()
  for rel in ${r_paths[@]+"${r_paths[@]}"}; do [ -e "$workspace/$rel" ] && present+=("$workspace/$rel"); done
  hash_files ${present[@]+"${present[@]}"}
  j=0
  for target in ${present[@]+"${present[@]}"}; do
    current="${HASHES[$j]}"; j=$((j + 1))
    rel="${target#"$workspace"/}"
    find_entry "$rel"
    backup="${r_backups[$entry_index]}"
    if [ "$current" != "${r_hashes[$entry_index]}" ]; then
      kept+=("$rel")
      continue
    fi
    rm -f "$target"
    if [ -n "$backup" ] && [ -e "$workspace/$backup" ]; then
      mv "$workspace/$backup" "$target"
      removed+=("$rel (put back the version that was there before)")
    else
      removed+=("$rel")
      prune_empty_dirs "${target%/*}"
    fi
  done

  # Saved sessions are live credentials — removing the toolkit should not leave them behind.
  session_dir="$workspace/$receipt_tools"
  for pattern in 'storageState*.json' 'sessionStorage*.json' 'auth-check*.png' 'shot-*.png' '.*.tmp'; do
    while IFS= read -r found; do
      [ -n "$found" ] || continue
      rm -f "$found"
      removed+=("$receipt_tools/${found##*/}")
    done < <(find "$session_dir" -maxdepth 1 -type f -name "$pattern" 2>/dev/null)
  done

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

  # Whatever is still in the toolkit folder, other than the files kept above, wasn't installed here.
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    rel="$receipt_tools/${entry##*/}"
    case " ${kept[*]-} " in *" $rel "*) continue ;; esac
    left+=("$rel")
  done < <(find "$session_dir" -mindepth 1 -maxdepth 1 2>/dev/null)
  prune_empty_dirs "$session_dir"

  # The receipt goes last, so an interrupted uninstall can simply be run again.
  rm -f "$receipt"
  prune_empty_dirs "$receipt_dir"

  echo ""
  echo "Removed:"
  for line in ${removed[@]+"${removed[@]}"}; do echo "  - $line"; done
  [ "${#removed[@]}" -gt 0 ] || echo "  (nothing)"
  if [ "${#kept[@]}" -gt 0 ]; then
    echo ""
    echo "Kept — changed since doorman installed them, so they may hold your work (delete them if not):"
    for line in "${kept[@]}"; do echo "  - $line"; done
  fi
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
load_receipt || true
unchanged=0

# What to install: source -> destination (workspace-relative).
sources=(); targets=()
for name in "${payload_names[@]}"; do
  case "$name" in
    doorman.config.example.json) sources+=("$config_dir/$name") ;;
    *) sources+=("$scripts_dir/$name") ;;
  esac
  targets+=("$tools_dir/$name")
done
if [ "$install_skill" -eq 1 ]; then
  sources+=("$script_root/get-past-login.SKILL.template.md" "$script_root/get-past-login.SKILL.template.md")
  targets+=(".claude/skills/get-past-login/SKILL.md" ".agents/skills/get-past-login/SKILL.md")
fi
hash_files "${sources[@]}"; source_hashes=("${HASHES[@]}")
existing=()
for rel in "${targets[@]}"; do [ -e "$workspace/$rel" ] && existing+=("$workspace/$rel"); done
hash_files ${existing[@]+"${existing[@]}"}; existing_hashes=(${HASHES[@]+"${HASHES[@]}"})

current_hash_of() {  # sets current_hash for an existing workspace file, from the batch above
  local i=0
  current_hash=""
  while [ "$i" -lt "${#existing[@]}" ]; do
    if [ "${existing[$i]}" = "$1" ]; then current_hash="${existing_hashes[$i]}"; return; fi
    i=$((i + 1))
  done
}

# Install one managed file, deciding from the receipt whether whatever is already there is ours.
install_file() {  # $1 = source, $2 = destination relative to the workspace, $3 = the source's hash
  local src="$1" rel="$2" new_hash="$3" target="$workspace/$2" backup
  if [ ! -e "$target" ]; then
    [ -d "${target%/*}" ] || mkdir -p "${target%/*}"
    cp "$src" "$target"
    record "$rel" "$new_hash" created ""
    echo "  copied: $rel"
    return
  fi
  current_hash_of "$target"
  find_entry "$rel" || true
  if [ "$current_hash" = "$new_hash" ] && [ "$entry_index" -ge 0 ]; then
    # Ours, and already exactly this version.
    record "$rel" "$new_hash" "${r_actions[$entry_index]}" "${r_backups[$entry_index]}"
    unchanged=$((unchanged + 1))
    return
  fi
  if [ "$current_hash" = "$new_hash" ]; then
    # The same content, but not recorded as ours (a copy from before 0.2.0, or someone's own).
    # Claiming it would let an uninstall delete it, so that takes --force like any other file.
    if [ "$force" -ne 1 ]; then
      echo "  skip (identical, but not installed by doorman — --force adopts it): $rel"
      return
    fi
    record "$rel" "$new_hash" adopted ""
    echo "  adopted: $rel"
    return
  fi
  if [ "$entry_index" -ge 0 ] && [ "$current_hash" = "${r_hashes[$entry_index]}" ]; then
    # Ours, and nobody has touched it since: safe to update.
    cp "$src" "$target"
    record "$rel" "$new_hash" updated "${r_backups[$entry_index]}"
    echo "  updated: $rel"
    return
  fi
  if [ "$force" -ne 1 ]; then
    if [ "$entry_index" -ge 0 ]; then echo "  skip (changed since installed — --force replaces it, keeping a .bak): $rel"
    else echo "  skip (exists, not installed by doorman — --force replaces it, keeping a .bak): $rel"; fi
    return
  fi
  # Overwriting content doorman didn't write: keep it beside the new file first.
  backup="$rel.$stamp.bak"
  cp "$target" "$workspace/$backup"
  cp "$src" "$target"
  record "$rel" "$new_hash" replaced "$backup"
  echo "  replaced: $rel (the previous file is kept as ${backup##*/})"
}

i=0
while [ "$i" -lt "${#sources[@]}" ]; do
  install_file "${sources[$i]}" "${targets[$i]}" "${source_hashes[$i]}"
  i=$((i + 1))
done
[ "$unchanged" -eq 0 ] || echo "  up to date: $unchanged file(s)"

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

# The config. It belongs to the developer, so an existing one is only ever checked, never written —
# --force included. --reset-config is the one way to replace it, and keeps the old one beside it.
echo ""
if [ "$reset_config" -eq 1 ] && [ -e "$config_path" ]; then
  backup="$config_path.$(date +%Y%m%d-%H%M%S).bak"
  mv "$config_path" "$backup"
  echo "  backed up: $tools_dir/$config_name -> $(basename "$backup")"
fi
have_node=0
command -v node >/dev/null 2>&1 && have_node=1
config_created=0
if [ -e "$config_path" ]; then
  echo "Keeping your $tools_dir/$config_name (installs never change it; --reset-config replaces it)."
  if [ "$have_node" -eq 1 ]; then
    ( cd "$dest" && node check-config.mjs ) \
      || echo "  Left as it is — fix the above in $tools_dir/$config_name. New settings are in $config_name's example beside it."
  fi
else
  # Created by detect.mjs, which fills in baseUrl from the project's own files (and starts from the
  # plugin's config when the project has one). Node builtins only, so this runs before npm install.
  # It is never fatal: when it finds nothing it writes "configured": false, which keeps every
  # script stopping with instructions rather than testing the placeholder URL.
  if [ "$have_node" -eq 1 ]; then
    echo "Creating $tools_dir/$config_name — detecting the dev server URL from this project..."
    ( cd "$dest" && node detect.mjs --write --root "$workspace" ) || true
  fi
  if [ ! -e "$config_path" ]; then
    # No Node (or detection failed), so nothing can detect or guard. Start from the example, marked
    # unconfigured — inserting the line rather than rewriting keeps it in step with the example.
    [ "$have_node" -eq 1 ] || echo "  node not found, so the URL could not be detected."
    { echo '{'; echo '  "configured": false,'; tail -n +2 "$config_dir/doorman.config.example.json"; } > "$config_path"
    echo "  created $tools_dir/$config_name from the example, marked unconfigured — set baseUrl by hand."
  fi
  config_created=1
fi

# Recorded as created, so an uninstall removes it only if it was never edited — which, for a config
# someone has actually used, means it is kept.
if [ "$config_created" -eq 1 ] && [ -e "$config_path" ]; then
  hash_files "$config_path"
  record "$tools_dir/$config_name" "${HASHES[0]}" created ""
fi
write_receipt

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
