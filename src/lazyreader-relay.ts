// READ-181: runs only on https://lazyreader.app/*. Lets the LazyReader web page
// ask the clipper to finish waiting items ("Finish now") and tells the page the
// clipper is installed. No extension id is needed; no other site gets anything.
const ORIGIN = 'https://lazyreader.app';

if (location.origin === ORIGIN) {
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
	// passes through this script.
	window.addEventListener('load', () => {
		setTimeout(() => {
			chrome.runtime.sendMessage({ action: 'refreshReadingToken' }, () => void chrome.runtime.lastError);
		}, 1500);
	});
}
