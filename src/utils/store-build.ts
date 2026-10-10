// READ-48: true in the Chrome Web Store build (webpack --env STORE=1). The
// store build ships the page-saving purpose only: no highlighter, reader view,
// side panel or Instagram sync, and the Substack sync plus waiting-article
// finisher stay behind optional permissions. Tests and the default build see false.
declare const STORE_BUILD: boolean;

export const IS_STORE_BUILD: boolean = typeof STORE_BUILD !== 'undefined' && STORE_BUILD === true;

// READ-48: Defuddle's async extractors fetch from third-party services (api.fxtwitter.com, publish.twitter.com,
// YouTube, bilibili) when a page has no readable text, before the user saves anything. The store build promises
// that the clipper talks only to lazyreader.app, so it reads the page it has and nothing else. Pure for tests.
export function defuddleOptions(url: string, store: boolean = IS_STORE_BUILD): { url: string; useAsync?: boolean } {
	return store ? { url, useAsync: false } : { url };
}
