import { describe, expect, it } from "bun:test";
import {
	boundedOutput,
	compactionEndVoice,
	compactionStartVoice,
	entryVoice,
	lifecycleVoice,
	messageVoice,
	noticeVoice,
	retryVoice,
	sessionVoice,
	thinkingVoice,
	toolEndVoice,
	toolStartVoice,
	uiRequestVoice,
	verdictVoice,
	voiceNormalize,
} from "../src/voice/speech-format";

describe("voiceNormalize", () => {
	it("removes ANSI sequences", () => {
		expect(voiceNormalize("\x1b[31merror\x1b[0m")).toBe("error");
	});

	it("collapses fenced code blocks to a spoken marker without the body", () => {
		const out = voiceNormalize("antes\n```ts\nconst secreto = 1;\n```\ndespués");
		expect(out).toContain("(code fragment)");
		expect(out).not.toContain("secreto");
	});

	it("keeps link labels and neutralizes bare URLs", () => {
		expect(voiceNormalize("mira [la doc](https://example.com) y https://otro.example/x")).toBe(
			"mira la doc y (link)",
		);
	});

	it("strips markdown structure without changing words", () => {
		expect(voiceNormalize("## Título\n- punto *uno* **dos** `código`")).toBe("Título punto uno dos código");
	});

	it("removes HTML tags (wire content is never executed as markup)", () => {
		expect(voiceNormalize("<script>alert(1)</script> texto")).toBe("alert(1) texto");
	});

	it("reads underscores inside identifiers as spaces", () => {
		expect(voiceNormalize("bpm_detector.py")).toBe("bpm detector.py");
	});

	it("drops emoji noise", () => {
		expect(voiceNormalize("listo ✅")).toBe("listo");
	});
});

describe("boundedOutput", () => {
	it("speaks short payloads whole", () => {
		expect(boundedOutput("una línea corta")).toBe("output: una línea corta");
	});

	it("summarizes long payloads by line count and prefers error lines", () => {
		const long = ["info 1", "info 2", "Error: fallo grave", "otra info"]
			.concat(Array.from({ length: 40 }, (_, i) => `ruido ${i}`))
			.join("\n");
		const out = boundedOutput(long);
		expect(out).toContain("44 lines");
		expect(out).toContain("first errors");
		expect(out).toContain("fallo grave");
		expect(out.length).toBeLessThanOrEqual(280);
		expect(out).not.toContain("ruido 9");
	});

	it("reports empty payloads as empty", () => {
		expect(boundedOutput("   \n  ")).toBe("output empty");
	});
});

describe("tool narration", () => {
	it("maps known tools to English phrases with arg previews", () => {
		expect(toolStartVoice("read", { path: "src/app.tsx" })).toBe("Reading src/app.tsx");
		expect(toolStartVoice("bash", { command: "bun test --parallel" })).toBe("Running bun test --parallel");
		expect(toolStartVoice("todo", {})).toBe("Updating the task list");
	});

	it("prefers the model's own intent when present", () => {
		expect(toolStartVoice("edit", { path: "a.ts" }, "arreglar el bug de login")).toBe(
			"Editing: arreglar el bug de login",
		);
	});

	it("falls back gracefully for unknown tools", () => {
		expect(toolStartVoice("lsp", { path: "x.ts" })).toBe("Querying the code x.ts");
		expect(toolStartVoice("herramienta-nueva", { path: "x.ts" })).toBe("Using tool herramienta-nueva x.ts");
		expect(toolStartVoice("herramienta-nueva", null)).toBe("Using tool herramienta-nueva");
	});

	it("ends tools with English outcome lines", () => {
		expect(toolEndVoice("read", "hola", false)).toBe("Read complete: hola");
		expect(toolEndVoice("read", "", false)).toBe("Read complete");
		expect(toolEndVoice("bash", "exit code 1\nError: algo falló", false)).toBe(
			"Command finished. output: exit code 1 Error: algo falló",
		);
	});

	it("marks failures as errors with bounded detail", () => {
		const out = toolEndVoice("edit", `Traceback: ${"muy largo ".repeat(100)}`, true);
		expect(out).toStartWith("Error in edit.");
		expect(out.length).toBeLessThan(260);
	});
});

describe("session and lifecycle lines", () => {
	it("notices carry level prefixes", () => {
		expect(noticeVoice("warning", "contexto casi lleno")).toBe("Warning: contexto casi lleno");
		expect(noticeVoice("error", "socket cerrado")).toBe("Error: socket cerrado");
	});

	it("retries state attempts", () => {
		expect(retryVoice(2, 5, "timeout")).toBe("Retry 2 of 5: timeout");
	});

	it("compaction lines are explicit", () => {
		expect(compactionStartVoice("context-full", "manual")).toBe(
			"OMP started context compaction because the context is full.",
		);
		expect(compactionStartVoice("manual", "manual")).toBe("OMP started context compaction.");
		expect(compactionEndVoice({ aborted: false })).toBe("Compaction finished.");
		expect(compactionEndVoice({ aborted: true })).toBe("Compaction aborted.");
		expect(compactionEndVoice({ aborted: false, skipped: true })).toBeNull();
		expect(compactionEndVoice({ aborted: false, errorMessage: "resumen vacío" })).toBe(
			"Compaction error: resumen vacío",
		);
	});

	it("subagent lifecycle is narrated with labels", () => {
		expect(lifecycleVoice("started", "scout")).toBe("Subagent started scout.");
		expect(lifecycleVoice("failed", "")).toBe("The subagent failed.");
	});

	it("session history lines state that old history is not recited", () => {
		expect(sessionVoice("history", 12)).toBe("History loaded: 12 recorded events. Narration starts from now.");
		expect(sessionVoice("recovered", 0)).toBe("Reconnection complete.");
		expect(sessionVoice("ended", undefined, "host left")).toBe("The session has ended: host left.");
	});

	it("user messages are labeled and bounded", () => {
		expect(messageVoice("user", "hola")).toBe("User message: hola");
		const long = messageVoice("user", "x".repeat(1000));
		expect(long).toContain("…");
		expect(long.length).toBeLessThanOrEqual("User message: ".length + 601);
	});

	it("thinking is labeled", () => {
		expect(thinkingVoice("voy a leer")).toBe("Reasoning: voy a leer");
	});

	it("unknown entry types fall back to a tolerant line", () => {
		expect(entryVoice("brand_new_type", null)).toBe("Event of type brand_new_type.");
		expect(entryVoice("model_change", "openai/gpt")).toBe("The model changed to openai/gpt.");
	});

	it("ui requests announce the agent needs an answer", () => {
		expect(uiRequestVoice({ kind: "select", title: "¿elijo A o B?" })).toContain("The agent requests an answer");
	});
});

describe("turn verdict (milestones mode)", () => {
	it("speaks the first sentence of the turn's final message", () => {
		expect(verdictVoice("The bug was a stale cache. Details follow in the plan.")).toBe(
			"Turn complete. verdict: The bug was a stale cache.",
		);
		expect(verdictVoice("Should I rename it? Then renaming now.")).toBe(
			"Turn complete. verdict: Should I rename it?",
		);
	});

	it("closes an unterminated sentence and caps an overlong one", () => {
		expect(verdictVoice("the suite is green")).toBe("Turn complete. verdict: the suite is green.");
		const long = "a".repeat(250);
		expect(verdictVoice(`${long}. second sentence.`)).toBe(`Turn complete. verdict: ${"a".repeat(199)}…`);
	});

	it("an empty final message still closes the turn", () => {
		expect(verdictVoice("   \n  ")).toBe("Turn complete.");
	});
});
