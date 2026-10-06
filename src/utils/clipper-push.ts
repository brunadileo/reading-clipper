// READ-247: the clipper subscribes to Web Push so the server can wake it when a
// save is parked as "Waiting for full text". Pure rules with injected
// dependencies (like sync-core.ts); the browser wiring is in
// clipper-push-runner.ts. A failure is silent: the schedule still runs, and the
// outcome is kept for the one settings line.
import { endpointUrl } from './waiting-api';
import type { SyncStore } from './sync-core';

// Public by design (it is also in lazyreader's web/.env.production).
export const VAPID_PUBLIC_KEY = 'BMGYvJBngtb51jLcSsKT3EngstnsAwWeqAKMW_jMeD5AoyqjB4J-Hb-ACo5EdW03IxzWRQaRClkCcwKVVsFavk0';
export const PUSH_STATE_KEY = 'clipper-push:state';

export interface PushState {
	registered: boolean;
	at: number | null;
	// Short reason when the last attempt failed. Never holds the token.
	error: string | null;
}

export const emptyPushState = (): PushState => ({ registered: false, at: null, error: null });

export async function loadPushState(store: SyncStore): Promise<PushState> {
	const saved = await store.get(PUSH_STATE_KEY);
	return { ...emptyPushState(), ...(saved && typeof saved === 'object' ? saved : {}) };
}

/** Pure: the settings line. */
export function describePushStatus(s: PushState): string {
	return s.registered ? 'Instant finish: on' : 'Instant finish: off, waiting articles finish on the schedule';
}

/** Pure: base64url (VAPID key) to the bytes pushManager.subscribe wants. */
export function base64UrlToBytes(b64: string): Uint8Array {
	const pad = '='.repeat((4 - (b64.length % 4)) % 4);
	const bin = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export interface PushSubscriptionJson {
	endpoint?: string;
	keys?: { p256dh?: string; auth?: string };
}

export interface ClipperPushDeps {
	store: SyncStore;
	// Chrome build only (finishSupported()).
	supported: () => boolean;
	loadSettings: () => Promise<{ token: string; captureUrl: string }>;
	// The existing subscription, or null.
	getSubscription: () => Promise<{ toJSON(): PushSubscriptionJson } | null>;
	subscribe: () => Promise<{ toJSON(): PushSubscriptionJson }>;
	fetchFn: typeof fetch;
	now: () => number;
}

/**
 * Subscribe (or reuse the subscription) and tell the server about it. Safe to
 * call as often as wanted: the server upserts by endpoint. Never throws; a
 * failure leaves the schedule untouched and is recorded for the settings line.
 */
export async function ensureClipperPush(deps: ClipperPushDeps): Promise<PushState> {
	const state: PushState = { registered: false, at: deps.now(), error: null };
	try {
		if (!deps.supported()) { state.error = 'not supported in this browser'; return state; }
		const { token, captureUrl } = await deps.loadSettings();
		const url = endpointUrl(captureUrl, 'registerClipper');
		if (!token || !url) { state.error = 'not connected'; return state; }
		const sub = (await deps.getSubscription()) ?? (await deps.subscribe());
		const json = sub.toJSON();
		const { endpoint } = json;
		const p256dh = json.keys?.p256dh;
		const auth = json.keys?.auth;
		if (!endpoint || !p256dh || !auth) { state.error = 'incomplete subscription'; return state; }
		const res = await deps.fetchFn(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-reader-token': token },
			body: JSON.stringify({ endpoint, p256dh, auth }),
		});
		if (res.ok) state.registered = true;
		else state.error = `server answered ${res.status}`;
	} catch (e) {
		state.error = e instanceof Error ? e.message.slice(0, 120) : 'subscribe failed';
	} finally {
		try { await deps.store.set(PUSH_STATE_KEY, state); } catch { /* the line stays as it was */ }
	}
	return state;
}
