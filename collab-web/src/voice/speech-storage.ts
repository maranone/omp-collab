/**
 * Persistence layer for the voice monitor.
 *
 * Two parts:
 * 1. Settings in localStorage — validated against defaults, no secrets.
 * 2. Settled speech records in IndexedDB — bounded by a TTL, keyed by a
 *    derived, secret-free session key (FNV hash of the session header id),
 *    isolated per session/room.
 *
 * The queue's FIFO is NEVER persisted as a requirement: loss of an unfinished
 * FIFO is acceptable only for expired/cleared sessions; pending items live in
 * RAM unbounded during a live session (bounded by session activity itself),
 * and every finished item is recorded here. If IndexedDB is unavailable the
 * monitor falls back to its in-memory registry and says so — never silently.
 */

import { DEFAULT_VOICE_SETTINGS, type VoiceItem, type VoiceSettings } from "./types";

export const SETTINGS_STORAGE_KEY = "omp.collab.voice.settings";
export const VOICE_DB_NAME = "omp.collab.voice";
export const VOICE_DB_VERSION = 1;
export const VOICE_STORE = "items";
/** Settled records expire after this much time. */
export const RECORD_TTL_MS = 72 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// Settings (localStorage)
// ═══════════════════════════════════════════════════════════════════════════

export function loadVoiceSettings(): VoiceSettings {
	const settings = { ...DEFAULT_VOICE_SETTINGS };
	try {
		const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SETTINGS_STORAGE_KEY) : null;
		if (raw === null) return settings;
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return settings;
		const candidate: Record<string, unknown> = parsed;
		if (typeof candidate.speakUserMessages === "boolean") settings.speakUserMessages = candidate.speakUserMessages;
		if (typeof candidate.speakThinking === "boolean") settings.speakThinking = candidate.speakThinking;
		if (candidate.verbosity === "normal" || candidate.verbosity === "verbose")
			settings.verbosity = candidate.verbosity;
		if (typeof candidate.rate === "number" && candidate.rate >= 0.5 && candidate.rate <= 2)
			settings.rate = candidate.rate;
		if (typeof candidate.voiceName === "string" || candidate.voiceName === null)
			settings.voiceName = candidate.voiceName;
		if (
			typeof candidate.historyReadCount === "number" &&
			candidate.historyReadCount >= 1 &&
			candidate.historyReadCount <= 500
		)
			settings.historyReadCount = Math.round(candidate.historyReadCount);
		if (typeof candidate.persistRecords === "boolean") settings.persistRecords = candidate.persistRecords;
	} catch {
		// corrupt settings → defaults; the voice layer must never crash the page
	}
	return settings;
}

export function saveVoiceSettings(settings: VoiceSettings): void {
	try {
		localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// private mode / quota: settings simply do not survive the session
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Settled records (IndexedDB)
// ═══════════════════════════════════════════════════════════════════════════

export interface VoiceRecord {
	/** `${sessionKey}:${itemId}` — primary key, session-isolated. */
	key: string;
	sessionKey: string;
	itemId: string;
	category: string;
	source: string;
	level: string | null;
	status: string;
	text: string;
	timestamp: number;
	/** Wall-clock time the record was written; used for TTL purge. */
	writtenAt: number;
}

/** Accepts queue items and registry events: only the record-bearing fields are required. */
export function recordFromItem(
	sessionKey: string,
	item: Pick<VoiceItem, "id" | "category" | "source" | "level" | "text" | "status" | "timestamp">,
): VoiceRecord {
	return {
		key: `${sessionKey}:${item.id}`,
		sessionKey,
		itemId: item.id,
		category: item.category,
		source: item.source,
		level: item.level ?? null,
		status: item.status,
		text: item.text,
		timestamp: item.timestamp,
		writtenAt: Date.now(),
	};
}

export class VoiceRecordStore {
	#db: IDBDatabase | null = null;
	#failed = false;

	get available(): boolean {
		return this.#db !== null;
	}

	get failed(): boolean {
		return this.#failed;
	}

	/** Open + purge expired records. Returns availability. */
	async open(ttlMs: number = RECORD_TTL_MS): Promise<boolean> {
		if (this.#db !== null) return true;
		if (typeof indexedDB === "undefined") {
			this.#failed = true;
			return false;
		}
		const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
		const request = indexedDB.open(VOICE_DB_NAME, VOICE_DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(VOICE_STORE)) {
				const store = db.createObjectStore(VOICE_STORE, { keyPath: "key" });
				store.createIndex("sessionKey", "sessionKey");
				store.createIndex("writtenAt", "writtenAt");
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("indexeddb open failed"));
		request.onblocked = () => reject(new Error("indexeddb blocked"));
		try {
			this.#db = await promise;
			await this.#purgeExpired(ttlMs);
			return true;
		} catch {
			this.#failed = true;
			this.#db = null;
			return false;
		}
	}

	async put(record: VoiceRecord): Promise<boolean> {
		const db = this.#db;
		if (db === null) return false;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const tx = db.transaction(VOICE_STORE, "readwrite");
		tx.objectStore(VOICE_STORE).put(record);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error("put failed"));
		try {
			await promise;
			return true;
		} catch {
			return false;
		}
	}

	/** Delete every record of one derived session key. Returns count removed. */
	async clearSession(sessionKey: string): Promise<number> {
		const db = this.#db;
		if (db === null) return 0;
		const { promise, resolve, reject } = Promise.withResolvers<number>();
		const tx = db.transaction(VOICE_STORE, "readwrite");
		const index = tx.objectStore(VOICE_STORE).index("sessionKey");
		let removed = 0;
		const cursorRequest = index.openCursor(IDBKeyRange.only(sessionKey));
		cursorRequest.onsuccess = () => {
			const cursor = cursorRequest.result;
			if (cursor === null) {
				resolve(removed);
				return;
			}
			cursor.delete();
			removed++;
			cursor.continue();
		};
		cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("clear failed"));
		tx.onerror = () => reject(tx.error ?? new Error("clear failed"));
		try {
			return await promise;
		} catch {
			return 0;
		}
	}

	close(): void {
		this.#db?.close();
		this.#db = null;
	}

	async #purgeExpired(ttlMs: number): Promise<void> {
		const db = this.#db;
		if (db === null) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		const cutoff = Date.now() - ttlMs;
		const tx = db.transaction(VOICE_STORE, "readwrite");
		const index = tx.objectStore(VOICE_STORE).index("writtenAt");
		const request = index.openCursor(IDBKeyRange.upperBound(cutoff, true));
		request.onsuccess = () => {
			const cursor = request.result;
			if (cursor === null) {
				resolve();
				return;
			}
			cursor.delete();
			cursor.continue();
		};
		request.onerror = () => resolve();
		tx.onerror = () => resolve();
		return promise;
	}
}

/**
 * Derived local session key: FNV hash of the OMP session header id. Not the
 * room id and not any secret material — just a stable bucket id so history
 * from one room/OMP session is never mixed with another.
 */
export function deriveSessionKey(headerId: string | null | undefined): string {
	if (!headerId) return "anon";
	let h = 0x811c9dc5;
	for (let i = 0; i < headerId.length; i++) {
		h ^= headerId.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `s-${h.toString(16).padStart(8, "0")}`;
}
