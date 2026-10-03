// READ-181: offscreen document. The service worker has no DOM, so it sends
// fetched HTML here; Defuddle and the markdown converter run exactly as they
// do in a page (content.ts). No window, no tab, nothing on screen.
import Defuddle from 'defuddle/full';
import { createMarkdownContent } from 'defuddle/full';

type Msg =
	| { target: 'offscreen'; action: 'extractHtml'; html: string; url: string }
	| { target: 'offscreen'; action: 'contentToMarkdown'; html: string; url: string };

function extractHtml(html: string, url: string): { title: string; text: string } {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	// Relative links need a base; the parsed document has none.
	if (!doc.querySelector('base')) {
		const base = doc.createElement('base');
		base.href = url;
		doc.head.prepend(base);
	}
	const defuddled = new Defuddle(doc, { url }).parse();
	return { title: defuddled.title || '', text: createMarkdownContent(defuddled.content, url) };
}

chrome.runtime.onMessage.addListener((request: Msg, _sender, sendResponse) => {
	if (!request || request.target !== 'offscreen') return undefined;
	try {
		if (request.action === 'extractHtml') {
			sendResponse({ ok: true, ...extractHtml(request.html, request.url) });
		} else if (request.action === 'contentToMarkdown') {
			sendResponse({ ok: true, text: createMarkdownContent(request.html, request.url) });
		} else {
			sendResponse({ ok: false, error: 'Unknown action' });
		}
	} catch (e) {
		sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
	}
	return false;
});
