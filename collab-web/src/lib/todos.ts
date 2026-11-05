import type { SessionEntry } from "@oh-my-pi/pi-wire";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoTask {
	content: string;
	status: TodoStatus;
}

export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parsePhases(value: unknown): TodoPhase[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const phases: TodoPhase[] = [];
	for (const rawPhase of value) {
		const phase = record(rawPhase);
		if (!phase || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return undefined;
		const tasks: TodoTask[] = [];
		for (const rawTask of phase.tasks) {
			const task = record(rawTask);
			if (!task || typeof task.content !== "string") return undefined;
			const status = task.status;
			if (
				status !== "pending" &&
				status !== "in_progress" &&
				status !== "completed" &&
				status !== "abandoned" &&
				status !== "blocked"
			) {
				return undefined;
			}
			tasks.push({ content: task.content, status });
		}
		phases.push({ name: phase.name, tasks });
	}
	return phases;
}

/** Read the newest durable TODO snapshot carried by the replicated transcript. */
export function latestTodoPhases(entries: readonly SessionEntry[]): TodoPhase[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry) continue;
		if (entry.type === "message" && entry.message.role === "toolResult") {
			if (entry.message.toolName !== "todo" || entry.message.isError) continue;
			const details = record(entry.message.details);
			if (!details || details.op === "view") continue;
			const phases = parsePhases(details.phases);
			if (phases) return phases;
		}
		if (entry.type === "custom_message" && entry.customType === "user_todo_edit") {
			const details = record(entry.details);
			const data = record((entry as unknown as Record<string, unknown>).data);
			const phases = parsePhases(details?.phases ?? data?.phases);
			if (phases) return phases;
		}
	}
	return [];
}

/** The task shown in the always-visible footer, preferring the in-progress item. */
export function currentTodoTask(phases: readonly TodoPhase[]): string | undefined {
	for (const phase of phases) {
		const active = phase.tasks.find(task => task.status === "in_progress");
		if (active) return active.content;
	}
	for (const phase of phases) {
		const next = phase.tasks.find(task => task.status === "pending");
		if (next) return next.content;
	}
	return undefined;
}
