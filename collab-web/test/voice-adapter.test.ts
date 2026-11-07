import { describe, expect, it } from "bun:test";
import type { AssistantMessage, HostFrame, SessionEntry } from "@oh-my-pi/pi-wire";
import { VoiceEventAdapter } from "../src/voice/event-adapter";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/types";
import type { VoiceEvent, VoiceSettings } from "../src/voice/types";
import {
	assistantText,
	msgEntry,
	toolResultMsg,
	userText,
	voiceBus,
	voiceChunk,
	voiceEntry,
	voiceEvent,
	voiceWelcome,
} from "./voice-frames";

function harness(
	settings: Partial<VoiceSettings> = {},
	idleFlushMs = 10,
): { adapter: VoiceEventAdapter; settings: VoiceSettings; feed: (...frames: HostFrame[]) => VoiceEvent[] } {
	const merged: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, ...settings };
	const adapter = new VoiceEventAdapter({ sessionKey: () => "test-session", settings: () => merged, idleFlushMs });
	const feed = (...frames: HostFrame[]): VoiceEvent[] => {
		const out: VoiceEvent[] = [];
		for (const frame of frames) out.push(...adapter.onFrame(frame));
		return out;
	};
	return { adapter, settings: merged, feed };
}

/** Assistant message whose text is preceded by a thinking block. */
function withThinking(text: string): AssistantMessage {
	return {
		...assistantText(text),
		content: [
			{ type: "thinking", thinking: "pienso algo" },
			{ type: "text", text },
		],
	};
}

describe("snapshot and dedup", () => {
	it("narrates initial history as a count, never entry by entry (plan §7.1)", () => {
		const { feed } = harness();
		const e1 = msgEntry("e1", userText("hola"));
		const e2 = msgEntry("e2", userText("chau"));
		const events = feed(voiceWelcome(2), voiceChunk([e1, e2], false), voiceChunk([], true));
		expect(events.map(e => e.category)).toEqual(["history-loaded"]);
		expect(events[0].text).toBe("History loaded: 2 recorded events. Narration starts from now.");
	});

	it("a resynced duplicate snapshot never re-narrates known entries (plan §7.1)", () => {
		const { feed } = harness();
		const e1 = msgEntry("e1", userText("hola"));
		feed(voiceWelcome(1), voiceChunk([e1], true));
		// Reconnect replays the same entry: only the recovered count is announced.
		const events = feed(voiceWelcome(1), voiceChunk([e1], true));
		expect(events.map(e => e.category)).toEqual(["history-recovered"]);
		expect(events[0].text).toBe("Reconnection complete.");
	});

	it("a live duplicate entry id is narrated only once", () => {
		const { feed } = harness();
		const live = msgEntry("live1", userText("nuevo"));
		const first = feed(voiceEntry(live));
		const second = feed(voiceEntry(live));
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(0);
	});

	it("only gap entries are counted on reconnect (plan §7.7)", () => {
		const { feed } = harness();
		const e1 = msgEntry("e1", userText("viejo1"));
		const e2 = msgEntry("e2", userText("viejo2"));
		feed(voiceWelcome(2), voiceChunk([e1, e2], true));
		const e3 = msgEntry("e3", userText("gap-fill"));
		const events = feed(voiceWelcome(3), voiceChunk([e1, e2, e3], true));
		expect(events.map(e => e.category)).toEqual(["history-recovered"]);
		expect(events[0].text).toBe("Reconnection complete. 1 events recovered during the disconnect.");
		// Gap entries in a resync snapshot are counted, not recited individually.
		expect(events.some(e => e.category === "user-message")).toBe(false);
	});
});

