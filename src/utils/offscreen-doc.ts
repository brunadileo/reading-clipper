// The one offscreen document, shared by every job that needs it. Chrome allows
// a single offscreen document per extension, so READ-181's finisher (Defuddle
// needs a DOM) and any later job go through here. Each job names itself; the document closes only when
// the last job lets go. Calls run one after another so a close never races a
// create.

const c = () => (globalThis as any).chrome;

/** Chrome builds only: the Firefox and Safari manifests have no offscreen permission. */
export function offscreenSupported(): boolean {
	try {
		return !!c()?.runtime?.getManifest?.().permissions?.includes('offscreen') && !!c().offscreen;
	} catch {
		return false;
	}
}

const holders = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
	const p = queue.then(fn, fn);
	queue = p.catch(() => {});
	return p;
}

async function hasOffscreen(): Promise<boolean> {
	const existing = await c().runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
	return !!existing && existing.length > 0;
}

/** Makes sure the document exists and records `holder` as using it. Checked every time, so a document Chrome closed is made again. */
export function ensureOffscreen(holder: string): Promise<void> {
	holders.add(holder);
	return serial(async () => {
		if (await hasOffscreen()) return;
		try {
			await c().offscreen.createDocument({
				url: 'offscreen.html',
				reasons: ['DOM_PARSER'],
				justification: 'Extract article text from fetched HTML for waiting Lazy Reader items.',
			});
		} catch (e) {
			if (!/single offscreen/i.test(String(e))) throw e;
		}
	});
}

/** `holder` is done. Closes the document only when no other job still uses it. */
export function releaseOffscreen(holder: string): Promise<void> {
	holders.delete(holder);
	return serial(async () => {
		if (holders.size > 0) return;
		try {
			if (await hasOffscreen()) await c().offscreen.closeDocument();
		} catch { /* already gone */ }
	});
}
