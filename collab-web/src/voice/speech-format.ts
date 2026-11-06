/**
 * Deterministic English speech formatter. Observable session text (assistant
 * messages, tool output, user messages) is spoken verbatim; only events the
 * wire does not carry in words — tool lifecycle, subagents, compaction,
 * connection state — get fixed English wording. No external service or model call.
 *
 * Hard rule: wire content is untrusted text. Nothing here executes, fetches,
 * or interprets it beyond making it speakable.
 */

import { collapse } from "./event-diff";

// ═══════════════════════════════════════════════════════════════════════════
// Text normalization for intelligibility (never for meaning)
// ═══════════════════════════════════════════════════════════════════════════

const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const FENCE_RE = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\1[^\n]*|$)/g;
const URL_RE = /https?:\/\/\S+/g;

/** Strip markdown/ANSI/HTML artifacts so TTS speaks content, not syntax. */
export function voiceNormalize(text: string): string {
	let out = text.replace(ANSI_RE, "");
	// Fenced code blocks collapse to a spoken marker; their body is never read aloud.
	out = out.replace(FENCE_RE, " (code fragment) ");
	// Links keep their label; bare URLs become a neutral token.
	out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, (_m, label: string) => label || "(link)");
	out = out.replace(URL_RE, "(link)");
	// Inline markup.
	out = out.replace(/`([^`]*)`/g, "$1");
	out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
	out = out.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1");
	out = out.replace(/^#{1,6}\s+/gm, "");
	out = out.replace(/^\s*[-*+]\s+/gm, "");
	out = out.replace(/^\s*>\s?/gm, "");
	out = out.replace(/~~/g, "");
	out = out.replace(/\$+([^$\n]+)\$+/g, "$1");
	// HTML tags are stripped; content between them is plain text.
	out = out.replace(/<[^<>]{1,80}>/g, " ");
	// Table pipes read as pauses.
	out = out.replace(/\|/g, "  ");
	out = out.replace(/^\s*:?-{2,}:?\s*$/gm, " ");
	// Underscores inside identifiers read better as spaces ("bpm detector.py").
	out = out.replace(/([A-Za-z0-9])_([A-Za-z0-9])/g, "$1 $2");
	// Emoji/symbols TTS would garble (VS15 handled separately: it is a combining class).
	out = out.replace(/\uFE0F/g, " ");
	out = out.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ");
	return collapse(out);
}

/** Bound a long payload to a speakable summary: line count + first salient lines. */
export function boundedOutput(
	text: string,
	opts: { maxLines?: number; charBudget?: number; context?: string } = {},
): string {
	const { maxLines = 3, charBudget = 220, context = "output" } = opts;
	// Normalize per line: voiceNormalize collapses newlines, so normalizing the
	// whole payload first would destroy the line structure this summary needs.
	const lines = text
		.split(/\r?\n/)
		.map(line => voiceNormalize(line).trim())
		.filter(Boolean);
	if (lines.length === 0) return `${context} empty`;
	const whole = collapse(lines.join(" "));
	if (whole.length <= charBudget) return `${context}: ${whole}`;
	const errorLines = lines.filter(l => /(error|fail(ed|ure)?|exception|traceback|panic)/i.test(l));
	const picked = (errorLines.length > 0 ? errorLines : lines).slice(0, maxLines);
	const head = collapse(picked.join(". ")).slice(0, charBudget);
	const what = errorLines.length > 0 ? "first errors" : "first lines";
	return `${context}, ${lines.length} lines; ${what}: ${head}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool narration
// ═══════════════════════════════════════════════════════════════════════════

interface ToolVoice {
	/** Present-continuous phrase used for "started". */
	start: string;
	/** Short past phrase used for "ended ok". */
	end: string;
	/** Args keys that identify the target, in priority order. */
	argKeys: string[];
}

