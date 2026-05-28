#!/usr/bin/env bash
# Memory server harness installer.
#
# Installs the hooks and skills that wire the MCP memory server into
# Claude Code's session lifecycle. Idempotent — existing files get
# timestamped backups before overwrite. Does NOT auto-edit settings.json,
# ~/.claude.json, or your CLAUDE.md — those merges are printed at the end.
#
# Configurable via environment variables:
#   CLAUDE_HOME       (default: $HOME/.claude)              user Claude Code dir
#   WORKSPACE_BASE    (default: $HOME/Claude)               parent of project dirs
#   AUDIT_STATE_DIR   (default: $HOME/.local/state/claude-memory-audit)
#                                                            watermark for /audit-memory
#
# Usage:
#   ./install.sh           # interactive — shows plan, asks to confirm
#   ./install.sh --yes     # non-interactive — proceeds without prompting
#   ./install.sh --dry-run # print what would be done, change nothing

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
WORKSPACE_BASE="${WORKSPACE_BASE:-$HOME/Claude}"
AUDIT_STATE_DIR="${AUDIT_STATE_DIR:-$HOME/.local/state/claude-memory-audit}"

# These were hardcoded into the hook scripts on the original installation.
# The installer rewrites occurrences of these in the copies before placing
# them under $CLAUDE_HOME/hooks/. The source files in harness/hooks/ are kept
# verbatim so they remain a faithful record of what's deployed.
SRC_CLAUDE_HOME="/home/dustin/.claude"
SRC_WORKSPACE_BASE="/home/dustin/Claude"
SRC_AUDIT_STATE_DIR="/home/dustin/.local/state/claude-memory-audit"

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
BACKUP_SUFFIX=".harness-bak.$(date +%Y%m%d-%H%M%S)"

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
	case "$arg" in
		--dry-run) DRY_RUN=1 ;;
		--yes|-y)  ASSUME_YES=1 ;;
		--help|-h)
			sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1
			exit 0
			;;
		*)
			echo "Unknown arg: $arg" >&2
			echo "Use --help for usage." >&2
			exit 2
			;;
	esac
done

# -----------------------------------------------------------------------------
# Output helpers
# -----------------------------------------------------------------------------

# Colors if stdout is a terminal.
if [[ -t 1 ]]; then
	C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_GREEN=$'\033[32m'
	C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_RED=$'\033[31m'; C_OFF=$'\033[0m'
else
	C_BOLD=''; C_DIM=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_RED=''; C_OFF=''
fi

