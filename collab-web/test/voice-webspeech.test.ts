import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ttsAvailable, WebSpeechBackend, type SpeakSpec } from "../src/voice/speech-engine";

/**
 * The shipped backend is the browser's own. Chromium throws when a
 * `SpeechSynthesisVoice` it no longer recognizes is assigned to an utterance —
 * a stale saved voice name must fall back to the browser default instead of
 * losing the utterance. These stubs cover that contract without a browser.
 */

class FakeVoice {
	stale: boolean;

	constructor(
		public name: string,
		public lang: string,
		stale = false,
	) {
		this.stale = stale;
	}
}

class FakeUtterance {
	text: string;
	rate = 1;
	lang = "";
	onend: (() => void) | null = null;
	onerror: ((event: { error?: string }) => void) | null = null;
	#voice: unknown = null;

	constructor(text: string) {
		this.text = text;
	}

	get voice(): unknown {
		return this.#voice;
	}

	set voice(value: unknown) {
		// Chromium rejects anything that is not a live SpeechSynthesisVoice.
		if (value instanceof FakeVoice && value.stale) {
			throw new TypeError("Failed to set the 'voice' property on 'SpeechSynthesisUtterance'.");
		}
		this.#voice = value;
	}
}

class FakeSynth {
	readonly spoken: FakeUtterance[] = [];
	voices: FakeVoice[] = [];
	mode: "ok" | "fail" = "ok";
	resumeCalls = 0;
	cancelCalls = 0;

	resume(): void {
		this.resumeCalls++;
	}

	cancel(): void {
		this.cancelCalls++;
	}

	getVoices(): FakeVoice[] {
		return this.voices;
	}

	addEventListener(): void {}

	removeEventListener(): void {}

	speak(utterance: FakeUtterance): void {
		this.spoken.push(utterance);
		if (this.mode === "fail") utterance.onerror?.({ error: "synthesis-failed" });
		else utterance.onend?.();
	}
}

function installStubs(synth: FakeSynth): void {
	Object.defineProperty(globalThis, "window", {
		value: { speechSynthesis: synth },
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
		value: FakeUtterance,
		configurable: true,
		writable: true,
	});
}

function removeStubs(): void {
	Reflect.deleteProperty(globalThis, "window");
	Reflect.deleteProperty(globalThis, "SpeechSynthesisUtterance");
}

/** Speaks through the backend and resolves with what the browser reported. */
function speak(backend: WebSpeechBackend, partial: Partial<SpeakSpec>): Promise<{ ok: boolean; error?: string }> {
	return new Promise(resolve => {
		backend.speak({ text: "Turn complete.", rate: 1, voice: null, ...partial }, (ok, error) =>
			resolve({ ok, error }),
		);
	});
}

describe("Web Speech backend", () => {
	let synth: FakeSynth;

	beforeEach(() => {
		synth = new FakeSynth();
		installStubs(synth);
	});

	afterEach(() => {
		removeStubs();
	});

	it("reports availability from window.speechSynthesis", () => {
		expect(ttsAvailable()).toBe(true);
		removeStubs();
		expect(ttsAvailable()).toBe(false);
	});

	it("lists installed voices for the picker and language matching", () => {
		synth.voices = [new FakeVoice("Microsoft Zira", "en-US"), new FakeVoice("Google español", "es-ES")];
		expect(new WebSpeechBackend().listVoices()).toEqual([
			{ name: "Microsoft Zira", lang: "en-US" },
			{ name: "Google español", lang: "es-ES" },
		]);
	});

	it("speaks at the requested rate and resumes a paused synthesis", async () => {
		const backend = new WebSpeechBackend();
		await expect(speak(backend, { text: "Running bun test", rate: 1.4 })).resolves.toEqual({ ok: true });
		expect(synth.spoken).toHaveLength(1);
		expect(synth.spoken[0].text).toBe("Running bun test");
		expect(synth.spoken[0].rate).toBe(1.4);
		expect(synth.resumeCalls).toBe(1);
	});

	it("speaks in the selected voice's language", async () => {
		synth.voices = [new FakeVoice("Microsoft Zira", "en-US"), new FakeVoice("Daniel", "en-GB")];
		const backend = new WebSpeechBackend();
		await expect(speak(backend, { voice: { name: "Daniel", lang: "en-GB" } })).resolves.toEqual({ ok: true });
		expect(synth.spoken[0].lang).toBe("en-GB");
		expect(synth.spoken[0].voice).toBeInstanceOf(FakeVoice);
		expect(synth.spoken[0].voice).toBe(synth.voices[1]);
	});

	it("falls back to the browser default when a voice goes stale mid-session (plan §7.15)", async () => {
		synth.voices = [new FakeVoice("Microsoft Zira", "en-US", true)];
		const backend = new WebSpeechBackend();
		await expect(speak(backend, { voice: { name: "Microsoft Zira", lang: "en-US" } })).resolves.toEqual({ ok: true });
		expect(synth.spoken[0].voice).toBeNull();
		// The utterance still carries the intended language for the default voice.
		expect(synth.spoken[0].lang).toBe("en-US");
	});

	it("falls back to the browser default when the requested voice is gone", async () => {
		synth.voices = [new FakeVoice("Google español", "es-ES")];
		const backend = new WebSpeechBackend();
		await expect(speak(backend, { voice: { name: "Microsoft Zira", lang: "en-US" } })).resolves.toEqual({ ok: true });
		expect(synth.spoken[0].voice).toBeNull();
	});

	it("reports a synthesis failure instead of throwing", async () => {
		synth.mode = "fail";
		await expect(speak(new WebSpeechBackend(), {})).resolves.toEqual({ ok: false, error: "synthesis-failed" });
	});

	it("returns no handle for empty text or when synthesis is unavailable", async () => {
		const backend = new WebSpeechBackend();
		let calls = 0;
		expect(backend.speak({ text: "", rate: 1, voice: null }, () => calls++)).toBeNull();
		expect(calls).toBe(0);
		removeStubs();
		expect(new WebSpeechBackend().speak({ text: "Turn complete.", rate: 1, voice: null }, () => calls++)).toBeNull();
		expect(calls).toBe(0);
	});
});
