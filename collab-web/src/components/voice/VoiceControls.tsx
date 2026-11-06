/**
 * Voice layer UI: a compact header control (activate/deactivate + settings
 * panel) and an inline HUD strip above the composer.
 *
 * Mobile rules honored here: the arm action is a direct user gesture (autoplay
 * policy), controls never cover the composer, rail, or transcript, and
 * destructive queue actions require a second explicit tap.
 */

import { History, Mic, MicOff, Pause, Play, RotateCcw, Settings2, SkipForward, Trash2, Volume2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useVoiceStats } from "../../voice/use-voice-monitor";
import type { VoiceMonitor } from "../../voice/monitor";
import { ttsAvailable, type VoiceSpec } from "../../voice/speech-engine";
import type { VoiceStats } from "../../voice/types";
import "./voice.css";

const STATUS_LABEL: Record<VoiceStats["status"], string> = {
	off: "Voice off",
	idle: "No pending events",
	speaking: "Speaking",
	paused: "Paused",
	error: "TTS error",
	"no-tts": "No speech in this browser",
};

function fmtLag(ms: number): string {
	if (ms <= 0) return "no delay";
	if (ms < 60_000) return `≈ ${Math.ceil(ms / 1000)} s`;
	return `≈ ${Math.round(ms / 60_000)} min`;
}

function statusLabel(stats: VoiceStats): string {
	if (stats.armed && stats.status === "idle")
		return stats.pending > 0 ? `${stats.pending} pending` : STATUS_LABEL.idle;
	return STATUS_LABEL[stats.status];
}

export interface VoiceControlsProps {
	monitor: VoiceMonitor | null;
}

/** Header slot: toggle + settings popover. Stable identity when memoized by the caller. */
export function VoiceControls({ monitor }: VoiceControlsProps): ReactNode {
	const stats = useVoiceStats(monitor);
	const [open, setOpen] = useState(false);
	const [voices, setVoices] = useState<VoiceSpec[]>(() => monitor?.voices() ?? []);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const hasTts = ttsAvailable();
	const armed = monitor?.armed ?? false;

	// getVoices() is async on Chrome/Safari: repopulate on `voiceschanged`.
	useEffect(() => {
		if (monitor === null) return;
		setVoices(monitor.voices());
		return monitor.onVoicesChanged(() => setVoices(monitor.voices()));
	}, [monitor]);

	// Dismiss the popover on outside click or Escape.
	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent): void => {
			if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer, true);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const settings = monitor?.settings;
	return (
		<div className="vc-root" ref={rootRef}>
			<div className="vc-head">
				<button
					type="button"
					className={armed ? "sh-btn sh-btn-icon vc-btn vc-btn-on" : "sh-btn sh-btn-icon vc-btn"}
					disabled={monitor === null || !hasTts}
					title={armed ? "Disable voice" : hasTts ? "Enable voice" : "This browser has no speech synthesis"}
					aria-pressed={armed}
					aria-label={armed ? "Disable voice" : "Enable voice"}
					onClick={() => {
						if (monitor === null) return;
						if (monitor.armed) monitor.disarm();
						else monitor.arm();
					}}
				>
					{armed ? <Volume2 size={14} /> : hasTts ? <Mic size={14} /> : <MicOff size={14} />}
				</button>
				<button
					type="button"
					className={open ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					disabled={monitor === null}
					title="Voice settings"
					aria-label="Voice settings"
					aria-expanded={open}
					onClick={() => setOpen(o => !o)}
				>
					<Settings2 size={14} />
				</button>
				{stats !== null && stats.armed && stats.pending > 0 && (
					<span className="vc-pending-badge">{stats.pending}</span>
				)}
			</div>
			{open && monitor !== null && settings !== undefined && stats !== null && (
				<div className="vc-panel" role="dialog" aria-label="Voice settings">
					<div className="vc-panel-head">
						<span className={`vc-status vc-status-${stats.status}`}>{statusLabel(stats)}</span>
						<span className="vc-counts">
							read {stats.spoken}
							{stats.failed > 0 && ` · failed ${stats.failed}`}
							{stats.armed && ` · ${fmtLag(stats.lagMs)}`}
						</span>
						<button
							type="button"
							className="sh-btn sh-btn-icon vc-close"
							onClick={() => setOpen(false)}
							title="Close"
							aria-label="Close settings"
						>
							<X size={14} />
						</button>
					</div>

					<div className="vc-actions" role="group" aria-label="Playback">
						<button
							type="button"
							className="sh-btn"
							disabled={!stats.armed}
							onClick={() => (stats.paused ? monitor.resume() : monitor.pause())}
						>
							{stats.paused ? <Play size={14} /> : <Pause size={14} />}
							{stats.paused ? "Resume" : "Pause"}
						</button>
						<button
							type="button"
							className="sh-btn"
							disabled={stats.pending === 0 && stats.current === null}
							onClick={() => monitor.skip()}
						>
							<SkipForward size={14} />
							Skip
						</button>
						<button type="button" className="sh-btn" onClick={() => monitor.requeueLast()}>
							<RotateCcw size={14} />
							Read last again
						</button>
					</div>

					<label className="vc-row">
						<span>Speed</span>
						<input
							type="range"
							min={0.8}
							max={1.8}
							step={0.05}
							defaultValue={settings.rate}
							onChange={e => monitor.updateSettings({ rate: Number(e.target.value) })}
						/>
						<span className="vc-value">{settings.rate.toFixed(2)}</span>
					</label>

					<label className="vc-row">
						<span>Voice</span>
						<select
							value={settings.voiceName ?? ""}
							onChange={e =>
								monitor.updateSettings({ voiceName: e.target.value === "" ? null : e.target.value })
							}
						>
							<option value="">automatic</option>
							{voices.map(v => (
								<option key={v.name} value={v.name}>
									{v.name} ({v.lang})
								</option>
							))}
						</select>
					</label>

					<label className="vc-row vc-check">
						<input
							type="checkbox"
							checked={settings.speakUserMessages}
							onChange={e => monitor.updateSettings({ speakUserMessages: e.target.checked })}
						/>
						<span>Read user messages</span>
					</label>
					<label className="vc-row vc-check">
						<input
							type="checkbox"
							checked={settings.speakThinking}
							onChange={e => monitor.updateSettings({ speakThinking: e.target.checked })}
						/>
						<span>Read visible reasoning</span>
					</label>
					<label className="vc-row">
						<span>Verbosity</span>
						<select
							value={settings.verbosity}
							onChange={e =>
								monitor.updateSettings({ verbosity: e.target.value === "verbose" ? "verbose" : "normal" })
							}
						>
							<option value="normal">normal (transitions)</option>
							<option value="verbose">detailed (progress)</option>
						</select>
					</label>
					<label className="vc-row vc-check">
						<input
							type="checkbox"
							checked={settings.persistRecords}
							onChange={e => monitor.updateSettings({ persistRecords: e.target.checked })}
						/>
						<span>Save history in this browser</span>
					</label>
					{settings.persistRecords && (
						<p className="vc-hint">
							{monitor.storageMode === "off"
								? "Saving in this browser (IndexedDB); expires after 72 h."
								: monitor.storageMode === "idb"
									? "Saved in this browser; expires after 72 h."
									: "IndexedDB unavailable: history lives only in this tab."}
						</p>
					)}

					<div className="vc-actions" role="group" aria-label="History">
						<button
							type="button"
							className="sh-btn"
							disabled={monitor.registrySize === 0}
							title={`Queues the last ${settings.historyReadCount} recorded events`}
							onClick={() => monitor.readHistory()}
						>
							<History size={14} />
							Read history
						</button>
						<button
							type="button"
							className="sh-btn"
							disabled={monitor.registrySize === 0}
							title="Queues the full recorded content (bounded)"
							onClick={() => monitor.readHistory(undefined, true)}
						>
							<History size={14} />
							Read in detail
						</button>
					</div>

					<DangerAction
						label="Clear queue"
						confirmLabel={stats.pending > 0 ? `Clear ${stats.pending}?` : "Clear queue"}
						disabled={stats.pending === 0 && stats.current === null}
						onConfirm={() => monitor.clearPending()}
					/>
					<DangerAction
						label="Clear history"
						confirmLabel="Clear history?"
						onConfirm={() => monitor.clearSessionHistory()}
					/>
				</div>
			)}
		</div>
	);
}

