/**
 * FIFO speech queue with an explicit consumption cursor.
 *
 * Invariants:
 * - queued items are NEVER auto-evicted or silently dropped; only explicit
 *   `clearPending()` (user action) removes them, recording each as `skipped`;
 * - `pending` is bounded by session activity, not by a cap; completed items
 *   leave the queue immediately (the monitor persists them to the registry /
 *   IndexedDB), keeping RAM bounded without losing events;
 * - dedup is id-based so a resynced snapshot can never enqueue a duplicate.
 */

import { estimateSpeakMs } from "./event-diff";
import type { VoiceEvent, VoiceItem, VoiceItemStatus } from "./types";

export interface SpeechQueueOptions {
	/** Called on every terminal transition (spoken / failed / skipped). */
	onItemStatus?: (item: VoiceItem) => void;
	/** Called whenever pending count or current item changes. */
	onChange?: () => void;
}

export interface SpeechQueueStats {
	pending: number;
	lagMs: number;
	currentText: string | null;
	totalEnqueued: number;
}

export class SpeechQueue {
	readonly #opts: SpeechQueueOptions;
	readonly #items: VoiceItem[] = [];
	readonly #deliveredIds = new Set<string>();
	#current: VoiceItem | null = null;
	#totalEnqueued = 0;

	constructor(options: SpeechQueueOptions = {}) {
		this.#opts = options;
	}

	/** Enqueue adapter events; returns the items actually queued (dups skipped). */
	enqueue(events: VoiceEvent[], sessionId: string): VoiceItem[] {
		const added: VoiceItem[] = [];
		for (const event of events) {
			if (this.#deliveredIds.has(event.id)) continue;
			this.#deliveredIds.add(event.id);
			this.#boundedIds();
			const item: VoiceItem = {
				id: event.id,
				sessionId,
				source: event.source,
				category: event.category,
				timestamp: event.timestamp,
				level: event.level,
				text: event.text,
				status: "pending",
			};
			this.#items.push(item);
			this.#totalEnqueued++;
			added.push(item);
		}
		if (added.length > 0) this.#opts.onChange?.();
		return added;
	}

	/**
	 * Item at the consumption cursor (FIFO head), or null. The head is claimed
	 * into `#current` so `#items` always holds exactly the not-yet-claimed items
	 * and a re-queued copy can never be shifted out from under the engine.
	 */
	peekNext(): VoiceItem | null {
		if (this.#current !== null) return this.#current;
		const next = this.#items.shift() ?? null;
		if (next) next.status = "speaking";
		this.#current = next;
		if (next) this.#opts.onChange?.();
		return next;
	}

	/** Finalize the claimed item and release the cursor. */
	settleCurrent(status: Exclude<VoiceItemStatus, "pending" | "speaking">): void {
		const item = this.#current;
		if (item === null) return;
		item.status = status;
		this.#current = null;
		this.#opts.onItemStatus?.(item);
		this.#opts.onChange?.();
	}

	/** Explicit skip of the in-flight item (recorded, never silently lost). */
	skipCurrent(): VoiceItem | null {
		const item = this.#current ?? this.peekNext();
		if (item === null) return null;
		this.settleCurrent("skipped");
		return item;
	}

	/**
	 * Remove all pending items after an explicit confirmation (session switch,
	 * user clear). Every removed item is recorded as `skipped`.
	 */
	clearPending(): number {
		const removed = [...this.#items];
		this.#items.length = 0;
		// The claimed head is no longer in `#items` (peekNext removed it), so
		// every item is settled exactly once.
		if (this.#current !== null) {
			removed.push(this.#current);
			this.#current = null;
		}
		for (const item of removed) {
			item.status = "skipped";
			this.#opts.onItemStatus?.(item);
		}
		if (removed.length > 0) this.#opts.onChange?.();
		return removed.length;
	}

	/** Re-queue a copy of the most recently settled item ("read again"). */
	requeue(item: VoiceItem): VoiceItem | null {
		const copy: VoiceItem = { ...item, id: `again:${item.id}:${Date.now()}`, status: "pending" };
		this.#items.unshift(copy);
		this.#opts.onChange?.();
		return copy;
	}

	get current(): VoiceItem | null {
		return this.#current;
	}

	pendingCount(): number {
		return this.#items.length;
	}

	stats(rate: number): SpeechQueueStats {
		let lag = 0;
		for (const item of this.#items) lag += estimateSpeakMs(item.text, rate);
		return {
			pending: this.#items.length,
			lagMs: lag,
			currentText: this.#current?.text ?? null,
			totalEnqueued: this.#totalEnqueued,
		};
	}

	#boundedIds(): void {
		const cap = 8000;
		if (this.#deliveredIds.size > cap) {
			const keep = [...this.#deliveredIds].slice(this.#deliveredIds.size - cap / 2);
			this.#deliveredIds.clear();
			for (const value of keep) this.#deliveredIds.add(value);
		}
	}
}
