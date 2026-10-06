// READ-38: synthetic fixtures in the real shape of a YouTube playlist page
// (ytInitialData and ytcfg) and of a browse continuation response. Observed
// shape, 2026-10-06, Watch later page: rows are playlistVideoRenderer with
// videoId, thumbnail, title, index, shortBylineText, lengthText,
// navigationEndpoint, setVideoId, lengthSeconds, trackingParams, isPlayable,
// menu, thumbnailOverlays, videoInfo; a second page is a continuationItemRenderer.
// No real titles, channels or ids.

export interface RowOpts {
	length?: number | null;
	playable?: boolean;
	short?: 'url' | 'reel' | null;
	title?: string;
	channel?: string;
}

export const vid = (n: number) => `vid${String(n).padStart(8, '0')}`; // 11 chars

export function videoRow(n: number, o: RowOpts = {}) {
	const id = vid(n);
	const length = o.length === undefined ? 600 : o.length;
	const nav: any = o.short === 'reel'
		? { clickTrackingParams: 'x', reelWatchEndpoint: { videoId: id } }
		: {
			clickTrackingParams: 'x',
			commandMetadata: { webCommandMetadata: { url: o.short === 'url' ? `/shorts/${id}` : `/watch?v=${id}&list=WL&index=${n + 1}`, webPageType: 'WEB_PAGE_TYPE_WATCH' } },
			watchEndpoint: { videoId: id, playlistId: 'WL', index: n },
		};
	const r: any = {
		videoId: id,
		thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/default.jpg`, width: 120, height: 90 }] },
		title: { runs: [{ text: o.title ?? `Video ${n}` }], accessibility: { accessibilityData: { label: `Video ${n} by Channel ${n % 3}` } } },
		index: { simpleText: String(n + 1) },
		shortBylineText: { runs: [{ text: o.channel ?? `Channel ${n % 3}`, navigationEndpoint: { browseEndpoint: { browseId: 'UCsynthetic' } } }] },
		navigationEndpoint: nav,
		setVideoId: `set${n}`,
		trackingParams: 'x',
		menu: {},
		thumbnailOverlays: [],
		videoInfo: { runs: [{ text: '1K views' }] },
	};
	if (length !== null) {
		r.lengthSeconds = String(length);
		r.lengthText = { simpleText: `${Math.floor(length / 60)}:${String(length % 60).padStart(2, '0')}` };
	}
	if (o.playable === false) {
		r.isPlayable = false;
		r.title = { runs: [{ text: '[Private video]' }] };
	} else {
		r.isPlayable = true;
	}
	return { playlistVideoRenderer: r };
}

export const continuationItem = (token: string) => ({
	continuationItemRenderer: {
		trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
		continuationEndpoint: { clickTrackingParams: 'x', continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } },
	},
});

/** ytInitialData of a playlist page, wrapped the way the page nests it. */
export function initialData(items: any[], title = 'Watch later') {
	return {
		responseContext: {},
		contents: {
			twoColumnBrowseResultsRenderer: {
				tabs: [{
					tabRenderer: {
						content: {
							sectionListRenderer: {
								contents: [{
									itemSectionRenderer: {
										contents: [{ playlistVideoListRenderer: { contents: items, playlistId: 'WL' } }],
									},
								}],
							},
						},
					},
				}],
			},
		},
		metadata: { playlistMetadataRenderer: { title, androidAppindexingLink: 'x' } },
	};
}

export interface PageOpts {
	// null leaves the LOGGED_IN field out of ytcfg.
	loggedIn?: boolean | null;
	title?: string;
	continuation?: string | null;
	noData?: boolean;
}

/** The HTML of /playlist?list=...: ytcfg plus the ytInitialData script. */
export function playlistPageHtml(rows: any[], o: PageOpts = {}): string {
	const items = o.continuation ? [...rows, continuationItem(o.continuation)] : rows;
	const cfg = `ytcfg.set({${o.loggedIn === null ? '' : `"LOGGED_IN":${o.loggedIn === false ? 'false' : 'true'},`}"INNERTUBE_API_KEY":"AIzaSyntheticKey0000","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20261002.10.00","VISITOR_DATA":"vd"});`;
	const data = o.noData ? '' : `<script nonce="n">var ytInitialData = ${JSON.stringify(initialData(items, o.title))};</script>`;
	return `<!DOCTYPE html><html><head><script nonce="n">${cfg}</script></head><body>${data}</body></html>`;
}

/** The browse response for a continuation call. */
export function continuationResponse(rows: any[], next: string | null) {
	return {
		responseContext: {},
		onResponseReceivedActions: [{
			appendContinuationItemsAction: { continuationItems: next ? [...rows, continuationItem(next)] : rows },
		}],
	};
}
