#!/usr/bin/env node
// herdr-swarm pane renderer entrypoint — mode dispatch plus the re-export
// surface every consumer (panes, tests) imports from. The implementation
// lives beside it, split along the seam the test files already used:
//   renderer-shared.mjs  — pure helpers (no side effects)
//   renderer-status.mjs  — status mode (U5), read-only reconciliation
//   renderer-harvest.mjs — harvest mode (U6), UI over harvest-step.sh verbs
//
// HERDR_SWARM_PANE_MODE selects the pane's mode at spawn time
// (status-pane.sh exports "status"; harvest-pane.sh exports "harvest").
// Unknown modes linger with a message instead of flash-closing the pane.
import { pathToFileURL } from "node:url";
import { ESC } from "./renderer-shared.mjs";
import { Renderer } from "./renderer-status.mjs";
import { HarvestRenderer } from "./renderer-harvest.mjs";

export * from "./renderer-shared.mjs";
export * from "./renderer-status.mjs";
export * from "./renderer-harvest.mjs";

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	// Construct inside the async wrapper so constructor failures hit the same
	// catch and never flash-close the pane.
	(async () => {
		const mode = process.env.HERDR_SWARM_PANE_MODE || "status";
		await (mode === "harvest" ? new HarvestRenderer() : new Renderer()).run();
	})().catch((err) => {
		// Restore raw mode + screen even when the crash predates run()'s own
		// handlers — a pane left in raw mode swallows keystrokes for the whole
		// 10-minute linger below.
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
		} catch {
			/* never set */
		}
		process.stdout.write(`${ESC}[?1049l${ESC}[?25h`);
		console.error("herdr-swarm renderer crashed:", err.message);
		setTimeout(() => process.exit(1), 600_000);
	});
}
