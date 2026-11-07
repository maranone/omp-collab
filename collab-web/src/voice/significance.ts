/**
 * Milestone filter for `verbosity: "minimal"`.
 *
 * The adapter records everything and the monitor registers everything; this
 * only decides which events are worth interrupting the listener for. Events
 * dropped here stay in the registry, so the detail actions and "read history"
 * remain complete.
 */

import type { VoiceCategory, VoiceEvent, VoiceItem } from "./types.ts";

/** State changes worth hearing however chatty the narration is being. */
const MILESTONE_CATEGORIES: Partial<Record<VoiceCategory, true>> = {
	notice: true,
	retry: true,
	"compaction-start": true,
	"compaction-end": true,
	"entry-compaction": true,
	"subagent-lifecycle": true,
	"session-connected": true,
	"session-disconnected": true,
	"session-ended": true,
	"history-recovered": true,
	"ui-request": true,
};

function isFailure(level: VoiceItem["level"]): boolean {
	return level === "error" || level === "warning"; // failures are never filler
}

/**
 * True when `event` deserves speech in milestones-only mode.
 *
 * `turn-end` qualifies only when the adapter attached the turn's final
 * assistant text (`detail`): that is what makes the close a verdict rather
 * than another transition line. Text streams, tool calls, agent start/end,
 * progress updates and user messages are silent here — the milestone is the
 * verdict they add up to.
 */
export function isMilestone(event: VoiceEvent): boolean {
	if (isFailure(event.level)) return true;
	if (event.category === "turn-end") return event.detail !== undefined;
	return MILESTONE_CATEGORIES[event.category] === true;
}

/**
 * Queue-side view of the same rule. A queued item has no `detail`, so its
 * turn close is judged by category alone: whatever was already queued as a
 * turn close keeps its slot when the user switches to milestones mode.
 */
export function isMilestoneItem(item: Pick<VoiceItem, "category" | "level">): boolean {
	if (isFailure(item.level)) return true;
	return item.category === "turn-end" || MILESTONE_CATEGORIES[item.category] === true;
}
