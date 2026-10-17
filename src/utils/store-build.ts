// READ-48: true in the Chrome Web Store build (webpack --env STORE=1). The
// store build ships the page-saving purpose only: no highlighter, reader view,
// side panel or Instagram sync, and the Substack sync plus waiting-article
// finisher stay behind optional permissions. Tests and the default build see false.
declare const STORE_BUILD: boolean;

export const IS_STORE_BUILD: boolean = typeof STORE_BUILD !== 'undefined' && STORE_BUILD === true;

// READ-48: Defuddle's async extractors fetch from third-party services (api.fxtwitter.com, publish.twitter.com,
// bilibili) when a page has no readable text, before the user saves anything. The store build promises that the
// clipper talks only to lazyreader.app and the site the user is on, so it reads the page it has and nothing else.
// READ-359: YouTube is the one exception. Its captions come from youtube.com, the page that is already open, so
// there is no third party. On a YouTube URL only Defuddle's YoutubeExtractor matches. Pure for tests.
function isYouTubeUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === 'youtube.com' || host.endsWith('.youtube.com');
	} catch {
		return false;
	}
}

export function defuddleOptions(url: string, store: boolean = IS_STORE_BUILD): { url: string; useAsync?: boolean } {
	return store && !isYouTubeUrl(url) ? { url, useAsync: false } : { url };
}
