import type { ReactNode } from "react";
import type { TodoPhase, TodoStatus } from "../../lib/todos";
import "./todo-hud.css";

const TASK_ICON: Record<TodoStatus, string> = {
	completed: "☑︎",
	in_progress: "☐",
	pending: "☐",
	abandoned: "☒",
	blocked: "⚠",
};

export function TodoHud({ phases }: { phases: readonly TodoPhase[] }): ReactNode {
	const tasks = phases.flatMap(phase => phase.tasks);
	const completed = tasks.filter(task => task.status === "completed").length;
	const active = tasks.find(task => task.status === "in_progress");
	return (
		<section className="td-hud" aria-label="Current TODO plan">
			<div className="td-head">
				<strong className="td-title">TODO</strong>
				<span className="td-count">
					{completed}/{tasks.length}
				</span>
				{active && <span className="td-active">▸ {active.content}</span>}
				<div className="td-progress" aria-label={`${completed} of ${tasks.length} tasks complete`}>
					<span style={{ width: tasks.length === 0 ? "0%" : `${(completed / tasks.length) * 100}%` }} />
				</div>
			</div>
			<div className="td-list">
				{phases.length === 0 ? (
					<div className="td-empty">Waiting for the agent to create a task list.</div>
				) : (
					phases.map((phase, phaseIndex) => (
						<div className="td-phase" key={`${phase.name}:${phaseIndex}`}>
							<div className="td-phase-name">
								<span className="td-tree">{phaseIndex === phases.length - 1 ? "└─" : "├─"}</span>
								{phase.name}
							</div>
							{phase.tasks.map((task, taskIndex) => {
								return (
									<div className={`td-task td-task--${task.status}`} key={`${task.content}:${taskIndex}`}>
										<span className="td-branch">{taskIndex === phase.tasks.length - 1 ? "└─" : "├─"}</span>
										<span className="td-task-icon" aria-hidden="true">{TASK_ICON[task.status]}</span>
										<span className="td-task-text">{task.content}</span>
									</div>
								);
							})}
						</div>
					))
				)}
			</div>
		</section>
	);
}
