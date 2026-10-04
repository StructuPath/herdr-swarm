#!/usr/bin/env bash
# harvest-step-broadcast.sh — broadcast: type one message into every targeted slot's agent.
#
# Sourced by harvest-step.sh, the one entry point; not run on its own. The
# globals used here (RUN_ID, REPO_ROOT, DOC, SLOT_*, HS_EC_*, …) are set there.
# shellcheck disable=SC2154,SC2153

# broadcast: type one message into every targeted slot's agent and submit it.
# The message comes from HERDR_SWARM_MESSAGE_FILE or HERDR_SWARM_MESSAGE and
# must be ONE line of printable text: a newline inside send-text arrives as a
# real line break (live-verified), so a TUI agent would submit half of it, and
# control characters are keystrokes (Ctrl-C, escape sequences), not text.
# Targets: HERDR_SWARM_TARGETS=1,3 or, by default, every running slot.
#
# Typing into the wrong program could RUN the message — a shell executes it,
# `less` runs `!…`, vim reads it as commands, an approval dialog takes it as
# option keys and Enter as "yes". So a slot receives it only when, checked
# right before typing:
#   1. its pane still holds the slot's own terminal (result.pane.terminal_id);
#   2. Herdr does not report the agent `blocked` (waiting on the user);
#   3. the foreground process GROUP LEADER is the slot's own agent program
#      (agent_command, recorded at fan-out) — not the shell, and not anything
#      the user or the agent started in the pane;
#   4. it has not finished by exiting (the shell owns that pane again).
# The program is checked again between typing and Enter; if it changed, Enter
# is withheld (text left unsent is inert). Records: broadcast_sent<TAB>slot,
# broadcast_skipped<TAB>slot<TAB>why, broadcast_partial<TAB>slot<TAB>why
# (typed but not submitted). Exits 36 unless every target was sent.
do_broadcast() {
	local msg rows s want_cmd finished got term status fg sent=0 failed=0
	# Validated in node, not with [[:cntrl:]]: that class depends on the
	# caller's locale (under LC_ALL=C it passes C1 controls like U+009B CSI).
	msg="$(HERDR_SWARM_MESSAGE="${HERDR_SWARM_MESSAGE:-}" node -e '
		const fs = require("fs");
		const file = process.argv[1];
		const fail = (why) => { console.error("herdr-swarm: " + why); process.exit(1); };
		let msg;
		if (file) {
			let bytes;
			try { bytes = fs.readFileSync(file); } catch { fail("HERDR_SWARM_MESSAGE_FILE \x27" + file + "\x27 is not a readable file."); }
			try { msg = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("broadcast message file is not valid UTF-8."); }
			msg = msg.replace(/\r?\n$/, "");
		} else msg = process.env.HERDR_SWARM_MESSAGE;
		if (!msg || !msg.trim()) fail("broadcast needs a message — set HERDR_SWARM_MESSAGE or HERDR_SWARM_MESSAGE_FILE.");
		const banned = (c) => c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x200e || c === 0x200f || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff || c === 0xfffd;
		if ([...msg].some((ch) => banned(ch.codePointAt(0))))
			fail("broadcast message must be one line of plain text (no newlines, tabs, control or direction-override characters) — an agent would receive a newline as \x27submit\x27.");
		if (msg.startsWith("-")) fail("broadcast message must not start with \x27-\x27 — the Herdr CLI would parse it as a flag; rephrase the start.");
		if ([...msg].length > 4000) fail("broadcast message is over 4000 characters — put longer instructions in a file and tell the agents to read it.");
		process.stdout.write(msg);
	' "${HERDR_SWARM_MESSAGE_FILE:-}")" || return "$HS_EC_REFUSED"
	rows="$(printf '%s' "$DOC" | node -e '
		const want = process.argv[1];
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const slots = JSON.parse(d).slots || [];
			const row = (n) => slots.find((r) => String(r.slot) === n);
			const line = (n) => {
				const r = row(n);
				console.log([n, r?.agent_command || "-", r?.finished?.reason || "-"].join("\t"));
			};
			if (!want) { for (const r of slots) if (r.status === "running") line(String(r.slot)); return; }
			const seen = new Set();
			for (const t of want.split(",")) {
				const n = t.trim();
				if (!/^[1-9][0-9]*$/.test(n)) { console.error("herdr-swarm: HERDR_SWARM_TARGETS entry \x27" + n + "\x27 is not a slot number"); process.exit(1); }
				// A repeat would type the same instruction into one agent twice.
				if (seen.has(n)) { console.error("herdr-swarm: HERDR_SWARM_TARGETS names slot " + n + " twice"); process.exit(1); }
				seen.add(n);
			}
			for (const n of seen) line(n);
		});
	' "${HERDR_SWARM_TARGETS:-}")" || return "$HS_EC_REFUSED"
	while IFS=$'\t' read -r s want_cmd finished; do
		[ -n "$s" ] || continue
		if ! read_slot "$s" 2>/dev/null; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "not a slot of this run, or its ownership check failed"
			failed=$((failed + 1))
			continue
		fi
		if [ "$SLOT_STATUS" != running ]; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "slot is '$SLOT_STATUS'"
			failed=$((failed + 1))
			continue
		fi
		if [ "$finished" = exited ]; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "its agent exited — the pane belongs to the shell again"
			failed=$((failed + 1))
			continue
		fi
		if [ -z "$SLOT_PANE" ] || [ -z "$SLOT_TERMINAL" ] || [ "$want_cmd" = "-" ]; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "no recorded pane, terminal, or agent program (a run started before broadcast existed)"
			failed=$((failed + 1))
			continue
		fi
		got="$(herdr_pane_get "$SLOT_PANE" 2>/dev/null)" || got=""
		IFS=$'\t' read -r term status <<<"$(printf '%s' "$got" | node -e '
			let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
				let p; try { p = JSON.parse(d).result.pane; } catch {}
				process.stdout.write([p?.terminal_id ?? "", p?.agent_status ?? ""].join("\t"));
			});' 2>/dev/null)"
		if [ "$term" != "$SLOT_TERMINAL" ]; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "its pane no longer holds this slot's terminal"
			failed=$((failed + 1))
			continue
		fi
		if [ "$status" = blocked ]; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "the agent is blocked waiting on you — keystrokes would answer its prompt"
			failed=$((failed + 1))
			continue
		fi
		fg="$(pane_foreground_program "$SLOT_PANE")"
		if ! _foreground_is "$fg" "$want_cmd"; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "the foreground is not its agent '$want_cmd' ($(_foreground_label "$fg"))"
			failed=$((failed + 1))
			continue
		fi
		if ! herdr_pane_send_text "$SLOT_PANE" "$msg" >/dev/null 2>&1; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "typing was refused (send-text failed)"
			failed=$((failed + 1))
			continue
		fi
		# Narrow the check-then-act window: if the agent exited while the text
		# was typed, the shell would run it on Enter. Unsubmitted text is inert.
		fg="$(pane_foreground_program "$SLOT_PANE")"
		if ! _foreground_is "$fg" "$want_cmd"; then
			printf 'broadcast_partial\t%s\t%s\n' "$s" "typed, NOT submitted — the foreground changed to $(_foreground_label "$fg"); clear that pane's input line"
			failed=$((failed + 1))
			continue
		fi
		if ! herdr_pane_send_keys "$SLOT_PANE" Enter >/dev/null 2>&1; then
			printf 'broadcast_partial\t%s\t%s\n' "$s" "typed, NOT submitted — the Enter key was refused; press Enter in that pane or clear it (do not just re-run)"
			failed=$((failed + 1))
			continue
		fi
		printf 'broadcast_sent\t%s\n' "$s"
		sent=$((sent + 1))
	done <<<"$rows"
	if [ "$sent" -eq 0 ]; then
		echo "herdr-swarm: broadcast reached no slot (reasons above)." >&2
		return "$HS_EC_REFUSED"
	fi
	if [ "$failed" -gt 0 ]; then
		echo "herdr-swarm: broadcast reached $sent slot(s); $failed did not get it (reasons above)." >&2
		return "$HS_EC_REFUSED"
	fi
}

# _foreground_is <pane_foreground_program output> <agent_command>
_foreground_is() {
	local kind a b
	IFS=$'\t' read -r kind a b <<<"$1"
	[ "$kind" = program ] && { [ "$a" = "$2" ] || [ "$b" = "$2" ]; }
}

_foreground_label() {
	local kind a b
	IFS=$'\t' read -r kind a b <<<"$1"
	case "$kind" in
	program) printf '%s' "${b:+$a $b}${b:-$a}" ;;
	*) printf '%s' "$kind" ;;
	esac
}
