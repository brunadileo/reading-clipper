// Builds the JSON body for Reading's `capture` function and asks the
// background worker to POST it. The endpoint sends no CORS headers, so the
// request has to run from the background worker (see background.ts), not
// from this popup/content-script context.
import browser from './browser-polyfill';

export interface ReadingCaptureBody {
	url: string;
	lane: string;
	title: string;
	site_name: string;
	text?: string;
	// READ-37/39/38/36: where an automatic save came from. The server keeps only
	// 'substack', 'instagram', 'youtube' and 'medium'.
	source?: 'substack' | 'instagram' | 'youtube' | 'medium';
	// READ-200: the channel, shown on the item page. The server keeps only the
	// four values it allows a token client to name and stores 'token' otherwise.
	via?: ReadingVia;
}

export type ReadingVia = 'chrome-clipper' | 'substack-saved' | 'instagram-saved' | 'medium-saved';

export interface BuildReadingCaptureBodyParams {
	url: string;
	lane: string;
	title: string;
	siteName: string;
	text: string;
	source?: 'substack' | 'instagram' | 'youtube' | 'medium';
	via?: ReadingVia;
}

// The new home (READ-18) stores full text as a file and caps it at 96,000
// words. 500,000 bytes stays under that for any language and still fits one
// request; only very long pages are cut. (Base44's 20,000-byte field limit
// is gone since READ-21 pointed the clipper at lazyreader.app.)
export const MAX_READING_TEXT_BYTES = 500000;
export const READING_TEXT_CUT_NOTE =
	'\n\n[Lazy Reader Clipper: this page is very long, so only the first part was saved.]';

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/**
 * Cut text to fit MAX_READING_TEXT_BYTES (UTF-8), note included. Cuts on
 * whole characters and, when one is near, at the end of a paragraph.
 */
export function fitReadingText(text: string): string {
	if (byteLength(text) <= MAX_READING_TEXT_BYTES) return text;

	const budget = MAX_READING_TEXT_BYTES - byteLength(READING_TEXT_CUT_NOTE);
	const chars = Array.from(text);
	let lo = 0;
	let hi = chars.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (byteLength(chars.slice(0, mid).join('')) <= budget) lo = mid;
		else hi = mid - 1;
	}

	let cut = chars.slice(0, lo).join('');
	// Paragraph breaks can carry spaces ("  \n  \n" from <br> line ends).
	const lastBreak = Array.from(cut.matchAll(/\n[ \t]*\n/g)).pop();
	if (lastBreak?.index !== undefined && lastBreak.index > cut.length * 0.8) {
		cut = cut.slice(0, lastBreak.index);
	}
	return cut.trimEnd() + READING_TEXT_CUT_NOTE;
}

/**
 * Build the JSON body Reading's `capture` function expects. Pure function,
 * no browser APIs, so it is unit-testable on its own.
 */
export function buildReadingCaptureBody(params: BuildReadingCaptureBodyParams): ReadingCaptureBody {
	const body: ReadingCaptureBody = {
		url: params.url,
		lane: params.lane,
		title: params.title,
		site_name: params.siteName,
	};

	if (params.source) body.source = params.source;
	if (params.via) body.via = params.via;

	// The caller passes the note body, which never holds frontmatter, so the
	// text is sent as-is. An article that opens with a "---" rule stays whole.
	const text = (params.text || '').trim();
	// Empty text is left out entirely, so Reading falls back to fetching the
	// page itself instead of storing an empty article.
	if (text.length > 0) {
		body.text = fitReadingText(text);
	}

	return body;
}

export interface ReadingSendResult {
	ok: boolean;
	status?: number;
	data?: { id?: string; status?: string; created?: string; readUrl?: string; error?: string };
	error?: string;
}

/**
 * The POST itself. Runs in the background worker only (the endpoint sends no
 * CORS headers). Never logs the token.
 */
export async function postCapture(
	body: ReadingCaptureBody,
	captureUrl: string,
	token: string,
	fetchFn: typeof fetch = fetch
): Promise<ReadingSendResult> {
	if (!captureUrl || !token) return { ok: false, status: 401, error: 'Missing capture URL or token' };
	try {
		const response = await fetchFn(captureUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-reader-token': token },
			body: JSON.stringify(body),
		});
		let data: ReadingSendResult['data'];
		try {
			data = await response.json();
		} catch {
			// Non-JSON or empty body; leave data undefined.
		}
		return {
			ok: response.ok,
			status: response.status,
			data,
			error: response.ok ? undefined : data?.error || `Request failed with status ${response.status}`,
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The background's save path (READ-233): one POST with the stored token. A
 * missing or rejected token comes back as 'not-connected' with no retry and no
 * lookup; the popup and Settings offer "Sign in with LazyReader".
 */
export async function captureWithToken(
	body: ReadingCaptureBody,
	captureUrl: string,
	token: string | undefined,
	fetchFn: typeof fetch = fetch
): Promise<ReadingSendResult> {
	const result = token ? await postCapture(body, captureUrl, token, fetchFn) : ({ ok: false, status: 401 } as ReadingSendResult);
	return result.status === 401 ? { ok: false, status: 401, error: 'not-connected' } : result;
}

/**
 * Ask the background worker to POST the body to Reading's capture URL.
 * Never logs the token; only the background worker sees it, in the request
 * header it sends.
 */
export async function sendToReading(
	body: ReadingCaptureBody,
	captureUrl: string,
	token: string
): Promise<ReadingSendResult> {
	try {
		const response = await browser.runtime.sendMessage({
			action: 'sendToReading',
			captureUrl,
			token,
			body,
		});
		return response as ReadingSendResult;
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
