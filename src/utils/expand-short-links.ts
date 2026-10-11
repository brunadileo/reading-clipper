// READ-358: X shows a long link in a post as its display form cut with an ellipsis
// ("github.com/AmruthPillai/R…") while the anchor's href holds the full address. Defuddle reads
// the anchor text, so the saved text kept the cut. This puts the href in the text for the time
// of one parse, and hands back a function that puts the page back as it was.

const ELLIPSIS = /(?:…|\.\.\.)$/;
const stripScheme = (s: string) => s.replace(/^https?:\/\/(www\.)?/i, '');

export function isXHost(url: string): boolean {
	try {
		const h = new URL(url).hostname.toLowerCase();
		return h === 'x.com' || h === 'twitter.com' || h.endsWith('.x.com') || h.endsWith('.twitter.com');
	} catch {
		return false;
	}
}

/** Pure: the full address when `text` is a display form of `href` cut with an ellipsis, else null. */
export function expandedLink(text: string, href: string): string | null {
	const t = text.trim();
	if (!ELLIPSIS.test(t)) return null;
	const stem = stripScheme(t.replace(ELLIPSIS, '')).toLowerCase();
	const full = stripScheme(href);
	if (!stem || full.length <= stem.length || !full.toLowerCase().startsWith(stem)) return null;
	return /^https?:\/\//i.test(href) ? href : null;
}

/** On an x.com or twitter.com page, set each cut link's text to its address. Returns the undo. */
export function expandShortenedLinks(doc: Document, url: string): () => void {
	if (!isXHost(url)) return () => {};
	const undo: Array<() => void> = [];
	for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
		const full = expandedLink(a.textContent || '', a.getAttribute('href') || '');
		if (!full) continue;
		const kids = Array.from(a.childNodes);
		a.textContent = full;
		undo.push(() => a.replaceChildren(...kids));
	}
	return () => undo.forEach((u) => u());
}
