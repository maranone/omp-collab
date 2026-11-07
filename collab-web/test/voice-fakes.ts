/** Shared deterministic fakes for the voice test suites (not a test file itself). */

import type { SpeakHandle, SpeakSpec, TtsBackend, VoiceSpec } from "../src/voice/speech-engine";
import { VoiceRecordStore, type VoiceRecord } from "../src/voice/speech-storage";

/** Controllable TTS backend: completes, hangs (never resolves), always fails, throws synchronously, or is absent. */
export class FakeBackend implements TtsBackend {
	readonly started: string[] = [];
	readonly canceled: string[] = [];
	mode: "auto" | "hang" | "fail" | "throw" | "none" = "auto";

	listVoices(): VoiceSpec[] {
		return [
			{ name: "Google US English", lang: "en-US" },
			{ name: "Marisol (español)", lang: "es-ES" },
		];
	}
	onVoicesChanged(): () => void {
		return () => {};
	}
	speak(spec: SpeakSpec, onDone: (ok: boolean, error?: string) => void): SpeakHandle | null {
		this.started.push(spec.text);
		const cancel = (): void => {
			this.canceled.push(spec.text);
		};
		if (this.mode === "none") return null;
		if (this.mode === "throw") throw new Error("speak rejected the utterance");
		if (this.mode === "hang") return { cancel };
		if (this.mode === "fail") {
			setTimeout(() => onDone(false, "provider down"), 0);
			return { cancel };
		}
		setTimeout(() => onDone(true), 0);
		return { cancel };
	}
}

/** Record store that keeps everything in RAM and reports itself available. */
export class FakeRecordStore extends VoiceRecordStore {
	records: VoiceRecord[] = [];

	override get available(): boolean {
		return true;
	}
	override get failed(): boolean {
		return false;
	}
	override async open(): Promise<boolean> {
		return true;
	}
	override async put(record: VoiceRecord): Promise<boolean> {
		this.records.push({ ...record });
		return true;
	}
	override async clearSession(sessionKey: string): Promise<number> {
		const before = this.records.length;
		this.records = this.records.filter(r => r.sessionKey !== sessionKey);
		return before - this.records.length;
	}
	override close(): void {}
}

/** WebSocket stand-in: the suites drive open/close transitions manually. */
export class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	binaryType = "";
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	readonly url: string;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	static last(): FakeWebSocket {
		const ws = FakeWebSocket.instances.at(-1);
		if (ws === undefined) throw new Error("no fake socket instance");
		return ws;
	}
	static reset(): void {
		FakeWebSocket.instances = [];
	}

	send(_data: unknown): void {}
	close(code = 1000): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code, reason: "" });
	}
	/** Simulate the relay completing the handshake. */
	accept(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
	/** Simulate the relay dropping the guest (1006 = abnormal closure). */
	drop(code = 1006): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code, reason: "" });
	}
}