const TOOL_VOICES: Record<string, ToolVoice> = {
	read: { start: "Reading", end: "Read complete", argKeys: ["path", "file"] },
	edit: { start: "Editing", end: "Edit complete", argKeys: ["path", "file"] },
	write: { start: "Writing", end: "Write complete", argKeys: ["path", "file"] },
	"ast-edit": { start: "Editing", end: "Edit complete", argKeys: ["path", "file"] },
	bash: { start: "Running", end: "Command finished", argKeys: ["command", "cmd"] },
	eval: { start: "Evaluating code", end: "Evaluation finished", argKeys: ["code"] },
	glob: { start: "Searching files", end: "File search finished", argKeys: ["path", "pattern"] },
	grep: { start: "Searching text", end: "Search finished", argKeys: ["pattern", "path"] },
	"ast-grep": { start: "Searching code", end: "Search finished", argKeys: ["pattern", "path"] },
	task: { start: "Launching subagents", end: "Subagents finished", argKeys: ["context", "task"] },
	"web-search": { start: "Searching the web", end: "Web search finished", argKeys: ["query"] },
	web_search: { start: "Searching the web", end: "Web search finished", argKeys: ["query"] },
	fetch: { start: "Fetching a web page", end: "Web fetch finished", argKeys: ["url"] },
	web_fetch: { start: "Fetching a web page", end: "Web fetch finished", argKeys: ["url"] },
	browser: { start: "Browsing", end: "Browsing finished", argKeys: ["url", "action"] },
	lsp: { start: "Querying the code", end: "Query finished", argKeys: ["path", "query"] },
	todo: { start: "Updating the task list", end: "Task list updated", argKeys: [] },
	ask: { start: "Asking the user", end: "Question answered", argKeys: ["question"] },
	goal: { start: "Updating the goal", end: "Goal updated", argKeys: [] },
	github: { start: "Working on GitHub", end: "GitHub operation finished", argKeys: ["repo", "query"] },
	job: { start: "Managing a job", end: "Job managed", argKeys: ["command", "name"] },
	debug: { start: "Debugging", end: "Debug finished", argKeys: ["command"] },
	wait: { start: "Waiting for results", end: "Wait finished", argKeys: [] },
	"memory-retain": { start: "Saving to memory", end: "Memory updated", argKeys: [] },
	"memory-recall": { start: "Recalling memory", end: "Memory recalled", argKeys: [] },
	"memory-reflect": { start: "Reflecting on memory", end: "Memory reflected", argKeys: [] },
};

function argsPreview(name: string, args: unknown): string | null {
	const voice = TOOL_VOICES[name];
	const keys = voice?.argKeys ?? ["path", "file", "command", "pattern", "query", "url"];
	if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
	const rec = args as Record<string, unknown>;
	for (const key of keys) {
		const v = rec[key];
		if (typeof v !== "string" || v.length === 0) continue;
		const oneLine = collapse(v.split("\n")[0] ?? "");
		if (oneLine.length > 0) return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine;
	}
	return null;
}

/** "Reading notes.txt" style start line; prefers the model's own intent when present. */
export function toolStartVoice(name: string, args: unknown, intent?: string): string {
	const voice = TOOL_VOICES[name];
	const target = argsPreview(name, args);
	if (intent) {
		const spoken = voiceNormalize(intent);
		if (spoken) return voice ? `${voice.start}: ${spoken}` : `Using ${name}: ${spoken}`;
	}
	if (voice) return voice.argKeys.length === 0 ? voice.start : `${voice.start} ${target ?? "…"}`;
	const fallbackTarget = target ? ` ${target}` : "";
	return `Using tool ${name}${fallbackTarget}`;
}

export function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result === null || result === undefined) return "";
	if (Array.isArray(result)) {
		const parts: string[] = [];
		for (const block of result) {
			if (typeof block === "string") parts.push(block);
			else if (block && typeof block === "object") {
				const rec = block as Record<string, unknown>;
				if (typeof rec.text === "string") parts.push(rec.text);
				else if (rec.type === "image") parts.push("[image]");
			}
		}
		return parts.join("\n");
	}
	if (typeof result === "object") {
		const rec = result as Record<string, unknown>;
		for (const key of ["output", "content", "text", "message", "error"]) {
			const v = rec[key];
			if (typeof v === "string" && v.length > 0) return v;
		}
		try {
			return JSON.stringify(result);
		} catch {
			return "";
		}
	}
	return String(result);
}

