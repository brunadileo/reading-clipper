// READ-247: browser wiring for the push wake. Background worker only. The rules
// are in clipper-push.ts (subscribe, register) and waiting-finisher.ts (finish).
// A push never shows a notification: any push event is a wake, whatever it holds.
import browser from './browser-polyfill';
import { loadReadingSettings } from './storage-utils';
import { base64UrlToBytes, ensureClipperPush, VAPID_PUBLIC_KEY } from './clipper-push';
import { finishSupported } from './waiting-runner';
import { runOne } from './sync-runner';
import { markPendingWake } from './sync-schedule';

// Pause before the finish run, so a burst of parks arrives as one run.
export const PUSH_COLLECT_MS = 20_000;

const store = {
	async get(key: string) {
		const r = await browser.storage.local.get(key);
		return r[key];
	},
	async set(key: string, value: any) {
		await browser.storage.local.set({ [key]: value });
	},
};

const registration = () => (self as any).registration as ServiceWorkerRegistration | undefined;

export function registerClipperPush(): Promise<unknown> {
	return ensureClipperPush({
		store,
		supported: () => finishSupported() && !!registration()?.pushManager,
		loadSettings: loadReadingSettings,
		getSubscription: async () => registration()!.pushManager.getSubscription(),
		subscribe: async () => registration()!.pushManager.subscribe({
			userVisibleOnly: false,
			applicationServerKey: base64UrlToBytes(VAPID_PUBLIC_KEY) as BufferSource,
		}),
		fetchFn: (input, init) => fetch(input, init),
		now: () => Date.now(),
	});
}

async function handleWake(): Promise<void> {
	await new Promise((r) => setTimeout(r, PUSH_COLLECT_MS));
	const res = await runOne('finish', 'finish-push');
	// A sequence is running: it reruns finish once when it ends.
	if (res.skipped === 'busy') await markPendingWake(store);
}

/** Top level of the worker: listeners must be added while the script first runs. */
export function initClipperPush(): void {
	if (!finishSupported()) return;
	const sw = self as any;
	sw.addEventListener?.('push', (event: any) => {
		event.waitUntil(handleWake().catch(() => {}));
	});
	// Chrome replaced the subscription: tell the server the new one.
	sw.addEventListener?.('pushsubscriptionchange', (event: any) => {
		event.waitUntil(registerClipperPush().catch(() => {}));
	});
	browser.runtime.onStartup?.addListener(() => { void registerClipperPush(); });
	browser.runtime.onInstalled.addListener(() => { void registerClipperPush(); });
	// The token (or capture URL) was set or changed, from Connect or from Settings.
	browser.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && (changes.readingToken || changes.readingCaptureUrl)) void registerClipperPush();
	});
}
