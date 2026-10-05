// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';


describe('reading status screen (READ-233)', () => {
	it('a success after a 401 retry hides Sign in with LazyReader', async () => {
		document.body.innerHTML = `
			<div class="clipper"></div>
			<div id="reading-status" style="display:none"><span id="reading-status-message"></span>
			<a id="reading-open-link"></a><button id="reading-try-again"></button><button id="reading-sign-in"></button></div>`;
		const { showReadingRetry, showReadingSuccess } = await import('./popup');
		const signIn = document.getElementById('reading-sign-in') as HTMLElement;
		showReadingRetry('rejected', true);
		expect(signIn.style.display).toBe('inline-block');
		showReadingSuccess('https://x.test/read/1', 'saved');
		expect(signIn.style.display).toBe('none');
	});
});
