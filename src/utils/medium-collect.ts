// READ-36: runs INSIDE a Medium list page (chrome.scripting.executeScript with
// func + args), so it must stay self-contained: no imports, no outer helpers.
// It scrolls the page so Medium's own JS loads the next items, and reads post
// ids, titles and links from the rendered links. The DOM is [assumed], so it
// leans on no data-testid: any link whose path ends in -<12 hex> or /p/<12 hex>
// counts. It sends no request of its own and never clicks anything.
export interface CollectedList {
	posts: Array<{ postId: string; title: string; url: string }>;
	total: number;
	ended: boolean;
	blocked?: boolean;
}

export async function collectListPage(wantNew: number, knownPostIds: string[], stepMs = 1200, maxSteps = 120): Promise<CollectedList> {
	const known = new Set(knownPostIds);
	const seen = new Map<string, { postId: string; title: string; url: string }>();
	const title = (document.title || '').trim().toLowerCase();
	if (title.startsWith('just a moment') || /^\/(m\/)?signin/.test(location.pathname)) {
		return { posts: [], total: 0, ended: true, blocked: true };
	}

	const scan = () => {
		document.querySelectorAll('a[href]').forEach((a) => {
			let u: URL;
			try { u = new URL(a.getAttribute('href') || '', location.href); } catch { return; }
			if (u.protocol !== 'https:') return;
			const path = u.pathname.replace(/\/+$/, '');
			if (/\/list\//.test(path) || /\/(tag|topic|m|me|plans|membership)(\/|$)/.test(path)) return;
			const m = path.match(/-([0-9a-f]{12})$/i) || path.match(/\/p\/([0-9a-f]{12})$/i);
			if (!m) return;
			const postId = m[1].toLowerCase();
			const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
			const prev = seen.get(postId);
			// The first link to a post is usually the card image (no text); keep the longest text.
			if (!prev) seen.set(postId, { postId, title: text, url: `${u.origin}${path}` });
			else if (text.length > prev.title.length) prev.title = text;
		});
	};
	const fresh = () => [...seen.values()].filter((p) => !known.has(p.postId));

	let stalled = 0;
	let last = -1;
	for (let step = 0; step < maxSteps; step++) {
		scan();
		if (fresh().length >= wantNew) break;
		if (seen.size === last) stalled++; else stalled = 0;
		last = seen.size;
		if (stalled >= 3) break;
		window.scrollTo(0, document.documentElement.scrollHeight);
		await new Promise((r) => setTimeout(r, stepMs));
	}
	scan();
	const posts = fresh().slice(0, wantNew);
	return { posts, total: seen.size, ended: fresh().length < wantNew };
}