say()    { printf '%s\n' "$*"; }
info()   { printf '%s%s%s\n' "$C_BLUE" "$*" "$C_OFF"; }
ok()     { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_OFF"; }
warn()   { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_OFF" >&2; }
err()    { printf '%s%s%s\n' "$C_RED" "$*" "$C_OFF" >&2; }
heading(){ printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_OFF"; }

# -----------------------------------------------------------------------------
# Dependency check
# -----------------------------------------------------------------------------

check_deps() {
	local missing=0
	for cmd in python3 bash sed; do
		if ! command -v "$cmd" >/dev/null 2>&1; then
			err "Missing required command: $cmd"
			missing=1
		fi
	done
	if ! command -v node >/dev/null 2>&1; then
		warn "node not found. The memory server itself requires Node.js to run."
		warn "(The harness install will succeed; you just won't be able to start the server.)"
	fi
	[[ $missing -eq 0 ]] || exit 1
}

# -----------------------------------------------------------------------------
# Pre-flight summary
# -----------------------------------------------------------------------------

show_plan() {
	heading "Memory harness installer"
	cat <<-EOF
	  ${C_DIM}Source (this repo):${C_OFF}       $HARNESS_DIR
	  ${C_DIM}Repo root:${C_OFF}                $REPO_ROOT

	  ${C_DIM}Will install into:${C_OFF}
	    ${C_BOLD}CLAUDE_HOME${C_OFF}      = $CLAUDE_HOME
	    ${C_BOLD}WORKSPACE_BASE${C_OFF}   = $WORKSPACE_BASE
	    ${C_BOLD}AUDIT_STATE_DIR${C_OFF}  = $AUDIT_STATE_DIR

	  ${C_DIM}Path substitutions applied to hook copies:${C_OFF}
	    $SRC_CLAUDE_HOME      →  $CLAUDE_HOME
	    $SRC_WORKSPACE_BASE       →  $WORKSPACE_BASE
	    $SRC_AUDIT_STATE_DIR  →  $AUDIT_STATE_DIR

	  ${C_DIM}Files to install:${C_OFF}
	    $(find "$HARNESS_DIR/hooks" -maxdepth 1 -type f | wc -l) hooks into $CLAUDE_HOME/hooks/
	    $(find "$HARNESS_DIR/skills" -mindepth 1 -maxdepth 1 -type d | wc -l) skills into $CLAUDE_HOME/skills/

	  ${C_DIM}Existing files will be backed up with suffix:${C_OFF}
	    $BACKUP_SUFFIX
	EOF

	if [[ $DRY_RUN -eq 1 ]]; then
		warn ""
		warn "DRY RUN — no files will be changed."
	fi
}

confirm() {
	if [[ $ASSUME_YES -eq 1 || $DRY_RUN -eq 1 ]]; then
		return 0
	fi
	printf '\nProceed? [y/N] '
	read -r reply
	case "$reply" in
		y|Y|yes|YES) return 0 ;;
		*) err "Aborted."; exit 1 ;;
	esac
}

# -----------------------------------------------------------------------------
# Install primitives
# -----------------------------------------------------------------------------

# Make sure a directory exists.
ensure_dir() {
	local dir="$1"
	if [[ $DRY_RUN -eq 1 ]]; then
		say "  ${C_DIM}[dry-run] mkdir -p $dir${C_OFF}"
		return
	fi
	mkdir -p "$dir"
}

# Back up an existing file before overwriting. Idempotent — re-runnable.
# Args: target path
backup_if_exists() {
	local target="$1"
	if [[ -e "$target" ]]; then
		local backup="${target}${BACKUP_SUFFIX}"
		if [[ $DRY_RUN -eq 1 ]]; then
			say "  ${C_DIM}[dry-run] mv $target $backup${C_OFF}"
		else
			mv "$target" "$backup"
			say "  ${C_DIM}backed up existing → $backup${C_OFF}"
		fi
	fi
}

# Install a single file. Substitutes the hardcoded source paths so the
# installed copy points at the user's $CLAUDE_HOME/$WORKSPACE_BASE.
# Args: source, target, executable-bit (0|1)
install_file_with_substitution() {
	local src="$1" target="$2" make_exec="$3"
	backup_if_exists "$target"
	if [[ $DRY_RUN -eq 1 ]]; then
		say "  ${C_DIM}[dry-run] sed-substitute $src → $target${C_OFF}"
		[[ "$make_exec" == "1" ]] && say "  ${C_DIM}[dry-run] chmod +x $target${C_OFF}"
		return
	fi
	# Order matters: do the longest paths first so substring matches don't
	# clobber each other. AUDIT_STATE_DIR shares a prefix with $HOME but not
	# with the others — and SRC_CLAUDE_HOME / SRC_WORKSPACE_BASE share the
	# /home/dustin/ prefix but are distinct.
	sed \
		-e "s|$SRC_AUDIT_STATE_DIR|$AUDIT_STATE_DIR|g" \
		-e "s|$SRC_WORKSPACE_BASE|$WORKSPACE_BASE|g" \
		-e "s|$SRC_CLAUDE_HOME|$CLAUDE_HOME|g" \
		"$src" > "$target"
	if [[ "$make_exec" == "1" ]]; then
		chmod +x "$target"
	fi
}

# Copy a file without any substitution (used for files we know contain no paths).
install_file_verbatim() {
	local src="$1" target="$2"
	backup_if_exists "$target"
	if [[ $DRY_RUN -eq 1 ]]; then
		say "  ${C_DIM}[dry-run] cp $src $target${C_OFF}"
		return
	fi
	cp "$src" "$target"
}

# -----------------------------------------------------------------------------
# Install steps
# -----------------------------------------------------------------------------

install_hooks() {
	heading "Installing hooks → $CLAUDE_HOME/hooks/"
	ensure_dir "$CLAUDE_HOME/hooks"
	local count=0
	for src in "$HARNESS_DIR"/hooks/*; do
		[[ -f "$src" ]] || continue
		local name target make_exec
		name="$(basename "$src")"
		target="$CLAUDE_HOME/hooks/$name"
		# Markdown prompt files (sessionend-prompt.md, precompact-prompt.md) and
		# the test file get the same substitution but no exec bit.
		case "$name" in
			*.py|*.sh) make_exec=1 ;;
			*)         make_exec=0 ;;
		esac
		install_file_with_substitution "$src" "$target" "$make_exec"
		say "  ${C_GREEN}✓${C_OFF} $name"
		count=$((count + 1))
	done
	ok "Installed $count hook files."
}

install_skills() {
	heading "Installing skills → $CLAUDE_HOME/skills/"
	ensure_dir "$CLAUDE_HOME/skills"
	local count=0
	for skill_dir in "$HARNESS_DIR"/skills/*/; do
		[[ -d "$skill_dir" ]] || continue
		local name target
		name="$(basename "$skill_dir")"
		target="$CLAUDE_HOME/skills/$name"
		ensure_dir "$target"
		# Each skill has at least SKILL.md; copy any files alongside it.
		for f in "$skill_dir"*; do
			[[ -f "$f" ]] || continue
			install_file_with_substitution "$f" "$target/$(basename "$f")" 0
		done
		say "  ${C_GREEN}✓${C_OFF} $name/"
		count=$((count + 1))
	done
	ok "Installed $count skills."
}

ensure_audit_state_dir() {
	heading "Ensuring audit state dir exists → $AUDIT_STATE_DIR"
	ensure_dir "$AUDIT_STATE_DIR"
	ok "Ready."
}

# -----------------------------------------------------------------------------
# Post-install reporting
# -----------------------------------------------------------------------------

check_server_build() {
	heading "Checking memory server build state"
	local dist="$REPO_ROOT/dist/index.js"
	if [[ -f "$dist" ]]; then
		ok "Found $dist — server is built."
	else
		warn "$dist not found."
		warn "Run from the repo root:"
		warn "    cd $REPO_ROOT && npm install && npm run build"
	fi
}

print_integration_steps() {
	heading "Next steps (manual integration)"

	cat <<-EOF

	The harness scripts are now in place. Three integrations remain that the
	installer deliberately does not perform automatically (they touch user-owned
	config where a blind merge could destroy unrelated entries):

	${C_BOLD}1. Register the MCP server in Claude Code${C_OFF}

	Run this once:

	    claude mcp remove memory 2>/dev/null || true
	    claude mcp add -s user memory \\
	      -e MEMORY_FILE_PATH=$CLAUDE_HOME/memory.db \\
	      -e MEMORY_INSTANCE_NAME=\$(hostname -s) \\
	      -- node $REPO_ROOT/dist/index.js

	Example registration to merge manually into ~/.claude.json:
	    $HARNESS_DIR/settings/mcp-registration.example.json

	${C_BOLD}2. Wire the hooks into Claude Code's lifecycle${C_OFF}

	Open ~/.claude/settings.json and merge the hooks block from:
	    $HARNESS_DIR/settings/settings.hooks.example.json

	Do NOT replace your existing 'hooks' object — append each event's hooks
	array. If you already have SessionStart entries, add the load-l0-context
	and check-memory-freshness commands alongside them.

	${C_BOLD}3. Add the Session Protocol to your CLAUDE.md${C_OFF}

	Append the contents of this file to your ~/Claude/CLAUDE.md (or wherever
	your top-level CLAUDE.md lives) so the agent knows to rely on the harness:

	    $HARNESS_DIR/claude-md/session-protocol.md

	${C_BOLD}4. (Optional) Build the server if you haven't yet${C_OFF}

	    cd $REPO_ROOT && npm install && npm run build

	${C_BOLD}5. Restart Claude Code${C_OFF}

	After restart, verify the harness is firing:
	  - First system reminder should contain '# MEMORY (chunk 0 of N, ...)'
	  - sqlite3 $CLAUDE_HOME/memory.db "SELECT version FROM schema_version;"
	    should return version >= 9

	EOF
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
	check_deps
	show_plan
	confirm

	install_hooks
	install_skills
	ensure_audit_state_dir

	check_server_build
	print_integration_steps

	heading "Done."
	if [[ $DRY_RUN -eq 1 ]]; then
		warn "(Dry run — nothing was actually changed.)"
	fi
}

main "$@"
