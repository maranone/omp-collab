import { describe, expect, it } from "bun:test";
import { collapse, estimateSpeakMs, fnv1a, prefixDiff, sentenceSplit } from "../src/voice/event-diff";

describe("prefixDiff", () => {
	it("announces only the new tail when the full text extends what was already spoken", () => {
		// Genuine streaming: the previous raw text is an exact prefix of the new one.
		const diff = prefixDiff("Analizando el archivo", "Analizando el archivo completo.");
		expect(diff.newText).toBe(" completo.");
		expect(diff.replacement).toBe(false);
	});

	it("flags divergence when the known text is not a prefix of the full text", () => {
		// The spoken "." is not the full text's " " → divergence at index 21:
		// the strict prefix rule reports a replacement even though most was shared.
		const diff = prefixDiff("Analizando el archivo.", "Analizando el archivo completo.");
		expect(diff.newText).toBe(" completo.");
		expect(diff.replacement).toBe(true);
	});

	it("never repeats a known prefix and flags divergence on replacement", () => {
		const diff = prefixDiff("Analizando el archivo.", "Analizando otra cosa.");
		// Common prefix "Analizando el" stays spoken; only the divergence is new.
		expect(diff.newText).toBe("otra cosa.");
		expect(diff.replacement).toBe(true);
	});

	it("treats a rewind as replacement even with empty remainder", () => {
		const diff = prefixDiff("Texto largo ya dicho.", "Texto");
		expect(diff.newText).toBe("");
		expect(diff.replacement).toBe(true);
	});
});

describe("sentenceSplit", () => {
	it("holds incomplete words instead of speaking subword fragments", () => {
		const split = sentenceSplit("Analiz");
		expect(split.complete).toEqual([]);
		expect(split.rest).toBe("Analiz");
	});

	it("holds a final sentence whose punctuation has no boundary yet", () => {
		// A "." at the buffer end is not a boundary: the next delta could continue
		// the same token ("v1." + "23 sigue"). The adapter speaks the remainder
		// with #emitRemainder() when the message completes.
		const split = sentenceSplit("Analizando.");
		expect(split.complete).toEqual([]);
		expect(split.rest).toBe("Analizando.");
	});

	it("keeps trailing partials in rest while releasing complete sentences", () => {
		const split = sentenceSplit("Uno. Dos. Parcial");
		expect(split.complete).toEqual(["Uno.", "Dos."]);
		expect(split.rest).toBe("Parcial");
	});

	it("does not cut on abbreviations-like dots without whitespace follow-up", () => {
		const split = sentenceSplit("el v1.23 sigue");
		expect(split.complete).toEqual([]);
		expect(split.rest).toBe("el v1.23 sigue");
	});

	it("splits on blank-line paragraph breaks", () => {
		const split = sentenceSplit("párrafo uno\n\npárrafo dos");
		expect(split.complete).toEqual(["párrafo uno"]);
		expect(split.rest).toBe("párrafo dos");
	});
});

describe("fnv1a", () => {
	it("is stable for identical input and distinct across inputs", () => {
		expect(fnv1a("session-abc")).toBe(fnv1a("session-abc"));
		expect(fnv1a("session-abc")).not.toBe(fnv1a("session-abd"));
		expect(fnv1a("session-abc")).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("estimateSpeakMs", () => {
	it("is monotonic in length and rate-aware", () => {
		expect(estimateSpeakMs("hola", 1)).toBeLessThan(estimateSpeakMs("hola ".repeat(50), 1));
		expect(estimateSpeakMs("texto largo ".repeat(30), 2)).toBeLessThan(estimateSpeakMs("texto largo ".repeat(30), 1));
	});
});

describe("collapse", () => {
	it("normalizes whitespace runs", () => {
		expect(collapse(" a \n\n b\t c ")).toBe("a b c");
	});
});
