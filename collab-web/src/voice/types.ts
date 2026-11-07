/** Shared internal types for the collab voice monitor. */

/** Semantic categories the voice layer understands. Unknown wire variants fall back to `entry-unknown`. */
export type VoiceCategory =
	| "session-connected"
	| "session-disconnected"
	| "session-ended"
	| "history-loaded"
	| "history-recovered"
	| "user-message"
	| "assistant-text"
	| "assistant-thinking"
	| "tool-start"
	| "tool-update"
	| "tool-end"
	| "notice"
	| "retry"
	| "compaction-start"
	| "compaction-end"
	| "turn-end"
	| "agent-start"
	| "agent-end"
	| "subagent-lifecycle"
	| "subagent-progress"
	| "ui-request"
	| "entry-compaction"
	| "entry-model-change"
	| "entry-thinking-level"
	| "entry-branch"
	| "entry-unknown";

export type VoiceLevel = "info" | "warning" | "error";

/** One narratable unit produced by the event adapter. */
export interface VoiceEvent {
	/** Stable id used for deduplication across resyncs: `<category>:<source key>`. */
	id: string;
	sessionKey: string;
	category: VoiceCategory;
	/** "main" for the primary agent; subagent id/label when the event belongs to one. */
	source: string;
	timestamp: number;
	level?: VoiceLevel;
	/** Text already formatted for speech (normalized, bounded). */
	text: string;
	/** Bounded raw content kept for the "read detail" action. */
	detail?: string;
	/** Bounded metadata kept in the registry for the "read detail" action. */
	meta?: Record<string, string | number>;
}

export type VoiceItemStatus = "pending" | "speaking" | "spoken" | "failed" | "skipped";

/** A queued speech item; `text` is final narration, never raw transport deltas. */
export interface VoiceItem {
	id: string;
	sessionId: string;
	source: string;
	category: VoiceCategory;
	timestamp: number;
	level?: VoiceLevel;
	text: string;
	status: VoiceItemStatus;
}

export interface VoiceStats {
	armed: boolean;
	paused: boolean;
	pending: number;
	spoken: number;
	failed: number;
	/** Estimated ms until the backlog empties at the current rate. */
	lagMs: number;
	status: VoiceEngineStatus;
	/** Text of the item currently being spoken (already formatted), else null. */
	current: string | null;
}

export type VoiceEngineStatus = "off" | "idle" | "speaking" | "paused" | "error" | "no-tts";

/**
 * Narration density.
 *
 * - `minimal`: milestones only — turn verdict, errors, compaction, subagent lifecycle, reconnection, ui-request.
 * - `normal`: every interaction start and end.
 * - `verbose`: also in-progress tool output and subagent progress.
 */
export type VoiceVerbosity = "minimal" | "normal" | "verbose";

export interface VoiceSettings {
	/** Persisted preference for speaking user messages (activation still requires a gesture). */
	speakUserMessages: boolean;
	/** Speak assistant thinking blocks. Off by default; all content stays in the registry. */
	speakThinking: boolean;
	/** "minimal" speaks milestones only; "normal" every transition; "verbose" adds progress. */
	verbosity: VoiceVerbosity;
	/** SpeechSynthesis rate; 0.8–1.8. */
	rate: number;
	/** Selected `SpeechSynthesisVoice.name`, else the best en-* voice. */
	voiceName: string | null;
	/** How many registry items "read history" enqueues. */
	historyReadCount: number;
	/**
	 * Persist settled records to IndexedDB (TTL-bounded, session-scoped).
	 * Off by default: the registry stays in RAM and no transcript text is
	 * written to disk unless the user knowingly enables it.
	 */
	persistRecords: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
	speakUserMessages: true,
	speakThinking: false,
	verbosity: "normal",
	rate: 1.15,
	voiceName: null,
	historyReadCount: 50,
	persistRecords: false,
};
