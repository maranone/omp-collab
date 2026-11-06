import { afterEach, describe, expect, it } from "bun:test";
import {
	deriveSessionKey,
	loadVoiceSettings,
	RECORD_TTL_MS,
	recordFromItem,
	SETTINGS_STORAGE_KEY,
	saveVoiceSettings,
} from "../src/voice/speech-storage";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/types";
import type { VoiceItem } from "../src/voice/types";

// Bun's test runner has no DOM: provide a minimal in-memory Web Storage so the
// settings codec runs exactly as it does in the browser.
class MemoryStorage {
	#map = new Map<string, string>();
	get length(): number {
		return this.#map.size;
	}
	key(index: number): string | null {
		return [...this.#map.keys()][index] ?? null;
	}
	getItem(key: string): string | null {
		return this.#map.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.#map.set(key, String(value));
	}
	removeItem(key: string): void {
		this.#map.delete(key);
	}
	clear(): void {
		this.#map.clear();
	}
}

Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true, writable: true });

afterEach(() => {
	localStorage.removeItem(SETTINGS_STORAGE_KEY);
});

describe("voice settings persistence", () => {
	it("defaults apply when nothing was saved (transcripts are NOT stored by default)", () => {
		localStorage.removeItem(SETTINGS_STORAGE_KEY);
		expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
		expect(DEFAULT_VOICE_SETTINGS.persistRecords).toBe(false);
	});

	it("round-trips user changes", () => {
		saveVoiceSettings({
			...DEFAULT_VOICE_SETTINGS,
			rate: 1.55,
			verbosity: "verbose",
			speakThinking: true,
			persistRecords: true,
			historyReadCount: 12,
			voiceName: "Marisol (español)",
		});
		const loaded = loadVoiceSettings();
		expect(loaded.rate).toBe(1.55);
		expect(loaded.verbosity).toBe("verbose");
		expect(loaded.speakThinking).toBe(true);
		expect(loaded.persistRecords).toBe(true);
		expect(loaded.historyReadCount).toBe(12);
		expect(loaded.voiceName).toBe("Marisol (español)");
	});

	it("corrupt payloads fall back to defaults instead of crashing", () => {
		localStorage.setItem(SETTINGS_STORAGE_KEY, "{no es json");
		expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
		localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(["sorpresa"]));
		expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
	});

	it("out-of-range or wrong-typed fields are ignored individually", () => {
		localStorage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({
				rate: 99,
				verbosity: "turbo",
				historyReadCount: 0,
				persistRecords: "sí",
				voiceName: 7,
				speakThinking: 1,
			}),
		);
		expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
	});

	it("valid values are normalized (bounded rate, rounded counts)", () => {
		localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ rate: 2, historyReadCount: 4.6 }));
		const loaded = loadVoiceSettings();
		expect(loaded.rate).toBe(2);
		expect(loaded.historyReadCount).toBe(5);
	});
});

describe("record keys and TTL", () => {
	it("records expire after 72 hours", () => {
		expect(RECORD_TTL_MS).toBe(72 * 60 * 60 * 1000);
	});

	it("deriveSessionKey is deterministic, distinct per session, and never leaks the raw id", () => {
		expect(deriveSessionKey("sesion-abc")).toBe(deriveSessionKey("sesion-abc"));
		expect(deriveSessionKey("sesion-abc")).not.toBe(deriveSessionKey("sesion-xyz"));
		expect(deriveSessionKey("sesion-abc")).not.toContain("sesion-abc");
		expect(deriveSessionKey(null)).toBe("anon");
		expect(deriveSessionKey(undefined)).toBe("anon");
	});

	it("recordFromItem maps items with session-isolated primary keys", () => {
		const item: VoiceItem = {
			id: "evt-1",
			sessionId: "raw-session-id",
			category: "tool-end",
			source: "sub-a",
			timestamp: 1_730_000_000_000,
			level: "warning",
			text: "Error en grep",
			status: "failed",
		};
		const record = recordFromItem("s-key", item);
		expect(record.key).toBe("s-key:evt-1");
		expect(record.sessionKey).toBe("s-key"); // raw session id never used as key
		expect(record.itemId).toBe("evt-1");
		expect(record.status).toBe("failed");
		expect(record.level).toBe("warning");
		expect(record.text).toBe("Error en grep");
	});

	it("records without an explicit level default to null", () => {
		const record = recordFromItem("s", {
			id: "evt-2",
			category: "assistant-text",
			source: "main",
			timestamp: 1,
			text: "hola",
			status: "spoken",
		});
		expect(record.level).toBeNull();
	});
});
