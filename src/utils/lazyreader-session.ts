// Shared by the background worker (injected into a lazyreader.app tab) and the
// lazyreader.app relay (inside the hidden offscreen frame). Self-contained on
// purpose: scripting.executeScript sends it to the page as source text.

/** Runs inside a lazyreader.app page: the signed-in user's access token, or null. */
export function readLazyReaderSession(): string | null {
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i) || '';
			if (!/^sb-.+-auth-token$/.test(key)) continue;
			try {
				const raw = JSON.parse(localStorage.getItem(key) || 'null');
				const session = raw?.currentSession ?? raw;
				if (typeof session?.access_token === 'string') return session.access_token;
			} catch {
				// Not JSON; try the next key.
			}
		}
	} catch {
		// Storage blocked (a partitioned or sandboxed frame).
	}
	return null;
}

/** The hash the offscreen frame loads lazyreader.app with, so the relay knows it is the lookup frame. */
export const SESSION_FRAME_HASH = '#lazyreader-clipper-session';
