import { describe, it, expect, afterEach } from 'vitest';
import { collectListPage } from './medium-collect';

// A tiny stand-in for the list page: links appear in batches as the page is "scrolled".
function fakePage(batches: Array<Array<[string, string]>>, over: { title?: string; path?: string } = {}) {
	let shown = 1;
	const anchors = () => batches.slice(0, shown).flat().map(([href, text]) => ({
		getAttribute: () => href,
		textContent: text,
	}));
	(globalThis as any).document = {
		title: over.title ?? 'Reading list',
		documentElement: { scrollHeight: 1000 },
		querySelectorAll: () => ({ forEach: (fn: (a: any) => void) => anchors().forEach(fn) }),
	};
	(globalThis as any).location = { href: 'https://medium.com/@testreader/list/reading-list', pathname: over.path ?? '/@testreader/list/reading-list' };
	(globalThis as any).window = { scrollTo: () => { shown = Math.min(batches.length, shown + 1); } };
}

afterEach(() => {
	delete (globalThis as any).document;
	delete (globalThis as any).location;
	delete (globalThis as any).window;
});

const link = (n: number, text = `Story ${n}`): [string, string] => [`/@someauthor/story-${n}-${(0x100000000000 + n).toString(16)}?source=list`, text];
const id = (n: number) => (0x100000000000 + n).toString(16);

describe('collectListPage', () => {
	it('scrolls until no new links appear, skips known ids, strips queries, keeps the longest title', async () => {
		fakePage([[link(1, ''), link(1, 'Story one'), link(2)], [link(3)], [link(4)]]);
		const r = await collectListPage(100, [id(2)], 0);
		expect(r.ended).toBe(true);
		expect(r.total).toBe(4);
		expect(r.posts.map((p) => p.postId)).toEqual([id(1), id(3), id(4)]);
		expect(r.posts[0]).toEqual({ postId: id(1), title: 'Story one', url: `https://medium.com/@someauthor/story-1-${id(1)}` });
	});
	it('stops as soon as it has the number asked for', async () => {
		fakePage([[link(1), link(2)], [link(3), link(4)], [link(5), link(6)]]);
		const r = await collectListPage(3, [], 0);
		expect(r.posts).toHaveLength(3);
		expect(r.ended).toBe(false);
	});
	it('accepts /p/<id> links, ignores list, tag and other links', async () => {
		fakePage([[
			[`https://medium.com/p/${id(7)}`, 'Short link'],
			[`/@testreader/list/my-list-${id(8)}`, 'A list'],
			['/tag/ai', 'Tag'],
			['/@someauthor', 'Author'],
			['http://medium.com/@a/x-' + id(9), 'insecure'],
		]]);
		const r = await collectListPage(10, [], 0);
		expect(r.posts.map((p) => p.postId)).toEqual([id(7)]);
	});
	it('reports a Cloudflare challenge or sign-in page as blocked', async () => {
		fakePage([[link(1)]], { title: 'Just a moment...' });
		expect((await collectListPage(10, [], 0)).blocked).toBe(true);
		fakePage([[link(1)]], { path: '/m/signin' });
		expect((await collectListPage(10, [], 0)).blocked).toBe(true);
	});
});
