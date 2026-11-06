/**
 * Pure diff primitives the event adapter uses to turn snapshots/frames into
 * real deltas: no re-narration of prefixes, stable session-key hashing, and
 * sentence-boundary splitting for streaming text.
 */

/** FNV-1a 32-bit hash → 8 hex chars. Non-cryptographic; used to derive a local, secret-free session key. */
export function fnv1a(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * Diff an accumulating full-text against what has already been spoken.
 * `full` normally extends `spoken` (streaming). When it does not (the host
 * replaced or rewound the message), only the common prefix is considered
 * already spoken; `replacement` flags that the remaining text diverges.
 */
export function prefixDiff(spoken: string, full: string): { newText: string; replacement: boolean } {
	let common = 0;
	const max = Math.min(spoken.length, full.length);
	while (common < max && spoken.charCodeAt(common) === full.charCodeAt(common)) common++;
	const newText = full.slice(common);
	return { newText, replacement: common < spoken.length };
}

const MIN_SENTENCE_CHARS = 3;

/**
 * Split a growing buffer into speakable sentences and a remainder.
 * Only complete sentences (terminal punctuation followed by whitespace, or a
 * blank-line paragraph break) are released; partial words/tokens — including a
 * terminal punctuation still at the buffer end — stay in `rest` so speech never
 * speaks subword fragments. The caller speaks the remainder when the stream ends.
 */
export function sentenceSplit(buffer: string): { complete: string[]; rest: string } {
	const complete: string[] = [];
	let start = 0;
	let cursor = 0;
	while (cursor < buffer.length) {
		const ch = buffer.charAt(cursor);
		if (ch === "\n" && buffer.charAt(cursor + 1) === "\n") {
			const chunk = buffer.slice(start, cursor + 1);
			if (chunk.trim().length >= MIN_SENTENCE_CHARS) complete.push(chunk.trim());
			cursor += 2;
			start = cursor;
			continue;
		}
		if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
			// Consume any closing quotes/brackets and the following whitespace.
			let end = cursor + 1;
			while (end < buffer.length && "\"')]»".includes(buffer.charAt(end))) end++;
			if (end < buffer.length && /\s/.test(buffer.charAt(end))) {
				const chunk = buffer.slice(start, end + 1);
				if (chunk.trim().length >= MIN_SENTENCE_CHARS) complete.push(chunk.trim());
				end++;
				while (end < buffer.length && /\s/.test(buffer.charAt(end))) end++;
				cursor = end;
				start = end;
				continue;
			}
		}
		cursor++;
	}
	return { complete, rest: buffer.slice(start) };
}

/** Collapse whitespace runs to single spaces and trim. */
export function collapse(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/**
 * Count characters the engine will actually speak; used for lag estimates.
 * Matches the engine's own approximation so the UI delay matches reality.
 */
export function estimateSpeakMs(text: string, rate: number): number {
	const cps = 15 * Math.max(0.5, rate);
	return Math.max(400, Math.round((text.length / cps) * 1000));
}
