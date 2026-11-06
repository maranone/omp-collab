/**
 * Frame-level adapter: consumes every decrypted HostFrame in arrival order and
 * turns it into narratable VoiceEvents, with strict delta tracking:
 *
 * - initial snapshot = history (recorded, not recited)
 * - streaming assistant text = sentence-level cursor (never subword fragments,
 *   never a repeated prefix)
 * - tool lifecycle from discrete events (start / update / end-with-result)
 * - subagent lifecycle, notices, compaction, retry, turn boundaries,
 *   connection gaps
 *
 * The adapter never mutates or consumes client state; it only reads frames.
 */

import type {
	AgentEvent,
	AssistantMessage,
	HostFrame,
	ImageContent,
	SessionEntry,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TextContent,
	WireMessage,
} from "@oh-my-pi/pi-wire";
import { collapse, prefixDiff, sentenceSplit } from "./event-diff";
import {
	compactionEndVoice,
	compactionStartVoice,
	entryVoice,
	lifecycleVoice,
	messageVoice,
	noticeVoice,
	retryVoice,
	resultText,
	sessionVoice,
	thinkingVoice,
	toolEndVoice,
	toolStartVoice,
	uiRequestVoice,
} from "./speech-format";
import type { VoiceEvent, VoiceLevel } from "./types";

export interface AdapterSettingsView {
	speakUserMessages: boolean;
	speakThinking: boolean;
	verbosity: "normal" | "verbose";
}

export interface AdapterOptions {
	sessionKey: () => string;
	settings: () => AdapterSettingsView;
	/** ms of stream silence after which an unterminated sentence is flushed. */
	idleFlushMs?: number;
}

interface StreamState {
	/** Raw accumulated assistant text of the current streamed message. */
	fullRaw: string;
	/** Raw offset already spoken by emitted sentences. */
	emittedCursor: number;
	done: boolean;
}

/** Flatten assistant text blocks only (toolCall/thinking handled elsewhere). */
function assistantTextRaw(message: AssistantMessage): string {
	const parts: string[] = [];
	// AssistantMessage content is text | thinking | redactedThinking | toolCall:
	// images never appear here, only in user/toolResult payloads (blocksText).
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

function assistantThinkingRaw(message: AssistantMessage): string[] {
	const blocks: string[] = [];
	for (const block of message.content) {
		if (block.type === "thinking") blocks.push(block.thinking);
		else if (block.type === "redactedThinking") blocks.push("(redacted reasoning)");
	}
	return blocks;
}

/** Text for `string | content-block` payloads; images get a spoken token. */
function blocksText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "image") parts.push("(image)");
	}
	return parts.join("\n");
}

function messageContentText(message: WireMessage): string {
	if (message.role === "user" || message.role === "developer") return blocksText(message.content);
	if (message.role === "assistant") return assistantTextRaw(message);
	return blocksText(message.content);
}

/**
 * Registry-side full content for "read full detail": normalized like
 * speech text but capped far above the spoken bound so the registry keeps
 * the real payload without unbounded RAM growth.
 */
const DETAIL_CAP = 3000;
function boundedDetail(raw: string): string {
	const text = collapse(raw);
	return text.length > DETAIL_CAP ? `${text.slice(0, DETAIL_CAP)}… [truncated]` : text;
}

/** Wire-declared statuses, kept as a list so a host newer than these types is skipped, not narrated. */
const LIFECYCLE_STATUSES: readonly SubagentLifecyclePayload["status"][] = ["started", "completed", "failed", "aborted"];

export class VoiceEventAdapter {
	readonly #opts: AdapterOptions;
	readonly #idleFlushMs: number;
	#seq = 0;
	/** Entry ids already recorded — survives resyncs so snapshots never re-narrate. */
	readonly #seenEntryIds = new Set<string>();
	/** toolCallIds whose end was already narrated (from the event frame). */
	readonly #narratedToolEnds = new Set<string>();
	#snapshotSync: { total: number; arrived: number; chunkIds: string[]; wasReconnect: boolean } | null = null;
	#everCompleted = false;
	#stream: StreamState | null = null;
	#lastStreamUpdateMs = 0;
	readonly #tools = new Map<string, { name: string; updatedAnnounced: boolean }>();
	readonly #lifecycleStatus = new Map<string, string>();
	readonly #agentLabels = new Map<string, string>();
	readonly #lastProgressIntent = new Map<string, string>();
	#byeSeen = false;
	#events: VoiceEvent[] = [];

	constructor(options: AdapterOptions) {
		this.#opts = options;
		this.#idleFlushMs = options.idleFlushMs ?? 2000;
	}

