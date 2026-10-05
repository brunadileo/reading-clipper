// READ-181 / READ-233: runs only in the top frame of https://lazyreader.app/*.
// Tells the LazyReader web page the clipper is installed, lets it ask the
// clipper to finish waiting items ("Finish now"), and passes along the capture
// token the user hands over by pressing "Connect this browser". No extension id
// is needed; no other site gets anything. Never logs the token.
import { CLIPPER_PROTOCOL, CONNECT_RESULT_TYPE, LAZYREADER_ORIGIN as ORIGIN, parseConnectMessage } from './utils/reading-token';

if (location.origin === ORIGIN && window.top === window) {
	document.documentElement.setAttribute('data-lazyreader-clipper', CLIPPER_PROTOCOL);
	window.addEventListener('message', (event: MessageEvent) => {
		if (event.origin !== ORIGIN || event.source !== window) return;
		const connectToken = parseConnectMessage(event, window);
		if (connectToken) {
			chrome.runtime.sendMessage({ action: 'connectClipper', token: connectToken }, (result) => {
				void chrome.runtime.lastError;
				window.postMessage({ type: CONNECT_RESULT_TYPE, ok: !!result?.ok }, ORIGIN);
			});
			return;
		}
		if (!event.data || event.data.type !== 'lazyreader:finish-now') return;
		chrome.runtime.sendMessage({ action: 'finishNow' }, (result) => {
			void chrome.runtime.lastError;
			window.postMessage({ type: 'lazyreader:finish-result', result: result ?? null }, ORIGIN);
		});
	});
}
