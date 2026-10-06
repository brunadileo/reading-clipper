// READ-36: SYNTHETIC Medium pages built from the shapes recorded in the plan
// Facts (2026-10-06 probe). Fake ids, fake titles, `<username>`; no real data.
// `node --experimental-strip-types build.ts` rewrites the .html files here.
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const VIEWER_ID = 'a1b2c3d4e5f6';
export const USERNAME = 'testreader';
export const hex12 = (n: number) => (0x100000000000 + n).toString(16).padStart(12, '0');
export const postIdOf = (listNo: number, i: number) => hex12(listNo * 1000 + i);
// Newest first: item i of a list was added `i` minutes before the list's newest, `listNo` hours apart.
export const catalogItemIdOf = (listNo: number, i: number, base = 1790491555) =>
	(base - listNo * 3600 - i * 60).toString(16).padStart(8, '0') + (0xabcdef000000 + listNo * 1000 + i).toString(16).padStart(16, '0').slice(-16);

export const page = (state: unknown) =>
	`<!doctype html><html><head><title>Medium</title></head><body><div id="root"></div>` +
	`<script>window.__APOLLO_STATE__ = ${JSON.stringify(state).replace(/</g, '\\u003c')};</script>` +
	`<script src="/static/app.js"></script></body></html>`;

export interface ListSpec { catalogId: string; predefined?: boolean; count: number; own?: boolean }

export function libraryHtml(lists: ListSpec[], over: { tier?: string | null; viewer?: boolean } = {}) {
	const state: Record<string, any> = { ROOT_QUERY: {} };
	if (over.viewer !== false) {
		state.ROOT_QUERY.viewer = { __ref: `User:${VIEWER_ID}` };
		state[`User:${VIEWER_ID}`] = { __typename: 'User', id: VIEWER_ID, username: USERNAME };
		if (over.tier !== null) state['Membership:m1'] = { __typename: 'Membership', tier: over.tier ?? 'MEMBER' };
	}
	for (const l of lists) {
		state[`Catalog:${l.catalogId}`] = {
			__typename: 'Catalog',
			id: l.catalogId,
			type: l.predefined ? 'PREDEFINED_LIST' : 'LISTS',
			predefined: l.predefined ? 'READING_LIST' : null,
			visibility: 'PRIVATE',
			creator: { __ref: l.own === false ? 'User:ffffffffffff' : `User:${VIEWER_ID}` },
			postItemsCount: l.count,
			itemsLastInsertedAt: 1790491555000,
		};
	}
	return page(state);
}

export interface ItemSpec { postId: string; catalogItemId: string; title: string; locked?: boolean }

export function listHtml(list: ListSpec, items: ItemSpec[], total = list.count) {
	const state: Record<string, any> = { ROOT_QUERY: {} };
	const conn = {
		items: items.map((it) => ({ __ref: `CatalogItemV2:{"catalogItemId":"${it.catalogItemId}"}` })),
		paging: { count: total, nextPageCursor: items.length < total ? { __ref: `CatalogPagingCursor:offset:${items.length}` } : null },
	};
	state[`Catalog:${list.catalogId}`] = { __typename: 'Catalog', id: list.catalogId, postItemsCount: total, 'itemsConnection:(limit:20)': conn };
	for (const it of items) {
		state[`CatalogItemV2:{"catalogItemId":"${it.catalogItemId}"}`] = {
			__typename: 'CatalogItemV2', catalogItemId: it.catalogItemId, entityType: 'POST', entity: { __ref: `Post:${it.postId}` }, catalogId: list.catalogId,
		};
		state[`Post:${it.postId}`] = {
			__typename: 'Post', id: it.postId, title: it.title,
			mediumUrl: `https://medium.com/@someauthor/${it.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${it.postId}?source=list`,
			visibility: it.locked ? 'LOCKED' : 'PUBLIC', isLocked: !!it.locked, isPublished: true,
			creator: { __ref: 'User:eeeeeeeeeeee' }, uniqueSlug: `slug-${it.postId}`,
		};
	}
	return page(state);
}

export const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(' ');
export const postHtml = (body: string, extra = '') =>
	`<!doctype html><html><head><title>A story</title></head><body><article><h1>A story</h1>${extra}<p>${body}</p></article></body></html>`;

export const READING = 'predefined:' + VIEWER_ID + ':READING_LIST';
export const OWN = 'b1b2b3b4b5b6';
export const LISTS: ListSpec[] = [
	{ catalogId: READING, predefined: true, count: 48 },
	{ catalogId: OWN, count: 3 },
	{ catalogId: 'c1c2c3c4c5c6', count: 5, own: false },
];

const items = (listNo: number, n: number): ItemSpec[] =>
	Array.from({ length: n }, (_, i) => ({ postId: postIdOf(listNo, i), catalogItemId: catalogItemIdOf(listNo, i), title: `Synthetic story ${listNo}-${i}`, locked: i % 5 === 0 }));

if (process.argv[1] && process.argv[1].endsWith('build.ts')) {
	const dir = dirname(process.argv[1]) + '/';
	const w = (name: string, html: string) => writeFileSync(dir + name, html);
	w('library.html', libraryHtml(LISTS));
	w('list-reading.html', listHtml(LISTS[0], items(1, 20)));
	w('list-small.html', listHtml(LISTS[1], items(2, 3)));
	w('library-signed-out.html', libraryHtml([], { viewer: false }));
	w('cloudflare.html', '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform"></div><h1>Checking your browser before accessing medium.com</h1></body></html>');
	w('post-member.html', postHtml(words(400), '<p>Member-only story</p>'));
	w('post-preview.html', postHtml(words(60) + ' Create an account to read the full story. The author made this story available to Medium members only.'));
}
