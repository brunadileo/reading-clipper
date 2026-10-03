// READ-181: runs only on https://lazyreader.app/*. Lets the LazyReader web page
// ask the clipper to finish waiting items ("Finish now") and tells the page the
// clipper is installed. No extension id is needed; no other site gets anything.
// Inside the clipper's own hidden offscreen frame it instead reports the
// session for the capture-token lookup (reading-token.ts).
import { readLazyReaderSession, SESSION_FRAME_HASH } from './utils/lazyreader-session';

const ORIGIN = 'https://lazyreader.app';
// Read before the app's router can change it. Only the clipper's own hidden
// frame (offscreen document, reading-token.ts) loads the page with this hash.
const inSessionFrame = window.top !== window && location.hash === SESSION_FRAME_HASH;

if (location.origin === ORIGIN && inSessionFrame) {
	// The capture-token lookup without a visible tab: report this frame's
	// session (or null) to the background worker once supabase-js has had a
	// moment to refresh it. The worker takes it only while a lookup is waiting
	// and only from a lazyreader.app frame outside any tab.
	window.addEventListener('load', () => {
		setTimeout(() => {
			chrome.runtime.sendMessage({ action: 'lazyreaderFrameSession', accessToken: readLazyReaderSession() }, () => void chrome.runtime.lastError);
		}, 1500);
	});
} else if (location.origin === ORIGIN && window.top === window) {
	// Top frame only, as before all_frames: the lookup frame above is the only
	// subframe this script acts in.
	document.documentElement.setAttribute('data-lazyreader-clipper', '1');
	window.addEventListener('message', (event: MessageEvent) => {
		if (event.origin !== ORIGIN || event.source !== window) return;
		if (!event.data || event.data.type !== 'lazyreader:finish-now') return;
		chrome.runtime.sendMessage({ action: 'finishNow' }, (result) => {
			void chrome.runtime.lastError;
			window.postMessage({ type: 'lazyreader:finish-result', result: result ?? null }, ORIGIN);
		});
	});
	// Keeps the clipper's capture token current: the background worker reads
	// the session from this tab and fetches the token itself. Nothing secret
	// passes through this branch.
	window.addEventListener('load', () => {
		setTimeout(() => {
			chrome.runtime.sendMessage({ action: 'refreshReadingToken' }, () => void chrome.runtime.lastError);
		}, 1500);
	});
}
