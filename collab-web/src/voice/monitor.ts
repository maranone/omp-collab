/**
 * VoiceMonitor: the single integration point between the collab client and
 * the speech subsystem.
 *
 * Responsibilities:
 * - observe every applied frame (via GuestClient.addFrameObserver, before any
 *   UI processing) and feed the event adapter;
 * - record all semantic events in the registry from the moment the client
 *   exists — even while voice is OFF; activation only changes whether events
 *   get queued for speech from that moment on (no reciting of old history);
 * - synthesize connection-phase events the transport reports outside frames
 *   (reconnect without a bye, welcome timeout);
 * - persist settled items to IndexedDB, settings to localStorage;
 * - expose stats for the UI through a useSyncExternalStore-compatible pair.
 */

import type { HostFrame } from "@oh-my-pi/pi-wire";
import type { ConnectionPhase, GuestClient } from "../lib/client";
import { VoiceEventAdapter } from "./event-adapter";
import { fnv1a } from "./event-diff";
import { sessionVoice, verdictVoice } from "./speech-format";
import { SpeechEngine, ttsAvailable, WebSpeechBackend, type TtsBackend, type VoiceSpec } from "./speech-engine";
import { SpeechQueue } from "./speech-queue";
import {
	deriveSessionKey,
	loadVoiceSettings,
	recordFromItem,
	saveVoiceSettings,
	type VoiceRecord,
	VoiceRecordStore,
} from "./speech-storage";
import { isMilestone, isMilestoneItem } from "./significance";
import type { VoiceCategory, VoiceEngineStatus, VoiceEvent, VoiceItem, VoiceSettings, VoiceStats } from "./types";

export interface VoiceMonitorOptions {
	/** Injectable TTS backend; defaults to Web Speech when available. */
	backend?: TtsBackend | null;
	/** Injectable record store; defaults to the IndexedDB-backed store. */
	recordStore?: VoiceRecordStore;
	/** Initial settings; defaults to localStorage-loaded settings. */
	settings?: VoiceSettings;
	/** Silence after which an unterminated streamed sentence is flushed. */
	idleFlushMs?: number;
}

const REGISTRY_CAP = 1000;
const IDLE_CHECK_MS = 700;
/** Records that could not be written while IndexedDB was still opening. */
const DEFERRED_CAP = 500;

export class VoiceMonitor {
	readonly #client: GuestClient;
	readonly #settings: VoiceSettings;
	readonly #recordStore: VoiceRecordStore;
	readonly #adapter: VoiceEventAdapter;
	readonly #queue: SpeechQueue;
	readonly #engine: SpeechEngine | null;
	readonly #registry: VoiceEvent[] = [];
	readonly #deferredRecords: VoiceRecord[] = [];
	readonly #listeners = new Set<() => void>();
	#sessionKey = "anon";
	#armed = false;
	#storageBroken = false;
	#spoken = 0;
	#failed = 0;
	#lastPhase: ConnectionPhase = "connecting";
	#lastSettled: VoiceItem | null = null;
	#seq = 0;
	#stats: VoiceStats;
	#unsubFrame: () => void;
	#unsubSnapshot: () => void;
	#idleTimer: Timer;

