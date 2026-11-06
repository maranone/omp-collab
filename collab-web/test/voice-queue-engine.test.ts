import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { SpeechEngine } from "../src/voice/speech-engine";
import { SpeechQueue } from "../src/voice/speech-queue";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/types";
import type { VoiceEvent, VoiceEngineStatus, VoiceItem, VoiceSettings } from "../src/voice/types";
import { FakeBackend } from "./voice-fakes";

function ev(id: string, text: string, category: VoiceEvent["category"] = "assistant-text"): VoiceEvent {
	return { id, sessionKey: "test-session", category, source: "main", timestamp: 0, text };
}

interface EngineHarness {
	queue: SpeechQueue;
	engine: SpeechEngine;
	statuses: VoiceEngineStatus[];
	settled: VoiceItem[];
	settings: VoiceSettings;
}

function harness(backend: FakeBackend, settings: Partial<VoiceSettings> = {}, watchdogMarginMs = 8000): EngineHarness {
	const merged: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, ...settings };
	const statuses: VoiceEngineStatus[] = [];
	const settled: VoiceItem[] = [];
	const queue = new SpeechQueue({ onItemStatus: item => settled.push(item) });
	const engine = new SpeechEngine(queue, backend, {
		settings: () => merged,
		watchdogMarginMs,
		onStatus: status => statuses.push(status),
	});
	return { queue, engine, statuses, settled, settings: merged };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("queue semantics", () => {
	it("keeps strict FIFO order and exposes stats", () => {
		const queue = new SpeechQueue();
		const added = queue.enqueue([ev("a", "uno"), ev("b", "dos"), ev("c", "tres")], "s");
		expect(added.map(i => i.text)).toEqual(["uno", "dos", "tres"]);
		expect(queue.peekNext()?.text).toBe("uno");
		queue.settleCurrent("spoken");
		expect(queue.pendingCount()).toBe(2);
		expect(queue.stats(1).totalEnqueued).toBe(3);
		expect(queue.stats(1).pending).toBe(2);
		expect(queue.stats(1).lagMs).toBeGreaterThan(0);
	});

	it("suppresses duplicate event ids from resync replays", () => {
		const queue = new SpeechQueue();
		expect(queue.enqueue([ev("a", "uno")], "s")).toHaveLength(1);
		expect(queue.enqueue([ev("a", "uno"), ev("b", "dos")], "s")).toHaveLength(1);
		expect(queue.pendingCount()).toBe(2);
	});

	it("skipCurrent records the in-flight item without dropping pending ones", () => {
		const settled: VoiceItem[] = [];
		const queue = new SpeechQueue({ onItemStatus: item => settled.push(item) });
		queue.enqueue([ev("a", "uno"), ev("b", "dos")], "s");
		queue.peekNext(); // engine picks "uno"
		const skipped = queue.skipCurrent();
		expect(skipped?.text).toBe("uno");
		expect(skipped?.status).toBe("skipped");
		expect(settled.map(i => i.status)).toEqual(["skipped"]);
		expect(queue.pendingCount()).toBe(1);
	});

	it("skipCurrent before any peek consumes the head (never silently lost)", () => {
		const queue = new SpeechQueue();
		queue.enqueue([ev("a", "uno")], "s");
		expect(queue.skipCurrent()?.status).toBe("skipped");
		expect(queue.pendingCount()).toBe(0);
	});

	it("clearPending removes everything after explicit confirmation and records each", () => {
		const settled: VoiceItem[] = [];
		const queue = new SpeechQueue({ onItemStatus: item => settled.push(item) });
		queue.enqueue([ev("a", "uno"), ev("b", "dos"), ev("c", "tres")], "s");
		queue.peekNext();
		expect(queue.clearPending()).toBe(3); // in-flight + pending
		expect(queue.pendingCount()).toBe(0);
		expect(queue.current).toBeNull();
		expect(settled.every(i => i.status === "skipped")).toBe(true);
	});

	it("requeue puts a fresh copy back at the head («leer de nuevo»)", () => {
		const queue = new SpeechQueue();
		queue.enqueue([ev("a", "uno"), ev("b", "dos")], "s");
		queue.peekNext();
		queue.settleCurrent("spoken");
		const copy = queue.requeue(settledDummy("uno"));
		expect(copy?.text).toBe("uno");
		expect(copy?.status).toBe("pending");
		expect(queue.peekNext()?.text).toBe("uno"); // before "dos"
		expect(queue.peekNext()?.id).not.toBe("a"); // re-narration bypasses id-dedup
	});

	function settledDummy(text: string): VoiceItem {
		return {
			id: `done:${text}`,
			sessionId: "s",
			source: "main",
			category: "assistant-text",
			timestamp: 0,
			text,
			status: "spoken",
		};
	}
});

