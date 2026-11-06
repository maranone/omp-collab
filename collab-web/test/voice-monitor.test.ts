import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { SessionHeader } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";
import { VoiceMonitor } from "../src/voice/monitor";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/types";
import { deriveSessionKey } from "../src/voice/speech-storage";
import { FakeBackend, FakeRecordStore, FakeWebSocket } from "./voice-fakes";
import { msgEntry, userText, VOICE_HEADER, voiceChunk, voiceEntry, voiceEvent, voiceWelcome } from "./voice-frames";

// Synthetic link only (plan §6): no real room credentials anywhere in these tests.
const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER_B: SessionHeader = {
	type: "session",
	id: "voice-test-session-2",
	timestamp: "2026-11-06T00:00:00.000Z",
	cwd: "/tmp/voice-b",
};

const NativeWebSocket = globalThis.WebSocket;

beforeAll(() => {
	// bun:test has no `vi.stubGlobal`: the repo convention is a defineProperty swap
	// (see socket-reconnect.test.ts) restored after the suite.
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
});

afterAll(() => {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
});

interface MonitorHarness {
	client: GuestClient;
	monitor: VoiceMonitor;
	store: FakeRecordStore;
	backend: FakeBackend;
}

function harness(options: { persist?: boolean; hang?: boolean } = {}): MonitorHarness {
	const client = new GuestClient(LINK, "tester");
	const store = new FakeRecordStore();
	const backend = new FakeBackend();
	if (options.hang) backend.mode = "hang";
	const monitor = new VoiceMonitor(client, {
		backend,
		recordStore: store,
		settings: { ...DEFAULT_VOICE_SETTINGS, persistRecords: options.persist ?? false },
	});
	return { client, monitor, store, backend };
}

function teardown(h: MonitorHarness): void {
	h.monitor.dispose();
	h.client.close();
}

beforeEach(() => {
	vi.useFakeTimers();
	FakeWebSocket.reset();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("monitor: recording is independent from activation", () => {
	it("registers every event while voice is OFF and arming never recites history (plan §7.1/§7.8)", () => {
		const h = harness();
		h.monitor.arm(); // engine starts with an empty queue
		h.monitor.disarm();

		h.client.applyFrameForTest(voiceWelcome(1));
		h.client.applyFrameForTest(voiceChunk([msgEntry("e-old", userText("antiguo"))]));
		h.client.applyFrameForTest(voiceEntry(msgEntry("e-live", userText("nuevo"))));
		// Nothing queued or spoken while unarmed:
		expect(h.backend.started).toEqual([]);
		expect(h.monitor.getStats().pending).toBe(0);
		expect(h.monitor.registrySize).toBe(2); // history-loaded + live user message
		const statsBefore = h.monitor.getStats();

		// Arming queues nothing but what arrives from now on: the registry is never recited.
		h.monitor.arm();
		expect(h.backend.started).toEqual([]);
		expect(h.monitor.getStats().pending).toBe(0);

		let notifications = 0;
		const unsubscribe = h.monitor.subscribe(() => notifications++);
		h.client.applyFrameForTest(voiceEntry(msgEntry("e-now", userText("ahora"))));
		vi.advanceTimersByTime(1);
		expect(h.backend.started).toEqual(["User message: ahora"]); // only the new event
		expect(h.monitor.getStats().spoken).toBe(1);
		expect(h.monitor.getStats()).not.toBe(statsBefore); // reference change for useSyncExternalStore
		expect(notifications).toBeGreaterThan(0);

		// Replaying the same live entry never re-narrates.
		h.client.applyFrameForTest(voiceEntry(msgEntry("e-now", userText("ahora"))));
		vi.advanceTimersByTime(1);
		expect(h.backend.started).toHaveLength(1);
		unsubscribe();
		teardown(h);
	});

	it("idle streaming flush narrates an unterminated sentence exactly once", () => {
		const h = harness();
		h.monitor.arm();
		h.client.applyFrameForTest(
			voiceEvent({
				type: "message_start",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "frase sin cerrar" }],
					model: "test/model",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
					stopReason: "stop",
					timestamp: 1,
				},
			}),
		);
		vi.advanceTimersByTime(3000); // monitor idle timer flushes after idleFlushMs
		expect(h.backend.started).toEqual(["frase sin cerrar"]);
		vi.advanceTimersByTime(10_000);
		expect(h.backend.started).toHaveLength(1);
		teardown(h);
	});
});