describe("streaming assistant text", () => {
	it("speaks only complete sentences and waits for the boundary (plan §7.2)", () => {
		const { feed } = harness();
		feed(voiceEvent({ type: "message_start", message: assistantText("Anal") }));
		let events = feed(voiceEvent({ type: "message_update", message: assistantText("Analizando") }));
		expect(events).toHaveLength(0); // still mid-word: nothing spoken yet
		events = feed(voiceEvent({ type: "message_update", message: assistantText("Analizando el archivo.") }));
		// A terminal "." still at the buffer end is not a boundary: it may keep growing.
		expect(events).toHaveLength(0);
		events = feed(voiceEvent({ type: "message_update", message: assistantText("Analizando el archivo. Y sigo") }));
		expect(events).toHaveLength(1); // punctuation followed by whitespace releases the sentence
		expect(events[0].text).toBe("Analizando el archivo.");
		events = feed(voiceEvent({ type: "message_end", message: assistantText("Analizando el archivo. Y sigo.") }));
		expect(events).toHaveLength(1); // message_end releases the held tail once
		expect(events[0].text).toBe("Y sigo.");
		events = feed(voiceEvent({ type: "message_end", message: assistantText("Analizando el archivo. Y sigo.") }));
		expect(events).toHaveLength(0); // remainder already emitted: no double reading
	});

	it("mid-stream join with no start does not re-read from offset zero", () => {
		const { feed } = harness();
		// message_update without message_start: no stream cursor exists; only the
		// message_end path speaks, once, bounded.
		const events = feed(voiceEvent({ type: "message_end", message: assistantText("texto ya completo.") }));
		expect(events).toHaveLength(1);
		expect(events[0].text).toBe("texto ya completo.");
	});

	it("announces a replacement and never repeats the known prefix (plan §7.3)", () => {
		const { feed } = harness();
		feed(voiceEvent({ type: "message_start", message: assistantText("Hola mundo entero.") }));
		// Identical text: nothing to speak and nothing to announce.
		expect(feed(voiceEvent({ type: "message_update", message: assistantText("Hola mundo entero.") }))).toHaveLength(
			0,
		);
		// Host rewinds the full text: divergence, not a prefix replay.
		const replaced = feed(voiceEvent({ type: "message_update", message: assistantText("Hola luna.") }));
		expect(replaced).toHaveLength(1);
		expect(replaced[0].text).toBe("The message text has changed.");
		expect(replaced[0].level).toBe("warning");
		// Diverging again announces the same way: the known text is not a strict prefix.
		const rest = feed(voiceEvent({ type: "message_update", message: assistantText("Hola luna nueva.") }));
		expect(rest).toHaveLength(1);
		expect(rest[0].text).toBe("The message text has changed.");
		// Nothing was ever spoken verbatim: the diverged tail is read once, at stream end.
		const endEvents = feed(voiceEvent({ type: "message_end", message: assistantText("Hola luna nueva.") }));
		expect(endEvents.map(e => e.text)).toEqual(["Hola luna nueva."]);
	});

	it("idle flush speaks an unterminated sentence once (plan robustness)", () => {
		const { adapter, feed } = harness();
		feed(voiceEvent({ type: "message_start", message: assistantText("parcial sin fin") }));
		expect(adapter.flushIdle()).toHaveLength(0); // not idle long enough yet
		const flushed = adapter.flushIdle(Date.now() + 5000);
		expect(flushed).toHaveLength(1);
		expect(flushed[0].text).toBe("parcial sin fin");
		expect(adapter.flushIdle(Date.now() + 9000)).toHaveLength(0); // cursor advanced: once only
	});

	it("thinking is only narrated when enabled", () => {
		const off = harness();
		off.feed(voiceEvent({ type: "message_start", message: withThinking("respuesta.") }));
		const events = off.feed(voiceEvent({ type: "message_end", message: withThinking("respuesta.") }));
		expect(events.map(e => e.text)).toEqual(["respuesta."]); // the answer is spoken, the reasoning is not
		expect(events.some(e => e.category === "assistant-thinking")).toBe(false);
		const on = harness({ speakThinking: true });
		on.feed(voiceEvent({ type: "message_start", message: withThinking("respuesta.") }));
		const eventsOn = on.feed(voiceEvent({ type: "message_end", message: withThinking("respuesta.") }));
		expect(eventsOn.map(e => e.text)).toEqual(["respuesta.", "Reasoning: pienso algo"]);
	});
});

