// READ-233: the capture token reaches the clipper only when the user presses
// "Connect this browser" on lazyreader.app/connect/clipper. The page posts the
// token to the relay content script (parseConnectMessage), the relay forwards
// it to the background worker, and the worker stores it only when
// acceptConnect agrees. The clipper never reads the lazyreader.app session.
// No imports on purpose: the relay bundles this file. Never logs the token.

export const LAZYREADER_ORIGIN = 'https://lazyreader.app';
export const CONNECT_URL = `${LAZYREADER_ORIGIN}/connect/clipper`;
export const CONNECT_MESSAGE_TYPE = 'lazyreader:connect-clipper';
export const CONNECT_RESULT_TYPE = 'lazyreader:connect-result';
/** Value of data-lazyreader-clipper: 2 means the page may offer Connect. */
export const CLIPPER_PROTOCOL = '2';

/** Loose on purpose (imported tokens may not be 48 hex): a string of 16 to 256 characters with no whitespace. */
export function isPlausibleToken(token: unknown): token is string {
	return typeof token === 'string' && token.length >= 16 && token.length <= 256 && !/\s/.test(token);
}

/**
 * Relay side: the token inside a window message, or null. Only a message the
 * lazyreader.app top window sent to itself, of the connect type, with a
 * plausible token.
 */
export function parseConnectMessage(
	event: { origin: string; source: unknown; data: unknown },
	win: unknown
): string | null {
	if (event.origin !== LAZYREADER_ORIGIN || event.source !== win) return null;
	const data = event.data as { type?: unknown; token?: unknown } | null | undefined;
	if (!data || typeof data !== 'object' || data.type !== CONNECT_MESSAGE_TYPE) return null;
	return isPlausibleToken(data.token) ? data.token : null;
}

export interface ConnectSender {
	id?: string;
	tab?: unknown;
	frameId?: number;
	url?: string;
}

/**
 * Background side: takes the token only from this extension's own relay, in
 * the top frame of a tab, on the https://lazyreader.app origin.
 */
export function acceptConnect(sender: ConnectSender | undefined, token: unknown, runtimeId: string): boolean {
	if (!sender || sender.id !== runtimeId || !sender.tab || sender.frameId !== 0) return false;
	let origin = '';
	try {
		origin = new URL(sender.url || '').origin;
	} catch {
		return false;
	}
	return origin === LAZYREADER_ORIGIN && isPlausibleToken(token);
}