/** Success/failure result line with bounded payload detail. */
export function toolEndVoice(name: string, result: unknown, isError: boolean): string {
	const voice = TOOL_VOICES[name];
	const text = resultText(result);
	if (isError) {
		const reason = text ? boundedOutput(text, { maxLines: 2, charBudget: 200, context: "detail" }) : "no detail";
		return `Error in ${name}. ${reason}`;
	}
	if (!text) return voice ? voice.end : `${name} finished`;
	if (name === "bash" || name === "eval" || name === "job" || name === "debug") {
		return `${voice?.end ?? `${name} finished`}. ${boundedOutput(text, { context: "output" })}`;
	}
	if (text.length <= 140) {
		const spoken = voiceNormalize(text);
		if (spoken) return `${voice?.end ?? `${name} finished`}: ${spoken}`;
	}
	return voice ? voice.end : `${name} finished`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Session / lifecycle lines
// ═══════════════════════════════════════════════════════════════════════════

export function noticeVoice(level: "info" | "warning" | "error", message: string): string {
	const spoken = voiceNormalize(message);
	if (level === "error") return `Error: ${spoken}`;
	if (level === "warning") return `Warning: ${spoken}`;
	return `Notice: ${spoken}`;
}

export function retryVoice(attempt: number, maxAttempts: number, errorMessage: string): string {
	return `Retry ${attempt} of ${maxAttempts}: ${voiceNormalize(errorMessage)}`;
}

export function compactionStartVoice(reason: string, action: string): string {
	if (action === "context-full" || reason === "context-full")
		return "OMP started context compaction because the context is full.";
	return "OMP started context compaction.";
}

export function compactionEndVoice(flags: {
	aborted: boolean;
	errorMessage?: string;
	skipped?: boolean;
}): string | null {
	if (flags.skipped) return null;
	if (flags.aborted) return "Compaction aborted.";
	if (flags.errorMessage) return `Compaction error: ${voiceNormalize(flags.errorMessage)}`;
	return "Compaction finished.";
}

export function messageVoice(kind: "user" | "assistant-remainder", text: string): string {
	const spoken = voiceNormalize(text);
	const bounded = spoken.length > 600 ? `${spoken.slice(0, 600)}…` : spoken;
	return kind === "user" ? `User message: ${bounded}` : bounded;
}

export function thinkingVoice(text: string): string {
	const spoken = voiceNormalize(text);
	const bounded = spoken.length > 400 ? `${spoken.slice(0, 400)}…` : spoken;
	return `Reasoning: ${bounded}`;
}

export function lifecycleVoice(status: "started" | "completed" | "failed" | "aborted", label: string): string {
	const who = label ? ` ${label}` : "";
	if (status === "started") return `Subagent started${who}.`;
	if (status === "completed") return `Subagent completed${who}.`;
	if (status === "failed") return `The subagent${who} failed.`;
	return `The subagent${who} was aborted.`;
}

export function uiRequestVoice(request: { kind: "select" | "editor"; title: string }): string {
	const title = voiceNormalize(request.title);
	return request.kind === "select" ? `The agent requests an answer: ${title}` : `The agent requests an edit: ${title}`;
}

export function entryVoice(entryType: string, detail: string | null): string {
	if (entryType === "compaction")
		return detail ? `Context compacted; ${detail} previous tokens were summarized.` : "Context compacted.";
	if (entryType === "model_change") return detail ? `The model changed to ${detail}.` : "The model changed.";
	if (entryType === "thinking_level_change")
		return detail ? `Reasoning level set to ${detail}.` : "Reasoning level changed.";
	if (entryType === "branch_summary")
		return detail
			? `Branch summary: ${boundedOutput(detail, { charBudget: 240, context: "summary" })}`
			: "Branch summary.";
	// Tolerant fallback for wire entry types this client does not render.
	return `Event of type ${entryType}.`;
}

export function sessionVoice(
	event: "connected" | "history" | "reconnecting" | "recovered" | "ended",
	count?: number,
	reason?: string | null,
): string {
	if (event === "connected") return "Connected to the session.";
	if (event === "history") return `History loaded: ${count ?? 0} recorded events. Narration starts from now.`;
	if (event === "reconnecting") return "Connection lost. Reconnecting.";
	if (event === "recovered")
		return count && count > 0
			? `Reconnection complete. ${count} events recovered during the disconnect.`
			: "Reconnection complete.";
	const plain = reason ? voiceNormalize(reason) : "";
	if (!plain) return "The session has ended.";
	return /[.!?…]$/.test(plain) ? `The session has ended: ${plain}` : `The session has ended: ${plain}.`;
}
