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
}

export interface BuildReadingCaptureBodyParams {
	url: string;
	lane: string;
	title: string;
	siteName: string;
	text: string;
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

	// The caller passes the note body, which never holds frontmatter, so the
	// text is sent as-is. An article that opens with a "---" rule stays whole.
	const text = (params.text || '').trim();
	// Empty text is left out entirely, so Reading falls back to fetching the
	// page itself instead of storing an empty article.
	if (text.length > 0) {
		body.text = text;
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