describe("speech engine consumption", () => {
	it("speaks queue order, one utterance at a time, and settles each as spoken", () => {
		const backend = new FakeBackend();
		const h = harness(backend);
		h.queue.enqueue([ev("a", "primero."), ev("b", "segundo."), ev("c", "tercero.")], "s");
		h.engine.start();
		vi.advanceTimersByTime(50);
		expect(backend.started).toEqual(["primero.", "segundo.", "tercero."]);
		expect(h.settled.map(i => i.status)).toEqual(["spoken", "spoken", "spoken"]);
		expect(h.engine.status).toBe("idle");
		expect(h.statuses).toContain("speaking");
	});

	it("ten events while the TTS is busy queue up as ten ordered items (plan §7.5)", () => {
		const backend = new FakeBackend();
		backend.mode = "hang";
		const h = harness(backend);
		h.queue.enqueue([ev("busy", "en reproducción.")], "s");
		h.engine.start();
		vi.advanceTimersByTime(5); // first utterance in flight, backend stuck
		const events = Array.from({ length: 10 }, (_, i) => ev(`e${i}`, `evento ${i}.`));
		h.queue.enqueue(events, "s");
		expect(h.queue.pendingCount()).toBe(10);
		expect(h.queue.stats(1).currentText).toBe("en reproducción.");
		// User skips the stuck utterance: the backlog drains in arrival order.
		backend.mode = "auto";
		h.engine.skip();
		vi.advanceTimersByTime(100);
		expect(backend.started.slice(1)).toEqual(events.map(e => e.text));
		expect(h.queue.pendingCount()).toBe(0);
	});

	it("events enqueued during a live utterance keep being consumed (plan §7.6 compactation)", () => {
		const backend = new FakeBackend();
		const h = harness(backend);
		h.queue.enqueue([ev("a", "leyendo el archivo."), ev("b", "ejecutando el comando.")], "s");
		h.engine.start();
		vi.advanceTimersByTime(1); // first utterance in flight
		// Compaction snapshot traffic arrives while audio keeps playing:
		h.queue.enqueue([ev("cmp", "Compactación iniciada.", "compaction-start")], "s");
		vi.advanceTimersByTime(100);
		expect(backend.started).toEqual(["leyendo el archivo.", "ejecutando el comando.", "Compactación iniciada."]);
	});

	it("a backend without TTS reports no-tts instead of spinning", () => {
		const backend = new FakeBackend();
		backend.mode = "none";
		const h = harness(backend);
		h.queue.enqueue([ev("a", "uno"), ev("b", "dos")], "s");
		h.engine.start();
		vi.advanceTimersByTime(10_000);
		expect(backend.started).toHaveLength(1); // tried once, then stopped
		expect(h.engine.status).toBe("no-tts");
		expect(h.settled.map(i => i.status)).toEqual(["failed"]);
	});

	it("consecutive backend errors stop the loop with status error (plan §7.10 onerror)", () => {
		const backend = new FakeBackend();
		backend.mode = "fail";
		const h = harness(backend);
		h.queue.enqueue(
			Array.from({ length: 5 }, (_, i) => ev(`e${i}`, `evento ${i}`)),
			"s",
		);
		h.engine.start();
		// Each failure: immediate backend error + 250 ms backoff before the next try.
		vi.advanceTimersByTime(2_000); // four consecutive failures, then the loop stops
		expect(backend.started).toHaveLength(4);
		expect(h.engine.status).toBe("error");
		expect(h.queue.pendingCount()).toBe(1); // remaining item preserved for a retry by the user
		vi.advanceTimersByTime(20_000);
		expect(backend.started).toHaveLength(4); // loop is stopped, not spinning
		expect(h.settled.every(i => i.status === "failed")).toBe(true);
	});

	it("a stuck utterance is cut by the watchdog and the queue never blocks (plan §7.10)", () => {
		const backend = new FakeBackend();
		backend.mode = "hang";
		// Margin far below the estimate: the watchdog becomes effectively immediate.
		const h = harness(backend, {}, -1_000_000);
		h.queue.enqueue([ev("a", "primero."), ev("b", "segundo.")], "s");
		h.engine.start();
		vi.advanceTimersByTime(1); // watchdog kills the hung utterance
		vi.advanceTimersByTime(300); // backoff, second utterance, its own watchdog
		vi.advanceTimersByTime(300);
		expect(backend.started).toEqual(["primero.", "segundo."]);
		expect(h.settled.map(i => i.status)).toEqual(["failed", "failed"]);
		expect(h.queue.pendingCount()).toBe(0);
		expect(h.engine.status).toBe("idle"); // advanced past the dead utterances, did not stall
	});

	it("pause cancels in flight, resume re-speaks the same item, skip moves on (plan §7.10)", () => {
		const backend = new FakeBackend();
		backend.mode = "hang";
		const h = harness(backend);
		h.queue.enqueue([ev("a", "pausable."), ev("b", "siguiente.")], "s");
		h.engine.start();
		vi.advanceTimersByTime(1); // "pausable." in flight (backend stuck on it)
		h.engine.pause();
		expect(h.engine.paused).toBe(true);
		expect(backend.canceled).toEqual(["pausable."]);
		expect(h.queue.stats(1).currentText).toBe("pausable."); // item retained, not lost
		vi.advanceTimersByTime(1000);
		expect(backend.started).toEqual(["pausable."]); // nothing spoken while paused
		h.engine.resume();
		expect(backend.started).toEqual(["pausable.", "pausable."]); // resume re-speaks the paused item
		h.engine.skip(); // user skips the still-stuck re-spoken item
		vi.advanceTimersByTime(1); // "siguiente." starts
		expect(backend.started).toEqual(["pausable.", "pausable.", "siguiente."]);
		backend.mode = "auto";
		vi.advanceTimersByTime(9000); // default watchdog clears it; queue drains, no blockage
		expect(h.settled.map(i => i.status)).toEqual(["skipped", "failed"]);
		expect(h.engine.status).toBe("idle");
	});
});