describe("tool lifecycle", () => {
	it("narrates the three phases separately (plan §7.4)", () => {
		const { feed } = harness();
		const started = feed(
			voiceEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "bun test" },
			}),
		);
		expect(started[0].text).toBe("Running bun test");
		const updated = feed(
			voiceEvent({
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "bash",
				args: {},
				partialResult: "parcial",
			}),
		);
		expect(updated).toHaveLength(0); // normal verbosity: updates silent
		const ended = feed(
			voiceEvent({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: "todo verde",
				isError: false,
			}),
		);
		expect(ended[0].text).toBe("Command finished. output: todo verde");
	});

	it("verbose mode announces at most one update per call", () => {
		const { feed } = harness({ verbosity: "verbose" });
		feed(
			voiceEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 5" } }),
		);
		const first = feed(
			voiceEvent({
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "bash",
				args: {},
				partialResult: "a",
			}),
		);
		const second = feed(
			voiceEvent({
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "bash",
				args: {},
				partialResult: "ab",
			}),
		);
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(0);
	});

	it("dedups tool_end arriving via both event and entry (plan §7.5)", () => {
		const { feed } = harness();
		feed(voiceEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } }));
		const ended = feed(
			voiceEvent({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "read",
				result: "contenido",
				isError: false,
			}),
		);
		expect(ended).toHaveLength(1);
		const viaEntry = feed(voiceEntry(msgEntry("tr1", toolResultMsg("t1", "read", "contenido"))));
		expect(viaEntry).toHaveLength(0);
	});

	it("tool_result-only entries (no matching event) still narrate the end", () => {
		const { feed } = harness();
		const events = feed(voiceEntry(msgEntry("tr2", toolResultMsg("t9", "grep", "3 coincidencias", true))));
		expect(events).toHaveLength(1);
		expect(events[0].category).toBe("tool-end");
		expect(events[0].level).toBe("error");
		expect(events[0].text).toContain("Error in grep");
	});

	it("keeps bounded raw detail for the «con detalle» reading while speech text stays short", () => {
		const { feed } = harness();
		const huge = `fila ${1}\n` + Array.from({ length: 120 }, (_, i) => `salida intermedia ${i}`).join("\n");
		const [event] = feed(
			voiceEvent({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: huge, isError: false }),
		);
		expect(event.text.length).toBeLessThanOrEqual(280);
		expect(event.detail ?? "").toContain("salida intermedia 119");
		expect((event.detail ?? "").length).toBeLessThanOrEqual(3015);
	});
});

