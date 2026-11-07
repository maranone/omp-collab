/**
 * Queue-driven speech engine over Web Speech API.
 *
 * The engine is a pure state machine over an injectable backend so tests run
 * without a browser. Consumption is independent of snapshot publication:
 * compaction/retry updates are spoken while the transport keeps updating the
 * transcript, in queue order, one utterance at a time.
 *
 * Robustness:
 * - watchdog per utterance (estimated duration + margin): if the browser
 *   never fires onend/onerror (Chrome long-text / Android resume quirks),
 *   the engine cancels and advances — the queue never stalls;
 * - consecutive backend failures pause the engine with status "error"
 *   instead of looping;
 * - `resume()` is poked before each utterance (Chrome can silently pause).
 */

import { estimateSpeakMs } from "./event-diff";
import type { SpeechQueue } from "./speech-queue";
import type { VoiceEngineStatus, VoiceSettings } from "./types";

export interface VoiceSpec {
	name: string;
	lang: string;
}

export interface SpeakSpec {
	text: string;
	rate: number;
	voice: VoiceSpec | null;
}

export interface SpeakHandle {
	cancel(): void;
}

export interface TtsBackend {
	listVoices(): VoiceSpec[];
	onVoicesChanged(cb: () => void): () => void;
	/** Returns null when TTS is unavailable in this browser. */
	speak(spec: SpeakSpec, onDone: (ok: boolean, error?: string) => void): SpeakHandle | null;
}

export interface EngineOptions {
	settings: () => VoiceSettings;
	onStatus?: (status: VoiceEngineStatus) => void;
	watchdogMarginMs?: number;
}

const MAX_CONSECUTIVE_ERRORS = 4;

export class SpeechEngine {
	readonly #queue: SpeechQueue;
	readonly #backend: TtsBackend;
	readonly #opts: EngineOptions;
	readonly #watchdogMargin: number;
	#running = false;
	#paused = false;
	#speaking = false;
	#consecutiveErrors = 0;
	#status: VoiceEngineStatus = "off";
	#handle: SpeakHandle | null = null;
	#watchdog: Timer | null = null;

	constructor(queue: SpeechQueue, backend: TtsBackend, options: EngineOptions) {
		this.#queue = queue;
		this.#backend = backend;
		this.#opts = options;
		this.#watchdogMargin = options.watchdogMarginMs ?? 8000;
	}

	get status(): VoiceEngineStatus {
		return this.#status;
	}

	get paused(): boolean {
		return this.#paused;
	}

	/** Start consuming the queue. Only ever called from a user gesture (arm,
	 * read history, read again); incoming events reach the engine through
	 * `poke()`, which cannot revive a backend that errored out. A fresh gesture
	 * is a fresh chance for that backend. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#paused = false;
		this.#consecutiveErrors = 0;
		this.#setStatus(this.#queue.pendingCount() > 0 ? "speaking" : "idle");
		this.#pump();
	}

	/** Stop consuming and cancel any in-flight utterance; queue keeps its cursor. */
	stop(): void {
		this.#running = false;
		this.#cancelInFlight();
		this.#setStatus("off");
	}

