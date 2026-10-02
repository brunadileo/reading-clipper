// Scrolls lazy-loading pages (Notion and similar) to the bottom so that
// off-screen blocks get drawn before extraction. Used only by the LazyReader
// save (message flag `scrollToLoad`). Restores scroll positions afterwards.

export const SCROLL_STEP_MS = 120;
export const SCROLL_MAX_MS = 2500;
export const SCROLL_STALL_STEPS = 3;

function findScrollers(doc: Document): HTMLElement[] {
	const list: HTMLElement[] = [];
	const root = doc.scrollingElement as HTMLElement | null;
	if (root) list.push(root);
	const notion = doc.querySelector('.notion-scroller') as HTMLElement | null;
	if (notion && list.indexOf(notion) === -1) list.push(notion);
	// At most one more: the element with the largest overflow inside main or body.
	const scope = doc.querySelector('main') || doc.body;
	if (scope) {
		let best: HTMLElement | null = null;
		let bestHeight = 0;
		const all = scope.querySelectorAll<HTMLElement>('*');
		for (let i = 0; i < all.length; i++) {
			const el = all[i];
			if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0 && el.scrollHeight > bestHeight) {
				const overflow = getComputedStyle(el).overflowY;
				if (overflow === 'auto' || overflow === 'scroll') {
					best = el;
					bestHeight = el.scrollHeight;
				}
			}
		}
		if (best && list.indexOf(best) === -1) list.push(best);
	}
	return list;
}

// Scrolls to the bottom (or until the budget ends) and returns a function that
// restores the original positions. The caller restores AFTER extraction.
export async function scrollToLoad(doc: Document = document): Promise<() => void> {
	const scrollers = findScrollers(doc);
	const saved = scrollers.map(el => el.scrollTop);
	const restore = () => { scrollers.forEach((el, i) => { el.scrollTop = saved[i]; }); };
	if (!scrollers.length) return restore;
	const start = Date.now();
	let lastHeights = scrollers.map(el => el.scrollHeight);
	let stalled = 0;
	while (Date.now() - start < SCROLL_MAX_MS) {
		scrollers.forEach(el => {
			el.scrollTop += Math.max(el.clientHeight * 0.9, 1);
		});
		await new Promise<void>(resolve => setTimeout(resolve, SCROLL_STEP_MS));
		const heights = scrollers.map(el => el.scrollHeight);
		const grew = heights.some((h, i) => h > lastHeights[i]);
		const atBottom = scrollers.every(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
		stalled = (grew || !atBottom) ? 0 : stalled + 1;
		lastHeights = heights;
		if (stalled >= SCROLL_STALL_STEPS) break;
	}
	return restore;
}