	constructor(client: GuestClient, options: VoiceMonitorOptions = {}) {
		this.#client = client;
		this.#settings = options.settings ?? loadVoiceSettings();
		this.#recordStore = options.recordStore ?? new VoiceRecordStore();
		this.#adapter = new VoiceEventAdapter({
			sessionKey: () => this.#sessionKey,
			settings: () => this.#settings,
			idleFlushMs: options.idleFlushMs,
		});
		this.#queue = new SpeechQueue({
			onItemStatus: item => this.#onItemSettled(item),
			onChange: () => {
				this.#engine?.poke();
				this.#refreshStats();
			},
		});
		const backend = options.backend !== undefined ? options.backend : ttsAvailable() ? new WebSpeechBackend() : null;
		this.#engine =
			backend !== null
				? new SpeechEngine(this.#queue, backend, {
						settings: () => this.#settings,
						onStatus: () => this.#refreshStats(),
					})
				: null;
		this.#unsubFrame = this.#client.addFrameObserver(frame => this.#onFrame(frame));
		this.#unsubSnapshot = this.#client.subscribe(() => this.#onPhaseTransition());
		this.#idleTimer = setInterval(() => this.#route(this.#adapter.flushIdle()), IDLE_CHECK_MS);
		this.#stats = this.#computeStats();
		if (options.recordStore === undefined && this.#settings.persistRecords) this.#openStore();
	}

	#openStore(): void {
		void this.#recordStore.open().then(available => {
			if (!available) this.#storageBroken = true;
			else this.#flushDeferred();
			this.#refreshStats();
		});
	}

	// ── public control ───────────────────────────────────────────────────────

	/** Arm speech. MUST be called from a user gesture (browser autoplay policy). */
	arm(): void {
		if (this.#armed) return;
		this.#armed = true;
		this.#engine?.start();
		this.#refreshStats();
	}

	disarm(): void {
		if (!this.#armed) return;
		this.#armed = false;
		this.#engine?.stop();
		this.#refreshStats();
	}

	get armed(): boolean {
		return this.#armed;
	}

	pause(): void {
		this.#engine?.pause();
		this.#refreshStats();
	}

	resume(): void {
		this.#engine?.resume();
		this.#refreshStats();
	}

	get paused(): boolean {
		return this.#engine?.paused ?? false;
	}

	skip(): void {
		if (this.#engine !== null) {
			this.#engine.skip();
		} else {
			this.#queue.skipCurrent();
		}
		this.#refreshStats();
	}

	/** Re-queue the most recently finished item ("read again"). */
	requeueLast(): void {
		if (this.#lastSettled !== null) this.#queue.requeue(this.#lastSettled);
		if (this.#armed) this.#engine?.start();
		this.#refreshStats();
	}

	/** Queue the last `count` registered events (explicit user action). */
	readHistory(count?: number, useDetail = false): number {
		const n = Math.max(1, Math.min(count ?? this.#settings.historyReadCount, this.#registry.length));
		// `seq` keeps repeated presses distinct: each press re-narrates, the
		// queue's id-dedup only guards against transport resync duplicates.
		// `minimal` re-narrates milestones only; the full-detail read is the
		// escape hatch for what milestones mode silenced, so it never filters.
		const selected = this.#registry
			.slice(this.#registry.length - n)
			.filter(event => useDetail || this.#settings.verbosity !== "minimal" || isMilestone(event));
		const events = selected.map(event => ({
			...event,
			id: `hist:${event.id}:${++this.#seq}`,
			text: this.#narrationText(event, useDetail),
		}));
		const added = this.#queue.enqueue(events, this.#sessionKey);
		if (added.length > 0 && this.#armed) this.#engine?.start();
		this.#refreshStats();
		return added.length;
	}

	/** Explicit clear of everything not yet spoken; every item recorded as skipped. */
	clearPending(): number {
		// The in-flight utterance is part of the queue: stop the speaker before
		// the item is dropped, or the engine stays stuck on dead text.
		this.#engine?.abandon();
		const cleared = this.#queue.clearPending();
		this.#refreshStats();
		return cleared;
	}

	updateSettings(patch: Partial<VoiceSettings>): void {
		Object.assign(this.#settings, patch);
		this.#settings.rate = Math.min(2, Math.max(0.5, this.#settings.rate));
		saveVoiceSettings(this.#settings);
		if (patch.verbosity === "minimal") {
			// The switch takes effect immediately: chatter already queued under a
			// denser setting is dropped (each recorded as skipped) rather than
			// spoken. Items that are milestones keep their slot.
			this.#queue.prunePending(item => isMilestoneItem(item));
		}
		if (patch.persistRecords === true && !this.#recordStore.available && !this.#recordStore.failed) {
			this.#storageBroken = false;
			this.#openStore();
		}
		this.#refreshStats();
	}

	get settings(): Readonly<VoiceSettings> {
		return this.#settings;
	}

	voices(): VoiceSpec[] {
		return this.#engine?.voices() ?? [];
	}

	onVoicesChanged(cb: () => void): () => void {
		return this.#engine?.onVoicesChanged(cb) ?? ((): void => {});
	}

	/** Whether settled records persist (IndexedDB) or only live in RAM. */
	get storageMode(): "idb" | "memory" | "off" {
		if (!this.#settings.persistRecords) return "off";
		if (this.#recordStore.available) return "idb";
		return this.#storageBroken ? "memory" : "off";
	}

	get registrySize(): number {
		return this.#registry.length;
	}

	/** Clear stored history for this session and drop the in-memory registry. */
	clearSessionHistory(): void {
		this.#registry.length = 0;
		this.#deferredRecords.length = 0;
		void this.#recordStore.clearSession(this.#sessionKey);
		this.#refreshStats();
	}

	// ── UI store contract ────────────────────────────────────────────────────

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	getStats = (): VoiceStats => this.#stats;

	dispose(): void {
		this.#unsubFrame();
		this.#unsubSnapshot();
		clearInterval(this.#idleTimer);
		this.#engine?.stop();
		this.#recordStore.close();
		this.#listeners.clear();
	}

	// ── internals ────────────────────────────────────────────────────────────

	#onFrame(frame: HostFrame): void {
		if (frame.t === "welcome" && frame.header?.id) {
			const key = deriveSessionKey(frame.header.id);
			if (key !== this.#sessionKey) {
				// Session isolation: a different OMP session never reuses the
				// previous session's cursors, backlog or buffered registry.
				// Cleared items settle before the key changes, so their records
				// stay attributed to the session they belong to.
				this.#engine?.abandon();
				this.#queue.clearPending();
				this.#registry.length = 0;
				this.#adapter.resetSession();
				this.#sessionKey = key;
			}
		}
		this.#route(this.#adapter.onFrame(frame));
	}

	#onPhaseTransition(): void {
		const snapshot = this.#client.getSnapshot();
		const phase = snapshot.phase;
		if (phase === this.#lastPhase) return;
		this.#lastPhase = phase;
		if (phase === "reconnecting") {
			this.#route([this.#synthEvent("session-disconnected", sessionVoice("reconnecting"), "warning")]);
		} else if (phase === "ended" && !this.#adapter.byeSeen) {
			// Ended without a bye frame (welcome timeout / terminal socket error).
			this.#route([
				this.#synthEvent("session-ended", sessionVoice("ended", undefined, snapshot.endedReason), "warning"),
			]);
		}
		this.#refreshStats();
	}

	#route(events: VoiceEvent[]): void {
		if (events.length === 0) return;
		for (const event of events) {
			this.#registry.push(event);
			if (this.#registry.length > REGISTRY_CAP) {
				const evicted = this.#registry.shift();
				if (evicted !== undefined)
					this.#persist({
						...recordFromItem(this.#sessionKey, { ...evicted, status: "spoken" }),
						status: "recorded",
					});
			}
		}
		// Recording always happens; only playback is gated by activation and
		// verbosity. The adapter's cursors advanced meanwhile, so arming starts
		// from "now", never from a recital of everything registered while off.
		if (this.#armed) {
			let narratable = events;
			if (this.#settings.verbosity === "minimal") {
				// Milestones only; the registry above keeps every event, so the
				// dropped ones are still readable through the detail actions.
				narratable = events
					.filter(event => isMilestone(event))
					.map(event => ({
						...event,
						text: this.#narrationText(event),
					}));
			}
			if (narratable.length > 0) this.#queue.enqueue(narratable, this.#sessionKey);
		}
		this.#refreshStats();
	}

	/**
	 * Spoken text for a recorded event. `minimal` turns a turn close into its
	 * verdict headline; `useDetail` speaks the full payload instead of the
	 * short line (the "read in detail" action).
	 */
	#narrationText(event: VoiceEvent, useDetail = false): string {
		if (useDetail) return event.detail ?? event.text;
		if (this.#settings.verbosity === "minimal" && event.category === "turn-end" && event.detail !== undefined)
			return verdictVoice(event.detail);
		return event.text;
	}

	#onItemSettled(item: VoiceItem): void {
		this.#lastSettled = item;
		if (item.status === "spoken") this.#spoken++;
		else if (item.status === "failed") this.#failed++;
		this.#persist(recordFromItem(this.#sessionKey, item));
	}

	#persist(record: VoiceRecord): void {
		if (!this.#settings.persistRecords) return;
		void this.#recordStore.put(record).then(ok => {
			if (ok) return;
			if (this.#recordStore.failed) {
				this.#storageBroken = true;
				this.#refreshStats();
				return;
			}
			// DB still opening: buffer so early events are not lost.
			this.#deferredRecords.push(record);
			if (this.#deferredRecords.length > DEFERRED_CAP) this.#deferredRecords.shift();
		});
	}

	#flushDeferred(): void {
		const pending = this.#deferredRecords.splice(0, this.#deferredRecords.length);
		for (const record of pending) void this.#recordStore.put(record);
	}

	#synthEvent(category: VoiceCategory, text: string, level: VoiceEvent["level"] = "info"): VoiceEvent {
		return {
			id: `phase:${category}:${fnv1a(text)}:${++this.#seq}`,
			sessionKey: this.#sessionKey,
			category,
			source: "main",
			timestamp: Date.now(),
			level,
			text,
		};
	}

	#computeStats(): VoiceStats {
		const queueStats = this.#queue.stats(this.#settings.rate);
		let status: VoiceEngineStatus;
		if (this.#engine === null) status = "no-tts";
		else status = !this.#armed ? "off" : this.#engine.status;
		return {
			armed: this.#armed,
			paused: this.#paused(),
			pending: queueStats.pending,
			spoken: this.#spoken,
			failed: this.#failed,
			lagMs: queueStats.lagMs,
			status,
			current: queueStats.currentText,
		};
	}

	#paused(): boolean {
		return this.#engine?.paused ?? false;
	}

	#refreshStats(): void {
		this.#stats = this.#computeStats();
		for (const listener of this.#listeners) listener();
	}
}
