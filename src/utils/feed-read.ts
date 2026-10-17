// READ-414: pure rules for reading the feed of a site that turns Lazy Reader's
// server away. The browser wiring is in waiting-runner.ts (readFeedInWindow).

// Same cap as the server's FEED_BODY_MAX: a bigger read is never sent.
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
// How long the minimized window waits for a bot check to pass.
export const FEED_WINDOW_CAP_MS = 30_000;
// Most needs_device answers followed for one feed.
export const FEED_MAX_ROUNDS = 3;

const CHECK_TITLE = /checking your browser|just a moment/i;

/** Pure: the tab title of a site's bot check page. */
export function isCheckPageTitle(title: string | undefined | null): boolean {
	return CHECK_TITLE.test(title ?? '');
}

/** Pure: text that is worth sending (not empty, at most 2 MB). */
export function feedTextFits(text: string | undefined | null): text is string {
	if (!text || !text.trim()) return false;
	// Every character is at least one byte, so a longer string is too big without encoding it.
	if (text.length > FEED_MAX_BYTES) return false;
	return new TextEncoder().encode(text).length <= FEED_MAX_BYTES;
}

export interface FeedTabSnapshot {
	contentType: string;
	// Chrome's XML viewer keeps the source in #webkit-xml-viewer-source-xml; empty when absent.
	xmlSource: string;
	outerHTML: string;
	bodyText: string;
	// The body is one <pre> (Chrome's view of plain text).
	preOnly: boolean;
}

/** Pure: the raw feed text out of what the tab shows. */
export function pickFeedText(s: FeedTabSnapshot): string {
	if (s.xmlSource.trim()) return s.xmlSource;
	if (/html/i.test(s.contentType) && !s.preOnly) return s.outerHTML;
	return s.bodyText;
}
