// READ-181: offscreen document. The service worker has no DOM, so it sends
// fetched HTML here; Defuddle and the markdown converter run exactly as they
// do in a page (content.ts). No window, no tab, nothing on screen.
// It also hosts the hidden lazyreader.app frame the capture-token lookup uses
// (reading-token.ts); the relay content script inside that frame reports the
// session to the background worker directly, never through this page.
import Defuddle from 'defuddle/full';
import { createMarkdownContent } from 'defuddle/full';

type Msg =
	| { target: 'offscreen'; action: 'extractHtml'; html: string; url: string }
	| { target: 'offscreen'; action: 'contentToMarkdown'; html: string; url: string }
	| { target: 'offscreen'; action: 'openLazyReaderFrame'; url: string }
	| { target: 'offscreen'; action: 'closeLazyReaderFrame' };

const FRAME_ID = 'lazyreader-session-frame';

function openLazyReaderFrame(url: string): void {
	document.getElementById(FRAME_ID)?.remove();
	const frame = document.createElement('iframe');
	frame.id = FRAME_ID;
	frame.src = url;
	document.body.appendChild(frame);
}

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
		} else if (request.action === 'openLazyReaderFrame') {
			openLazyReaderFrame(request.url);
			sendResponse({ ok: true });
		} else if (request.action === 'closeLazyReaderFrame') {
			document.getElementById(FRAME_ID)?.remove();
			sendResponse({ ok: true });
		} else {
			sendResponse({ ok: false, error: 'Unknown action' });
		}
	} catch (e) {
		sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
	}
	return false;
});