describe("subagents, notices and session events", () => {
	it("subagent lifecycle colliding with a main-agent id stays separate (plan §7.6)", () => {
		const { feed } = harness();
		// Main agent shares the id space name:
		feed({
			t: "agents",
			agents: [
				{
					id: "agent-1",
					displayName: "Main",
					kind: "main",
					status: "running",
					hasSessionFile: false,
					createdAt: 0,
					lastActivity: 0,
				},
			],
		});
		const started = feed(
			voiceBus("task:subagent:lifecycle", {
				id: "agent-1",
				agent: "sub-a",
				description: "scout de login",
				status: "started",
				index: 0,
			}),
		);
		expect(started).toHaveLength(1);
		expect(started[0].category).toBe("subagent-lifecycle");
		expect(started[0].source).toBe("sub-a");
		expect(started[0].text).toBe("Subagent started scout de login.");
		const completed = feed(
			voiceBus("task:subagent:lifecycle", { id: "agent-1", agent: "sub-a", status: "completed", index: 0 }),
		);
		expect(completed).toHaveLength(1);
		expect(completed[0].text).toBe("Subagent completed sub-a."); // label falls back to the agent name
		// Replaying the same lifecycle status is deduped.
		expect(
			feed(voiceBus("task:subagent:lifecycle", { id: "agent-1", agent: "sub-a", status: "completed", index: 0 })),
		).toHaveLength(0);
	});

	it("progress chatter only appears in verbose mode", () => {
		const normal = harness();
		// Wire shape (pi-wire AgentProgress): the agent name lives inside `progress`.
		const progress = {
			index: 0,
			agent: "sub-a",
			task: "t",
			progress: { id: "p1", agent: "sub-a", lastIntent: "revisar el login" },
		};
		expect(normal.feed(voiceBus("task:subagent:progress", progress))).toHaveLength(0);
		const verbose = harness({ verbosity: "verbose" });
		const first = verbose.feed(voiceBus("task:subagent:progress", progress));
		expect(first[0].text).toBe("Subagent sub-a: revisar el login");
		expect(verbose.feed(voiceBus("task:subagent:progress", progress))).toHaveLength(0); // same intent deduped
	});

	it("notice levels map to warning/error speech prefixes (plan §7.11)", () => {
		const { feed } = harness();
		const warn = feed(
			voiceEvent({ type: "notice", level: "warning", message: "contexto casi lleno", source: "sub-a" }),
		);
		expect(warn[0].category).toBe("notice");
		expect(warn[0].level).toBe("warning");
		expect(warn[0].text).toBe("Warning: contexto casi lleno");
		expect(warn[0].source).toBe("sub-a");
		expect(warn[0].detail).toBe("contexto casi lleno");
		const frameError = feed({ t: "error", message: "socket roto" });
		expect(frameError[0].level).toBe("error");
		expect(frameError[0].text).toBe("Error: socket roto");
	});

	it("retry, compaction and turn events are narrated (plan §7.9 coverage)", () => {
		const { feed } = harness();
		const retry = feed(
			voiceEvent({
				type: "auto_retry_start",
				attempt: 2,
				maxAttempts: 5,
				delayMs: 100,
				errorMessage: "timeout de proveedor",
			}),
		);
		expect(retry[0].text).toBe("Retry 2 of 5: timeout de proveedor");
		expect(
			feed(voiceEvent({ type: "auto_compaction_start", reason: "context-full", action: "auto" }))[0].text,
		).toContain("compaction");
		expect(feed(voiceEvent({ type: "auto_compaction_end", aborted: false, willRetry: false }))[0].text).toBe(
			"Compaction finished.",
		);
		// A skipped compaction end is silent: it would be noise.
		expect(
			feed(voiceEvent({ type: "auto_compaction_end", aborted: false, willRetry: true, skipped: true })),
		).toHaveLength(0);
		expect(feed(voiceEvent({ type: "turn_end" }))[0].text).toBe("The agent has finished the turn.");
	});

	it("a turn close carries the turn's final assistant text as its verdict (plan §7.13)", () => {
		const { feed } = harness();
		feed(voiceEvent({ type: "message_start", message: assistantText("Tests pass now.") }));
		feed(voiceEvent({ type: "message_update", message: assistantText("Tests pass now. 226 in total.") }));
		feed(voiceEvent({ type: "message_end", message: assistantText("Tests pass now. 226 in total.") }));
		const closed = feed(voiceEvent({ type: "turn_end" }));
		expect(closed[0].text).toBe("The agent has finished the turn.");
		expect(closed[0].detail).toBe("Tests pass now. 226 in total.");
		// The verdict is consumed: a close with no new assistant text has none to give.
		expect(feed(voiceEvent({ type: "turn_end" }))[0].detail).toBeUndefined();
	});

	it("an assistant entry seen without a stream still yields the verdict (plan §7.13)", () => {
		const { feed } = harness();
		feed(voiceEntry(msgEntry("a1", assistantText("Fix applied; the suite is green."))));
		expect(feed(voiceEvent({ type: "turn_end" }))[0].detail).toBe("Fix applied; the suite is green.");
	});

	it("user messages respect the setting (plan §7.11)", () => {
		const on = harness();
		const events = on.feed(voiceEntry(msgEntry("u1", userText("ejecuta los tests"))));
		expect(events[0].category).toBe("user-message");
		expect(events[0].text).toBe("User message: ejecuta los tests");
		const off = harness({ speakUserMessages: false });
		expect(off.feed(voiceEntry(msgEntry("u2", userText("otro"))))).toHaveLength(0);
	});

	it("bye announces the session ended and is remembered for the monitor", () => {
		const { adapter, feed } = harness();
		const events = feed({ t: "bye", reason: "host cerró" });
		expect(events[0].category).toBe("session-ended");
		expect(events[0].text).toBe("The session has ended: host cerró.");
		expect(adapter.byeSeen).toBe(true);
	});

	it("unknown entry types fall back without crashing (plan §7.8)", () => {
		const { feed } = harness();
		// Entry union from a future host: same boundary tolerance as lib/client.ts.
		const future = {
			type: "brand_new",
			id: "f1",
			parentId: null,
			timestamp: "2026-11-06T00:00:00Z",
		} as unknown as SessionEntry;
		const events = feed(voiceEntry(future));
		expect(events[0].category).toBe("entry-unknown");
		expect(events[0].text).toBe("Event of type brand_new.");
	});

	it("ui requests are announced", () => {
		const { feed } = harness();
		const events = feed({
			t: "ui-request",
			request: { reqId: 1, kind: "editor", title: "editar el env", prefill: "x" },
		});
		expect(events[0].category).toBe("ui-request");
		expect(events[0].text).toBe("The agent requests an edit: editar el env");
	});
});

