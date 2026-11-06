/** Shared wire-typed frame fixtures for the voice tests (not a test file itself). */

import type {
	AgentEvent,
	AssistantMessage,
	HostFrame,
	MessageEntry,
	SessionEntry,
	SessionHeader,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-wire";
import { COLLAB_PROTO } from "../src/lib/link";

export const VOICE_HEADER: SessionHeader = {
	type: "session",
	id: "voice-test-session",
	timestamp: "2026-11-06T00:00:00.000Z",
	cwd: "/tmp/voice",
};

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };

export function voiceWelcome(entryCount = 0, header: SessionHeader = VOICE_HEADER): HostFrame {
	return {
		t: "welcome",
		proto: COLLAB_PROTO,
		header,
		state: { isStreaming: false, queuedMessageCount: 0, cwd: header.cwd, participants: [] },
		agents: [
			{
				id: "main",
				displayName: "main",
				kind: "main",
				status: "idle",
				hasSessionFile: false,
				createdAt: 0,
				lastActivity: 0,
			},
		],
		entryCount,
	};
}

export function voiceChunk(entries: SessionEntry[], final = true): HostFrame {
	return { t: "snapshot-chunk", entries, final };
}

export function voiceEntry(entry: SessionEntry): HostFrame {
	return { t: "entry", entry };
}

export function voiceEvent(event: AgentEvent): HostFrame {
	return { t: "event", event };
}

export function voiceBus(channel: "task:subagent:progress" | "task:subagent:lifecycle", data: unknown): HostFrame {
	return { t: "bus", channel, data };
}

export function msgEntry(id: string, message: UserMessage | AssistantMessage | ToolResultMessage): MessageEntry {
	return { id, parentId: null, timestamp: "2026-11-06T00:00:00.000Z", type: "message", message };
}

export function userText(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

export function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test/model",
		usage: USAGE,
		stopReason: "stop",
		timestamp: 2,
	};
}

export function toolResultMsg(toolCallId: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 3 };
}