describe("monitor: registry bounds and persistence gating (plan §7.12)", () => {
	it("a 1005-event session keeps the registry bounded and persists evictions as recorded", () => {
		const h = harness({ persist: true });
		h.client.applyFrameForTest(voiceWelcome(0));
		for (let i = 0; i < 1005; i++) {
			h.client.applyFrameForTest(voiceEntry(msgEntry(`u${i}`, userText(`evento ${i}`))));
		}
		expect(h.monitor.registrySize).toBe(1000);
		const evicted = h.store.records.filter(r => r.status === "recorded");
		expect(evicted).toHaveLength(5); // no silent loss: everything evicted from RAM is persisted
		expect(h.store.records.every(r => r.sessionKey === deriveSessionKey(VOICE_HEADER.id))).toBe(true);
		teardown(h);
	});

	it("persistRecords off (default): nothing is ever written to the store", () => {
		const h = harness();
		h.monitor.arm();
		h.client.applyFrameForTest(voiceEntry(msgEntry("u1", userText("privado"))));
		vi.advanceTimersByTime(1);
		expect(h.monitor.getStats().spoken).toBe(1);
		expect(h.store.records).toEqual([]);
		expect(h.monitor.storageMode).toBe("off");
		teardown(h);
	});

	it("persistRecords on: settled items are written with the derived session key", () => {
		const h = harness({ persist: true });
		h.monitor.arm();
		h.client.applyFrameForTest(voiceWelcome(0));
		h.client.applyFrameForTest(voiceEntry(msgEntry("u1", userText("guardado"))));
		vi.advanceTimersByTime(1);
		expect(h.store.records).toHaveLength(1);
		const record = h.store.records[0];
		expect(record.status).toBe("spoken");
		expect(record.category).toBe("user-message");
		expect(record.text).toBe("User message: guardado");
		expect(record.sessionKey).toBe(deriveSessionKey(VOICE_HEADER.id));
		expect(record.sessionKey).not.toBe("anon"); // no raw header id, no anonymous mixing
		expect(h.monitor.storageMode).toBe("idb");
		teardown(h);
	});
});

describe("monitor: session isolation (plan §7.9)", () => {
	it("a welcome with a different session id clears queues/registries and re-keys records", () => {
		const h = harness({ persist: true, hang: true });
		h.monitor.arm();
		h.client.applyFrameForTest(voiceWelcome(0));
		h.client.applyFrameForTest(voiceEntry(msgEntry("old1", userText("pendiente viejo"))));
		vi.advanceTimersByTime(1); // stuck in flight (hang backend)
		expect(h.monitor.getStats().pending).toBe(0); // it became the current item

		h.client.applyFrameForTest(voiceWelcome(0, HEADER_B)); // room switch
		expect(h.monitor.getStats().pending).toBe(0);
		expect(h.monitor.registrySize).toBe(0);
		const abandoned = h.store.records.filter(r => r.status === "skipped");
		expect(abandoned).toHaveLength(1);
		expect(abandoned[0].sessionKey).toBe(deriveSessionKey(VOICE_HEADER.id)); // attributed to the OLD session

		h.backend.mode = "auto";
		h.client.applyFrameForTest(voiceEntry(msgEntry("new1", userText("nueva sala"))));
		vi.advanceTimersByTime(1);
		const fresh = h.store.records.filter(r => r.status === "spoken");
		expect(fresh).toHaveLength(1);
		expect(fresh[0].text).toBe("User message: nueva sala");
		expect(fresh[0].sessionKey).toBe(deriveSessionKey(HEADER_B.id));
		teardown(h);
	});
});