describe("identifiers reused across turns (plan §7.14)", () => {
	it("a reused toolCallId narrates again in a later turn", () => {
		const { feed } = harness();
		feed(voiceEvent({ type: "turn_start" }));
		feed(
			voiceEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "bun test" },
			}),
		);
		const first = feed(
			voiceEvent({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: "226 pass",
				isError: false,
			}),
		);
		feed(voiceEvent({ type: "turn_end" }));

		feed(voiceEvent({ type: "turn_start" }));
		feed(
			voiceEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "bun test" },
			}),
		);
		const second = feed(
			voiceEvent({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: "236 pass",
				isError: false,
			}),
		);

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		expect(second[0].id).not.toBe(first[0].id);
		expect(second[0].text).toBe("Command finished. output: 236 pass");
	});

	it("replays inside the same turn are still deduped (plan §7.14)", () => {
		const { feed } = harness();
		feed(voiceEvent({ type: "turn_start" }));
		feed(voiceEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "grep", args: { pattern: "x" } }));
		expect(
			feed(
				voiceEvent({
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "grep",
					result: "match",
					isError: false,
				}),
			),
		).toHaveLength(1);
		expect(feed(voiceEntry(msgEntry("tr1", toolResultMsg("t1", "grep", "match"))))).toHaveLength(0);
		expect(feed(voiceEntry(msgEntry("tr1", toolResultMsg("t1", "grep", "match"))))).toHaveLength(0);
	});

	it("retry attempt numbers restarting in a later turn narrate again", () => {
		const { feed } = harness();
		feed(voiceEvent({ type: "turn_start" }));
		const firstAttempt = feed(
			voiceEvent({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 100,
				errorMessage: "provider timeout",
			}),
		);
		feed(voiceEvent({ type: "turn_end" }));

		feed(voiceEvent({ type: "turn_start" }));
		const secondAttempt = feed(
			voiceEvent({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 100,
				errorMessage: "provider timeout",
			}),
		);

		expect(firstAttempt).toHaveLength(1);
		expect(secondAttempt).toHaveLength(1);
		expect(secondAttempt[0].text).toBe("Retry 1 of 3: provider timeout");
		expect(secondAttempt[0].id).not.toBe(firstAttempt[0].id);
	});

	it("a subagent returning to a status after leaving it is announced again", () => {
		const { feed } = harness();
		const started = feed(
			voiceBus("task:subagent:lifecycle", {
				id: "agent-1",
				agent: "sub-a",
				description: "scout de login",
				status: "started",
				index: 0,
			}),
		);
		feed(voiceBus("task:subagent:lifecycle", { id: "agent-1", agent: "sub-a", status: "completed", index: 0 }));
		const restarted = feed(
			voiceBus("task:subagent:lifecycle", {
				id: "agent-1",
				agent: "sub-a",
				description: "scout de login",
				status: "started",
				index: 0,
			}),
		);
		expect(started).toHaveLength(1);
		expect(restarted).toHaveLength(1);
		expect(restarted[0].id).not.toBe(started[0].id);
	});

	it("a host that never sends turn_start still namespaces the next turn", () => {
		const { feed } = harness();
		feed(
			voiceEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "bun test" },
			}),
		);
		const first = feed(
			voiceEvent({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: "226 pass",
				isError: false,
			}),
		);
		feed(voiceEvent({ type: "agent_end" }));
		feed(voiceEvent({ type: "turn_end" }));

		feed(
			voiceEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "bun test" },
			}),
		);
		const second = feed(
			voiceEvent({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: "236 pass",
				isError: false,
			}),
		);

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		expect(second[0].text).toBe("Command finished. output: 236 pass");
		expect(second[0].id).not.toBe(first[0].id);
	});
});