/** Destructive actions need a second explicit tap (plan: confirm before total erase). */
function DangerAction({
	label,
	confirmLabel,
	disabled = false,
	onConfirm,
}: {
	label: string;
	confirmLabel: string;
	disabled?: boolean;
	onConfirm(): void;
}): ReactNode {
	const [confirming, setConfirming] = useState(false);
	const timerRef = useRef<Timer | null>(null);
	useEffect(
		() => () => {
			if (timerRef.current !== null) clearTimeout(timerRef.current);
		},
		[],
	);
	return (
		<button
			type="button"
			className={confirming ? "sh-btn sh-btn-stop" : "sh-btn"}
			disabled={disabled}
			onClick={() => {
				if (confirming) {
					if (timerRef.current !== null) clearTimeout(timerRef.current);
					timerRef.current = null;
					setConfirming(false);
					onConfirm();
					return;
				}
				setConfirming(true);
				timerRef.current = setTimeout(() => setConfirming(false), 4000);
			}}
		>
			<Trash2 size={14} />
			{confirming ? confirmLabel : label}
		</button>
	);
}

/** Inline strip above the composer: live status while listening. Hidden otherwise. */
export function VoiceHud({ monitor }: VoiceControlsProps): ReactNode {
	const stats = useVoiceStats(monitor);
	if (monitor === null || stats === null || !stats.armed) return null;
	if (stats.status === "no-tts") {
		return (
			<div className="vc-hud vc-hud-error" role="status">
				<span className="vc-hud-text">Error: this browser could not start speech synthesis.</span>
			</div>
		);
	}
	const active = stats.pending > 0 || stats.current !== null || stats.status === "paused" || stats.status === "error";
	if (!active) return null;
	return (
		<div className="vc-hud" role="status">
			<span className={`vc-hud-dot vc-hud-dot-${stats.status}`} aria-hidden="true" />
			<span className="vc-hud-text">{stats.current ?? (stats.status === "paused" ? "Paused" : "Queued")}</span>
			{stats.pending > 0 && (
				<span className="vc-hud-chip" title="Items pending in the queue">
					{stats.pending} pending · {fmtLag(stats.lagMs)}
				</span>
			)}
			<span className="vc-hud-actions">
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={() => (stats.paused ? monitor.resume() : monitor.pause())}
					title={stats.paused ? "Resume narration" : "Pause narration"}
					aria-label={stats.paused ? "Resume narration" : "Pause narration"}
				>
					{stats.paused ? <Play size={13} /> : <Pause size={13} />}
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					disabled={stats.pending === 0 && stats.current === null}
					onClick={() => monitor.skip()}
					title="Skip current utterance"
					aria-label="Skip current utterance"
				>
					<SkipForward size={13} />
				</button>
			</span>
		</div>
	);
}
