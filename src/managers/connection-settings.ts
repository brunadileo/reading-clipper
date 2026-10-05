// Settings group "Connection": a status card driven by the stored capture
// token (lazyreader.app hands it over when the user presses Connect this
// browser), a button to sign in or open LazyReader, a quiet Disconnect, and
// "Reset to default" for the advanced server address. The two inputs themselves are bound in
// general-settings.ts (initializeReadingSettings).
import browser from '../utils/browser-polyfill';
import { setText } from '../utils/set-text';
import { DEFAULT_READING_CAPTURE_URL, loadReadingSettings, saveReadingSettings } from '../utils/storage-utils';
import { CONNECT_URL, LAZYREADER_ORIGIN } from '../utils/reading-token';

export interface ConnectionView {
	connected: boolean;
	title: string;
	hint: string;
	action: string;
}

/** Pure: what the status card says for a stored token. getMyProfile returns no email, so there is no email line. */
export function describeConnection(token: string): ConnectionView {
	if (token.trim()) {
		return {
			connected: true,
			title: 'Connected to LazyReader',
			hint: 'Your saves go to your LazyReader library.',
			action: 'Open LazyReader',
		};
	}
	return {
		connected: false,
		title: 'Not connected',
		hint: 'Opens lazyreader.app. Press Connect this browser there.',
		action: 'Sign in with LazyReader',
	};
}

/** Sets an input's value and remembers it as the last value this page wrote itself. */
export function setFieldValue(input: HTMLInputElement, value: string): void {
	input.value = value;
	input.dataset.lrWritten = value;
}

// An input is only refreshed from storage when it is not focused and still
// holds what this page last wrote, so an edit waiting to be saved survives.
function refreshField(input: HTMLInputElement | null, value: string): void {
	if (!input || document.activeElement === input) return;
	if (input.value !== (input.dataset.lrWritten ?? '')) return;
	if (input.value !== value) setFieldValue(input, value);
}

async function refresh(): Promise<void> {
	const { token, captureUrl } = await loadReadingSettings();
	const view = describeConnection(token);
	const card = document.getElementById('connection-status');
	const pip = document.getElementById('connection-pip');
	const action = document.getElementById('connection-action');
	const disconnect = document.getElementById('connection-disconnect');
	const dot = document.getElementById('nav-connection-dot');
	const dotText = document.getElementById('nav-connection-sr');
	card?.setAttribute('data-state', view.connected ? 'connected' : 'disconnected');
	if (pip) {
		pip.classList.toggle('ok', view.connected);
		pip.classList.toggle('warn', !view.connected);
	}
	setText(document.getElementById('connection-state'), view.title);
	setText(document.getElementById('connection-hint'), view.hint);
	if (action) {
		setText(action, view.action);
		action.classList.toggle('primary', !view.connected);
		action.hidden = false;
	}
	if (disconnect) disconnect.hidden = !view.connected;
	if (dot) dot.hidden = view.connected;
	if (dotText) dotText.hidden = view.connected;

	// A token that arrives while this page is open (connect finished) shows up
	// in the field too.
	refreshField(document.getElementById('reading-token-input') as HTMLInputElement | null, token);
	refreshField(document.getElementById('reading-capture-url-input') as HTMLInputElement | null, captureUrl);
}

export function initializeConnectionSettings(): void {
	const action = document.getElementById('connection-action');
	action?.addEventListener('click', async () => {
		const { token } = await loadReadingSettings();
		void browser.tabs.create({ url: describeConnection(token).connected ? LAZYREADER_ORIGIN : CONNECT_URL });
	});

	// Clears the token in this browser only; Regenerate on lazyreader.app
	// revokes it everywhere.
	document.getElementById('connection-disconnect')?.addEventListener('click', async () => {
		const tokenInput = document.getElementById('reading-token-input') as HTMLInputElement | null;
		if (tokenInput) setFieldValue(tokenInput, '');
		await saveReadingSettings({ token: '' });
	});

	const reset = document.getElementById('reading-reset-default');
	reset?.addEventListener('click', async () => {
		const urlInput = document.getElementById('reading-capture-url-input') as HTMLInputElement | null;
		if (urlInput) setFieldValue(urlInput, DEFAULT_READING_CAPTURE_URL);
		await saveReadingSettings({ captureUrl: DEFAULT_READING_CAPTURE_URL });
	});

	browser.storage.onChanged.addListener((_changes, area) => {
		if (area === 'local') void refresh();
	});
	void refresh();
}
