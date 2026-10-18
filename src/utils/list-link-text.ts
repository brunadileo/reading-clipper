// READ-442: Chrome's click info has the link's address but not its text, so the
// content script reads it from the page. Both helpers return '' when there is none
// (an image link with no alt text: the server then uses the page's own title).
import { collapseTitle } from './list-add';

/** Visible text of an anchor, else the alt text of an image inside it, else its aria-label. */
export function linkTextOf(anchor: Element | null | undefined): string {
	if (!anchor) return '';
	const visible = collapseTitle((anchor as HTMLElement).innerText ?? anchor.textContent);
	if (visible) return visible;
	const viaTextContent = collapseTitle(anchor.textContent);
	if (viaTextContent) return viaTextContent;
	const alt = anchor.querySelector('img[alt]')?.getAttribute('alt');
	return collapseTitle(alt) || collapseTitle(anchor.getAttribute('aria-label'));
}

/** The first anchor on the page whose resolved address is `url`. Used when no contextmenu was seen. */
export function findLinkTextByUrl(doc: Document, url: string): string {
	if (typeof url !== 'string' || !url) return '';
	for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
		if ((a as HTMLAnchorElement).href === url) {
			const text = linkTextOf(a);
			if (text) return text;
		}
	}
	return '';
}