	pause(): void {
		if (!this.#running || this.#paused) return;
		this.#paused = true;
		this.#cancelInFlight();
		this.#setStatus("paused");
	}

	resume(): void {
		if (!this.#running || !this.#paused) return;
		this.#paused = false;
		this.#consecutiveErrors = 0;
		this.#setStatus("idle");
		this.#pump();
	}

	/** Skip whatever is being spoken and move on. */
	skip(): void {
		this.#cancelInFlight();
		this.#queue.settleCurrent("skipped");
		this.#setStatus("idle");
		this.#pump();
	}

	/**
	 * Notify the engine that the queue grew. Only continues an already running
	 * engine (autoplay policy: starting still requires the user-gesture path).
	 */
	poke(): void {
		if (!this.#running || this.#paused) return;
		this.#pump();
	}

	/**
	 * Cancel the in-flight utterance after the queue has already removed the
	 * item (session switch, explicit clear). The queue owns bookkeeping.
	 */
	abandon(): void {
		this.#cancelInFlight();
		this.#setStatus("idle");
	}

	voices(): VoiceSpec[] {
		return this.#backend.listVoices();
	}

	onVoicesChanged(cb: () => void): () => void {
		return this.#backend.onVoicesChanged(cb);
	}

	// ── internals ────────────────────────────────────────────────────────────

	#pump(): void {
		if (!this.#running || this.#paused || this.#speaking) return;
		// Claim the utterance slot BEFORE peekNext(): claiming fires the queue's
		// onChange, which can poke() this pump re-entrantly from the monitor. With
		// #speaking still false the same item would be spoken twice.
		this.#speaking = true;
		const item = this.#queue.peekNext();
		if (item === null) {
			this.#speaking = false;
			this.#setStatus("idle");
			return;
		}
		const settings = this.#opts.settings();
		let handle: SpeakHandle | null;
		try {
			handle = this.#backend.speak(
				{ text: item.text, rate: settings.rate, voice: this.#pickVoice(settings) },
				(ok, error) => {
					this.#finish(ok, error);
				},
			);
		} catch (err) {
			// A browser that throws while building or dispatching the utterance (a
			// voice that went stale, a refused `speak()`) must follow the same path
			// as a backend that reports an error. Otherwise the claimed item is
			// never settled and every later event queues behind a dead slot.
			this.#finish(false, err instanceof Error ? err.message : "speak threw");
			return;
		}
		if (handle === null) {
			// No TTS in this browser: mark failed and stop the loop, do not spin.
			this.#speaking = false;
			this.#queue.settleCurrent("failed");
			this.#setStatus("no-tts");
			this.#running = false;
			return;
		}
		// A backend that completes synchronously already ran #finish: the item is
		// settled and #speaking is false. Do not treat it as in flight.
		if (!this.#speaking) return;
		this.#handle = handle;
		this.#setStatus("speaking");
		const estimated = estimateSpeakMs(item.text, settings.rate);
		this.#watchdog = setTimeout(() => this.#finish(false, "watchdog"), Math.max(1, estimated + this.#watchdogMargin));
	}

	/** Backend failure text is intentionally not surfaced: status + failed count are the UI signal. */
	#finish(ok: boolean, _error?: string): void {
		if (!this.#speaking) return;
		this.#speaking = false;
		if (this.#watchdog !== null) {
			clearTimeout(this.#watchdog);
			this.#watchdog = null;
		}
		this.#handle = null;
		// A cancel initiated by pause/skip/stop already settled the item; only
		// settle here when the item is still the in-flight one.
		const item = this.#queue.current;
		this.#consecutiveErrors = ok ? 0 : this.#consecutiveErrors + 1;
		// Decide the halt BEFORE settling: settling notifies the queue, which can
		// poke() this pump re-entrantly from the monitor. Clearing `#running`
		// first is what keeps a broken backend from starting one more utterance.
		const halt = !ok && this.#consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
		if (halt) this.#running = false;
		if (item !== null) this.#queue.settleCurrent(ok ? "spoken" : "failed");
		if (halt) {
			// Halt consumption; only a user action (re-arm/start) retries a
			// broken backend, never an incoming event via poke().
			this.#setStatus("error");
			return;
		}
		if (this.#running && !this.#paused) setTimeout(() => this.#pump(), ok ? 0 : 250);
	}

	#cancelInFlight(): void {
		if (this.#watchdog !== null) {
			clearTimeout(this.#watchdog);
			this.#watchdog = null;
		}
		if (this.#handle !== null) {
			this.#handle.cancel();
			this.#handle = null;
		}
		this.#speaking = false;
	}

	#pickVoice(settings: VoiceSettings): VoiceSpec | null {
		const voices = this.#backend.listVoices();
		if (voices.length === 0) return null;
		if (settings.voiceName) {
			const exact = voices.find(v => v.name === settings.voiceName);
			if (exact) return exact;
		}
		const english = voices.filter(v => v.lang.toLowerCase().startsWith("en"));
		return english.find(v => v.lang.toLowerCase() === "en-us") ?? english[0] ?? null;
	}

	#setStatus(status: VoiceEngineStatus): void {
		if (this.#status === status) return;
		this.#status = status;
		this.#opts.onStatus?.(status);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Browser backend
// ═══════════════════════════════════════════════════════════════════════════

export class WebSpeechBackend implements TtsBackend {
	#synth: SpeechSynthesis | null;

	constructor() {
		this.#synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
	}

	listVoices(): VoiceSpec[] {
		if (this.#synth === null) return [];
		return this.#synth.getVoices().map(v => ({ name: v.name, lang: v.lang }));
	}

	onVoicesChanged(cb: () => void): () => void {
		if (this.#synth === null) return () => {};
		const handler = () => cb();
		this.#synth.addEventListener("voiceschanged", handler);
		return () => this.#synth?.removeEventListener("voiceschanged", handler);
	}

	speak(spec: SpeakSpec, onDone: (ok: boolean, error?: string) => void): SpeakHandle | null {
		const synth = this.#synth;
		if (synth === null || spec.text.length === 0) return null;
		// Chrome can leave synthesis paused after long idle; poke before speaking.
		synth.resume();
		const utterance = new SpeechSynthesisUtterance(spec.text);
		utterance.rate = spec.rate;
		// Speak with the selected voice's own language; with no installed match,
		// leave the browser's default language in charge instead of forcing one.
		if (spec.voice) utterance.lang = spec.voice.lang;
		const voice = spec.voice;
		if (voice) {
			const match = synth.getVoices().find(v => v.name === voice.name && v.lang === voice.lang);
			// The voice list can change between listing and speaking (device
			// plug/unplug); a rejected assignment must not lose the utterance —
			// `utterance.lang` still matches the session language, so the browser's
			// default voice speaks it.
			if (match) {
				try {
					utterance.voice = match;
				} catch {
					// keep the default voice
				}
			}
		}
		let settled = false;
		const settle = (ok: boolean, error?: string) => {
			if (settled) return;
			settled = true;
			onDone(ok, error);
		};
		utterance.onend = () => settle(true);
		utterance.onerror = event => {
			// "canceled"/"interrupted" are intentional cancels (pause/skip); they
			// reach the engine as a failure and it classifies them by status.
			settle(false, (event as { error?: string }).error ?? "unknown");
		};
		synth.speak(utterance);
		return {
			cancel: () => {
				// cancel() fires onerror("canceled") in Chrome; the settled guard
				// makes engine-side settle calls idempotent.
				synth.cancel();
			},
		};
	}
}

export function ttsAvailable(): boolean {
	return typeof window !== "undefined" && "speechSynthesis" in window;
}