	get byeSeen(): boolean {
		return this.#byeSeen;
	}

	/**
	 * Drop all transient per-session state when the welcome names a different
	 * session: streams, tool tracking and history accounting must not leak
	 * across a room switch (transient ids can collide between sessions).
	 */
	resetSession(): void {
		this.#seenEntryIds.clear();
		this.#narratedToolEnds.clear();
		this.#snapshotSync = null;
		this.#everCompleted = false;
		this.#stream = null;
		this.#lastStreamUpdateMs = 0;
		this.#tools.clear();
		this.#lifecycleStatus.clear();
		this.#agentLabels.clear();
		this.#lastProgressIntent.clear();
		this.#byeSeen = false;
	}

	onFrame(frame: HostFrame): VoiceEvent[] {
		this.#events = [];
		this.#dispatch(frame);
		return this.#events;
	}

	/** Flush a partially streamed sentence when the stream has been silent too long. */
	flushIdle(now: number = Date.now()): VoiceEvent[] {
		this.#events = [];
		const stream = this.#stream;
		if (stream === null || stream.done || stream.fullRaw.length <= stream.emittedCursor) return this.#events;
		if (now - this.#lastStreamUpdateMs < this.#idleFlushMs) return this.#events;
		this.#emitRemainder();
		return this.#events;
	}

	// ── frame dispatch ───────────────────────────────────────────────────────

	#dispatch(frame: HostFrame): void {
		switch (frame.t) {
			case "welcome": {
				const isReconnect = this.#everCompleted;
				this.#snapshotSync = { total: frame.entryCount, arrived: 0, chunkIds: [], wasReconnect: isReconnect };
				// Entries already displayed stay until the snapshot lands; a live
				// entry could have been delivered between the frames.
				if (frame.entryCount === 0) this.#completeSnapshot();
				break;
			}
			case "snapshot-chunk": {
				const sync = this.#snapshotSync;
				if (sync === null) return;
				sync.arrived += frame.entries.length;
				for (const entry of frame.entries) sync.chunkIds.push(entry?.id ?? "");
				// Same completion rule as the client: final chunk or promised count.
				if (frame.final || sync.arrived >= sync.total) this.#completeSnapshot();
				break;
			}
			case "entry":
				this.#onEntry(frame.entry, false);
				break;
			case "event":
				this.#onEvent(frame.event);
				break;
			case "bus":
				this.#onBus(frame.channel, frame.data);
				break;
			case "agents": {
				for (const agent of frame.agents) this.#agentLabels.set(agent.id, agent.displayName || agent.id);
				break;
			}
			case "ui-request":
				this.#push("ui-request", "main", uiRequestVoice({ kind: frame.request.kind, title: frame.request.title }), {
					reqId: frame.request.reqId,
				});
				break;
			case "bye":
				this.#byeSeen = true;
				this.#push("session-ended", "main", sessionVoice("ended", undefined, frame.reason));
				break;
			case "error":
				this.#push(
					"notice",
					"main",
					noticeVoice("error", frame.message),
					undefined,
					"error",
					undefined,
					frame.message,
				);
				break;
			// "state" | "transcript" | "ui-request-end" | unknown: transport/UI plumbing,
			// captured upstream; nothing semantic to narrate.
			default:
				break;
		}
	}

	#completeSnapshot(): void {
		const sync = this.#snapshotSync;
		if (sync === null) return;
		let fresh = 0;
		for (const id of sync.chunkIds) {
			if (id && !this.#seenEntryIds.has(id)) {
				this.#seenEntryIds.add(id);
				fresh++;
			}
		}
		this.#snapshotSync = null;
		if (!this.#everCompleted) {
			this.#everCompleted = true;
			// A brand-new session has nothing loaded; "History loaded: 0" would be
			// noise in the registry and in any later read-history re-narration.
			if (fresh > 0) this.#push("history-loaded", "main", sessionVoice("history", fresh));
		} else {
			// Reconnect resync: previously seen ids dedup; only gap entries count.
			this.#push("history-recovered", "main", sessionVoice("recovered", fresh));
		}
	}

	// ── entries ──────────────────────────────────────────────────────────────

	#onEntry(entry: SessionEntry, fromSnapshot: boolean): void {
		if (fromSnapshot) return; // history batch: recorded at completion instead
		if (entry === null || typeof entry !== "object" || !entry.id) return;
		// Captured before the type checks narrow `entry`: the fallback branch has
		// to read fields for entry types the wire union does not model.
		const entryType: string = entry.type;
		const entryId: string = entry.id;
		if (this.#seenEntryIds.has(entry.id)) return;
		this.#seenEntryIds.add(entry.id);
		const settings = this.#opts.settings();

		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				this.#finalizeAssistantEntry(message);
				return;
			}
			if (message.role === "user") {
				if (!settings.speakUserMessages) return;
				const text = messageContentText(message);
				if (!text) return;
				this.#push("user-message", "main", messageVoice("user", text), undefined, "info", entry.id, text);
				return;
			}
			if (message.role === "toolResult") {
				// Normal path narrates from tool_execution_end (richer result payload).
				if (this.#narratedToolEnds.has(message.toolCallId)) return;
				this.#narratedToolEnds.add(message.toolCallId);
				this.#push(
					"tool-end",
					"main",
					toolEndVoice(message.toolName, message.content, message.isError),
					{ toolCallId: message.toolCallId },
					message.isError ? "error" : "info",
					entry.id,
					blocksText(message.content),
				);
				return;
			}
			// developer: internal instruction content; recorded via entry id, not narrated by default.
			return;
		}
		if (entry.type === "custom_message") {
			if (!entry.display) return;
			if (!settings.speakUserMessages) return;
			const text = blocksText(entry.content);
			this.#push(
				"user-message",
				"main",
				messageVoice("user", text),
				{ customType: entry.customType },
				"info",
				entry.id,
				text,
			);
			return;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			const detail = entry.type === "compaction" ? String(entry.tokensBefore) : entry.summary;
			this.#push("entry-compaction", "main", entryVoice(entry.type, detail), undefined, "info", entry.id);
			return;
		}
		if (entry.type === "model_change") {
			this.#push("entry-model-change", "main", entryVoice("model_change", entry.model), undefined, "info", entry.id);
			return;
		}
		if (entry.type === "thinking_level_change") {
			if (settings.verbosity !== "verbose") return;
			this.#push(
				"entry-thinking-level",
				"main",
				entryVoice("thinking_level_change", entry.thinkingLevel ?? "none"),
				undefined,
				"info",
				entry.id,
			);
			return;
		}
		// Tolerant fallback for entry types the wire union does not model.
		this.#push("entry-unknown", "main", entryVoice(entryType || "unknown", null), undefined, "info", entryId);
	}

	// ── agent events ─────────────────────────────────────────────────────────

	#onEvent(event: AgentEvent): void {
		const settings = this.#opts.settings();
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.#stream = { fullRaw: assistantTextRaw(event.message), emittedCursor: 0, done: false };
					this.#lastStreamUpdateMs = Date.now();
				}
				break;
			case "message_update":
				if (event.message.role === "assistant" && this.#stream !== null) {
					this.#streamFull(assistantTextRaw(event.message));
					this.#lastStreamUpdateMs = Date.now();
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					if (this.#stream !== null) {
						this.#streamFull(assistantTextRaw(event.message));
						this.#emitRemainder();
						this.#emitThinking(assistantThinkingRaw(event.message));
						this.#stream.done = true;
					} else {
						// Ended without a start seen (mid-stream join): bounded one-shot.
						this.#push(
							"assistant-text",
							"main",
							messageVoice("assistant-remainder", assistantTextRaw(event.message)),
						);
					}
				}
				break;
			case "tool_execution_start":
				this.#tools.set(event.toolCallId, { name: event.toolName, updatedAnnounced: false });
				this.#push(
					"tool-start",
					"main",
					toolStartVoice(event.toolName, event.args, event.intent),
					{ toolCallId: event.toolCallId },
					"info",
					`tool-start:${event.toolCallId}`,
				);
				break;
			case "tool_execution_update": {
				const tool = this.#tools.get(event.toolCallId) ?? { name: event.toolName, updatedAnnounced: false };
				this.#tools.set(event.toolCallId, tool);
				if (settings.verbosity === "verbose" && !tool.updatedAnnounced) {
					tool.updatedAnnounced = true;
					this.#push(
						"tool-update",
						"main",
						`${tool.name}: output in progress`,
						{ toolCallId: event.toolCallId },
						"info",
						`tool-update:${event.toolCallId}`,
					);
				}
				break;
			}
			case "tool_execution_end": {
				this.#tools.delete(event.toolCallId);
				if (!this.#narratedToolEnds.has(event.toolCallId)) {
					this.#narratedToolEnds.add(event.toolCallId);
					this.#boundedSet(this.#narratedToolEnds);
					this.#push(
						"tool-end",
						"main",
						toolEndVoice(event.toolName, event.result, event.isError === true),
						{ toolCallId: event.toolCallId },
						event.isError ? "error" : "info",
						`tool-end:${event.toolCallId}`,
						resultText(event.result),
					);
				}
				break;
			}
			case "agent_start":
				this.#push(
					"agent-start",
					"main",
					"The agent has started a task.",
					undefined,
					"info",
					`agent-start:${++this.#seq}`,
				);
				break;
			case "agent_end":
				this.#push(
					"agent-end",
					"main",
					"The agent has finished its run.",
					undefined,
					"info",
					`agent-end:${++this.#seq}`,
				);
				break;
			case "turn_start":
				break; // covered by agent-start/tool narration; kept silent to avoid chatter
			case "turn_end":
				this.#push(
					"turn-end",
					"main",
					"The agent has finished the turn.",
					undefined,
					"info",
					`turn-end:${++this.#seq}`,
				);
				break;
			case "notice":
				this.#push(
					"notice",
					event.source ?? "main",
					noticeVoice(event.level, event.message),
					undefined,
					event.level,
					`notice:${event.level}:${event.message}`,
					event.message,
				);
				break;
			case "auto_retry_start":
				this.#push(
					"retry",
					"main",
					retryVoice(event.attempt, event.maxAttempts, event.errorMessage),
					{ attempt: event.attempt },
					"warning",
					`retry-start:${event.attempt}`,
				);
				break;
			case "auto_retry_end":
				if (!event.success)
					this.#push(
						"retry",
						"main",
						`Retry failed: ${event.finalError ?? "unknown error"}`,
						undefined,
						"error",
						`retry-end:${event.attempt}`,
					);
				break;
			case "auto_compaction_start":
				this.#push(
					"compaction-start",
					"main",
					compactionStartVoice(event.reason, event.action),
					undefined,
					"info",
					`compaction-start:${Date.now()}`,
				);
				break;
			case "auto_compaction_end": {
				const text = compactionEndVoice({
					aborted: event.aborted,
					errorMessage: event.errorMessage,
					skipped: event.skipped,
				});
				if (text !== null) {
					const level: VoiceLevel = event.aborted || event.errorMessage ? "warning" : "info";
					this.#push("compaction-end", "main", text, undefined, level, `compaction-end:${Date.now()}`);
				}
				break;
			}
			case "thinking_level_changed":
				if (settings.verbosity === "verbose")
					this.#push(
						"entry-thinking-level",
						"main",
						entryVoice("thinking_level_change", event.thinkingLevel ?? "none"),
						undefined,
						"info",
						`thinking-level:${++this.#seq}`,
					);
				break;
			default:
				break; // newer event types from a future host: safe no-op
		}
	}

	#onBus(channel: string, data: unknown): void {
		const settings = this.#opts.settings();
		if (channel === "task:subagent:lifecycle") {
			// Bus payload shape is declared by @oh-my-pi/pi-wire; the frame field is
			// `unknown` (same boundary handling as lib/client.ts).
			if (data === null || typeof data !== "object") return;
			const payload = data as SubagentLifecyclePayload;
			const id = typeof payload.id === "string" ? payload.id : "";
			const status = LIFECYCLE_STATUSES.find(candidate => candidate === payload.status);
			if (!id || status === undefined) return;
			if (this.#lifecycleStatus.get(id) === status) return;
			this.#lifecycleStatus.set(id, status);
			const agent = typeof payload.agent === "string" ? payload.agent : "";
			const description = typeof payload.description === "string" ? payload.description : "";
			const label = description || (agent ? (this.#agentLabels.get(agent) ?? agent) : "");
			this.#push(
				"subagent-lifecycle",
				agent || id,
				lifecycleVoice(status, label),
				{ lifecycleId: id },
				status === "failed" ? "warning" : "info",
				`lifecycle:${id}:${status}`,
			);
			return;
		}
		if (channel === "task:subagent:progress" && settings.verbosity === "verbose") {
			if (data === null || typeof data !== "object") return;
			const payload = data as SubagentProgressPayload; // same wire bus channel declaration
			const progress = payload.progress;
			if (progress === null || typeof progress !== "object") return;
			const id = typeof progress.id === "string" ? progress.id : "";
			const intent = typeof progress.lastIntent === "string" ? progress.lastIntent : "";
			if (!id || !intent || this.#lastProgressIntent.get(id) === intent) return;
			this.#lastProgressIntent.set(id, intent);
			const agent = typeof progress.agent === "string" ? progress.agent : id;
			const label = this.#agentLabels.get(agent) ?? agent;
			this.#push(
				"subagent-progress",
				agent,
				`Subagent ${label}: ${collapse(intent)}`,
				undefined,
				"info",
				`progress:${id}:${intent}`,
			);
		}
	}

	// ── streaming cursor ─────────────────────────────────────────────────────

	#streamFull(newFullRaw: string): void {
		const stream = this.#stream;
		if (stream === null) return;
		const { newText, replacement } = prefixDiff(stream.fullRaw, newFullRaw);
		if (replacement) {
			// The host replaced text: keep what was already spoken, announce the change.
			stream.emittedCursor = Math.min(stream.emittedCursor, newFullRaw.length);
			this.#push(
				"assistant-text",
				"main",
				"The message text has changed.",
				undefined,
				"warning",
				`stream-replace:${++this.#seq}`,
			);
		}
		if (newText.length === 0 && !replacement) return;
		stream.fullRaw = newFullRaw;
		if (stream.emittedCursor > newFullRaw.length) stream.emittedCursor = newFullRaw.length;
		const tail = newFullRaw.slice(stream.emittedCursor);
		const { complete, rest } = sentenceSplit(tail);
		if (complete.length === 0) return;
		const consumed = tail.length - rest.length;
		stream.emittedCursor += consumed;
		for (const chunk of complete) {
			const spoken = collapse(chunk);
			if (spoken.length === 0) continue;
			this.#push("assistant-text", "main", spoken, undefined, "info", `stream:${++this.#seq}`);
		}
	}

	#emitRemainder(): void {
		const stream = this.#stream;
		if (stream === null) return;
		const rest = stream.fullRaw.slice(stream.emittedCursor).trim();
		stream.emittedCursor = stream.fullRaw.length;
		if (rest.length < 2) return;
		const spoken = collapse(rest);
		if (spoken) this.#push("assistant-text", "main", spoken, undefined, "info", `stream-end:${++this.#seq}`);
	}

	#emitThinking(blocks: string[]): void {
		const settings = this.#opts.settings();
		if (!settings.speakThinking) return;
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			if (!block) continue;
			const spoken = collapse(block);
			if (!spoken) continue;
			this.#push(
				"assistant-thinking",
				"main",
				thinkingVoice(spoken),
				undefined,
				"info",
				`thinking:${i}:${++this.#seq}`,
			);
		}
	}

	#finalizeAssistantEntry(message: AssistantMessage): void {
		const stream = this.#stream;
		const entryFullRaw = assistantTextRaw(message);
		if (stream !== null) {
			const { newText, replacement } = prefixDiff(stream.fullRaw, entryFullRaw);
			if (!stream.done) {
				this.#emitRemainder();
				this.#emitThinking(assistantThinkingRaw(message));
			}
			if (replacement) {
				this.#push(
					"assistant-text",
					"main",
					"The final message text differs from what was narrated.",
					undefined,
					"warning",
					`entry-replace:${entryFullRaw.length}:${++this.#seq}`,
				);
			} else if (newText.length >= 2) {
				const spoken = collapse(newText);
				if (spoken)
					this.#push(
						"assistant-text",
						"main",
						spoken,
						undefined,
						"info",
						`entry-remainder:${message.timestamp}:${spoken.length}`,
					);
			}
			this.#stream = null;
			return;
		}
		// Committed assistant entry with no observed stream (armed mid-session): bounded one-shot.
		const spoken = collapse(entryFullRaw);
		if (spoken.length >= 2)
			this.#push(
				"assistant-text",
				"main",
				messageVoice("assistant-remainder", spoken),
				undefined,
				"info",
				`assistant-entry:${message.timestamp}:${spoken.length}`,
			);
	}

	// ── output plumbing ──────────────────────────────────────────────────────

	#push(
		category: VoiceEvent["category"],
		source: string,
		text: string,
		meta?: Record<string, string | number>,
		level: VoiceLevel = "info",
		dedupKey?: string,
		detail?: string,
	): void {
		if (!text) return;
		const id = dedupKey ?? `${category}:${++this.#seq}`;
		this.#events.push({
			id,
			sessionKey: this.#opts.sessionKey(),
			category,
			source,
			timestamp: Date.now(),
			level,
			text,
			meta,
			detail: detail === undefined ? undefined : boundedDetail(detail),
		});
	}

	#boundedSet(set: Set<string>, cap = 4000): void {
		if (set.size > cap) {
			const keep = [...set].slice(set.size - cap / 2);
			set.clear();
			for (const value of keep) set.add(value);
		}
	}
}
