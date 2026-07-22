#!/usr/bin/env bash
# Slot presets — sourced by the fan-out pane (never executed): each preset
# maps a short name to the argv one slot's agent runs (R2: fan-out is
# agent-agnostic).
#
# Config file: $HERDR_PLUGIN_CONFIG_DIR/presets.conf (fallback:
# ~/.config/herdr-swarm/presets.conf). One preset per line:
#
#   name|kind|args...
#
#   estimator|argv|claude --model opus
#   codex-fast|argv|codex --profile fast
#
# - `name` must survive sanitize_slug unchanged ([a-zA-Z0-9_-]): it becomes
#   part of branch names and worktree paths, an rm -rf-class surface.
# - `kind` is INERT. It was reserved for dispatching on herdr's integration
#   kind on 0.7.5, but that turned out to be a closed whitelist with no
#   arbitrary-argv member (spike l), so the 0.7.5 path builds slot topology
#   itself (lib.sh herdr_agent_start) and `args` is always argv. Any non-empty
#   value is accepted; the field stays so existing presets.conf keeps parsing.
# - `args` is the agent argv, split on whitespace at spawn time — no shell
#   quoting support (KISS v1); it may contain further `|` chars verbatim.
# - Blank lines and lines whose first non-space char is `#` are ignored.
#
# Missing file, or a file with no content lines, yields the two built-in
# defaults (claude → `claude`, codex → `codex`) so first run needs no setup.
#
# A malformed line fails the WHOLE catalog (return 1) instead of being
# skipped: silently dropping a preset would fan out the wrong agent.

# Idempotent lib load so callers only need to source this one file.
if ! type sanitize_slug >/dev/null 2>&1; then
	# shellcheck source=scripts/lib.sh
	. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fi

presets_file() {
	printf '%s/presets.conf\n' "${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr-swarm}"
}

# Effective config lines (comments/blanks stripped), or the built-in
# defaults when nothing usable is configured.
_presets_raw() {
	local f lines=""
	f="$(presets_file)"
	if [ -f "$f" ]; then
		# Two greps, not one alternation: \| in BRE is a GNU extension and
		# this must parse identically under BSD grep on macOS.
		lines="$(grep -v '^[[:space:]]*#' "$f" | grep -v '^[[:space:]]*$' || true)"
	fi
	if [ -n "$lines" ]; then
		printf '%s\n' "$lines"
	else
		printf 'claude|argv|claude\ncodex|argv|codex\n'
	fi
}

# _preset_split <line>: validate one config line, print "name<TAB>args".
_preset_split() {
	local line="$1" name kind args
	IFS='|' read -r name kind args <<<"$line"
	# Name must EQUAL its sanitized form — a cleaned-but-different name would
	# silently alias a hostile string into branch/worktree path components.
	if [ -z "$name" ] || [ "$name" != "$(sanitize_slug "$name" 2>/dev/null)" ]; then
		echo "herdr-swarm: preset name '$name' is invalid (allowed: a-z A-Z 0-9 _ -) in line: $line" >&2
		return 1
	fi
	if [ -z "$kind" ] || [ -z "$args" ]; then
		echo "herdr-swarm: malformed preset line (want name|kind|args...): $line" >&2
		return 1
	fi
	printf '%s\t%s\n' "$name" "$args"
}

# presets_list: one "name<TAB>argv" line per preset, config order. Fails
# loudly on the first malformed line (see file header for why not skip).
presets_list() {
	local line row out=""
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		row="$(_preset_split "$line")" || return 1
		out+="$row"$'\n'
	done < <(_presets_raw)
	printf '%s' "$out"
}

# preset_argv <name>: print the argv string for the named preset.
preset_argv() {
	local want="${1-}" name args
	# Same equality rule as config names: refuse, never silently sanitize —
	# "../evil" quietly becoming "evil" would pick a preset the user never
	# named.
	if [ -z "$want" ] || [ "$want" != "$(sanitize_slug "$want" 2>/dev/null)" ]; then
		echo "herdr-swarm: invalid preset name '${want}' (allowed: a-z A-Z 0-9 _ -)" >&2
		return 1
	fi
	while IFS=$'\t' read -r name args; do
		if [ "$name" = "$want" ]; then
			printf '%s\n' "$args"
			return 0
		fi
	done < <(presets_list)
	echo "herdr-swarm: unknown preset '$want' (available: $(presets_list 2>/dev/null | cut -f1 | tr '\n' ' '))" >&2
	return 1
}