describe("monitor: connection gaps (plan §7.8)", () => {
	it("reconnect gap announces only recovered counts, never re-narrates known entries", () => {
		const h = harness();
		h.monitor.arm();
		h.client.connect();
		FakeWebSocket.last().accept();
		h.client.applyFrameForTest(voiceWelcome(1));
		h.client.applyFrameForTest(voiceChunk([msgEntry("e1", userText("viejo"))]));
		h.client.applyFrameForTest(voiceEntry(msgEntry("e2", userText("en vivo"))));
		vi.advanceTimersByTime(1);

		FakeWebSocket.last().drop(1006);
		vi.advanceTimersByTime(1);
		expect(h.backend.started.some(t => /Connection lost/i.test(t))).toBe(true); // announced the gap

		vi.advanceTimersByTime(2000); // backoff reconnect fires
		FakeWebSocket.last().accept();
		h.client.applyFrameForTest(voiceWelcome(2));
		h.client.applyFrameForTest(voiceChunk([msgEntry("e1", userText("viejo")), msgEntry("e2", userText("en vivo"))]));
		vi.advanceTimersByTime(1);
		const userNarrations = h.backend.started.filter(t => t.startsWith("User message"));
		expect(userNarrations).toEqual(["User message: en vivo"]); // exactly one, from before the drop
		teardown(h);
	});

	it("a session that ends without a bye frame gets a synthesized end event", () => {
		const h = harness();
		h.monitor.arm();
		h.client.connect();
		// Socket never completes the handshake: welcome timeout ends the client.
		vi.advanceTimersByTime(30_001);
		expect(h.client.getSnapshot().phase).toBe("ended");
		vi.advanceTimersByTime(1);
		expect(h.backend.started.filter(t => t.includes("The session has ended"))).toHaveLength(1);
		teardown(h);
	});

	it("a real bye is narrated once and the phase transition does not duplicate it", () => {
		const h = harness({ persist: true });
		h.monitor.arm();
		h.client.applyFrameForTest(voiceWelcome(0));
		h.client.applyFrameForTest({ t: "bye", reason: "host cerró" });
		vi.advanceTimersByTime(1);
		expect(h.client.getSnapshot().phase).toBe("ended");
		expect(h.store.records.filter(r => r.category === "session-ended")).toHaveLength(1);
		teardown(h);
	});
});

describe("monitor: history reading and explicit actions", () => {
	it("readHistory enqueues the tail; the detail variant uses the bounded full text (leer detalle)", () => {
		const h = harness();
		h.client.applyFrameForTest(voiceWelcome(0));
		const huge = `fila 1\n` + Array.from({ length: 120 }, (_, i) => `salida intermedia ${i}`).join("\n");
		h.client.applyFrameForTest(
			voiceEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "bun test" },
			}),
		);
		h.client.applyFrameForTest(
			voiceEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: huge, isError: false }),
		);
		expect(h.monitor.getStats().pending).toBe(0); // voice off: nothing queued

		expect(h.monitor.readHistory()).toBe(2);
		expect(h.monitor.getStats().pending).toBe(2);
		h.monitor.arm();
		vi.advanceTimersByTime(1);
		expect(h.backend.started).toHaveLength(2);
		expect(h.backend.started[0]).toBe("Running bun test");
		expect(h.backend.started[1]).not.toContain("salida intermedia 119"); // spoken text stays bounded

		expect(h.monitor.readHistory(undefined, true)).toBe(2);
		vi.advanceTimersByTime(50); // drain the whole queued batch: each utterance settles before the next is claimed
		expect(h.backend.started.some(t => t.includes("salida intermedia 119"))).toBe(true); // full detail on demand

		// Repeated presses re-narrate: unique ids bypass queue dedup on purpose.
		expect(h.monitor.readHistory()).toBe(2);
		teardown(h);
	});

	it("clearPending records every removed item as skipped; clearSessionHistory empties both layers", () => {
		const h = harness({ persist: true, hang: true });
		h.monitor.arm();
		for (let i = 0; i < 3; i++) h.client.applyFrameForTest(voiceEntry(msgEntry(`u${i}`, userText(`evento ${i}`))));
		vi.advanceTimersByTime(1);
		expect(h.monitor.clearPending()).toBe(3); // in-flight + pending, none silently dropped
		expect(h.monitor.getStats().pending).toBe(0);
		expect(h.store.records.every(r => r.status === "skipped")).toBe(true);

		h.monitor.clearSessionHistory();
		expect(h.monitor.registrySize).toBe(0);
		expect(h.store.records).toEqual([]);
		teardown(h);
	});

	it("requeueLast re-narrates the most recent finished item", () => {
		const h = harness();
		h.monitor.arm();
		h.client.applyFrameForTest(voiceWelcome(0));
		h.client.applyFrameForTest(voiceEntry(msgEntry("u1", userText("releeme"))));
		vi.advanceTimersByTime(1);
		expect(h.backend.started).toEqual(["User message: releeme"]);
		h.monitor.requeueLast();
		vi.advanceTimersByTime(1);
		expect(h.backend.started).toEqual(["User message: releeme", "User message: releeme"]);
		expect(h.monitor.getStats().spoken).toBe(2);
		teardown(h);
	});
});

describe("monitor lifecycle", () => {
	it("dispose detaches the client seam: later frames are not recorded", () => {
		const h = harness();
		h.client.applyFrameForTest(voiceWelcome(0));
		h.monitor.dispose();
		const before = h.monitor.registrySize;
		h.client.applyFrameForTest(voiceEntry(msgEntry("u1", userText("tarde"))));
		expect(h.monitor.registrySize).toBe(before);
		h.client.close();
	});
});
