/** React bindings for the voice monitor (creation lifecycle + stats store). */

import { useCallback, useEffect, useSyncExternalStore, useState } from "react";
import type { GuestClient } from "../lib/client";
import { VoiceMonitor } from "./monitor";
import type { VoiceStats } from "./types";

/**
 * Owns one VoiceMonitor per client. Creation happens inside the effect so
 * every created instance is paired with its own dispose: a remount can never
 * leave a live frame observer attached to the client. The first render yields
 * null; controls render inert until the monitor exists.
 */
export function useVoiceMonitor(client: GuestClient): VoiceMonitor | null {
	const [monitor, setMonitor] = useState<VoiceMonitor | null>(null);
	useEffect(() => {
		const created = new VoiceMonitor(client);
		setMonitor(created);
		return () => created.dispose();
	}, [client]);
	return monitor;
}

export function useVoiceStats(monitor: VoiceMonitor | null): VoiceStats | null {
	const subscribe = useCallback(
		(listener: () => void) => (monitor === null ? (): void => {} : monitor.subscribe(listener)),
		[monitor],
	);
	const getStats = useCallback((): VoiceStats | null => (monitor === null ? null : monitor.getStats()), [monitor]);
	return useSyncExternalStore(subscribe, getStats, getStats);
}
