// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

const STATUS_DOM = `
	<div class="clipper"></div>
	<div id="reading-status" style="display:none"><span id="reading-status-message"></span>
	<a id="reading-open-link"></a><button id="reading-try-again"></button><button id="reading-sign-in"></button><button id="reading-done"></button></div>`;

const el = (id: string) => document.getElementById(id) as HTMLElement;

beforeEach(() => {
	document.body.className = '';
	document.body.innerHTML = STATUS_DOM;
});

describe('reading status screen (READ-233, READ-236)', () => {
	it('a success after a 401 retry hides Sign in with Lazy Reader', async () => {
		const { showReadingRetry, showReadingSuccess } = await import('./popup');
		showReadingRetry('rejected', true);
		expect(el('reading-sign-in').style.display).toBe('inline-flex');
		showReadingSuccess('https://x.test/read/1', 'saved');
		expect(el('reading-sign-in').style.display).toBe('none');
	});

	it('saved card: ok state, Open in Lazy Reader with the link and Done, no Try again', async () => {
		const { showReadingSuccess } = await import('./popup');
		showReadingSuccess('https://x.test/read/1', 'Saved to Lazy Reader');
		expect(el('reading-status').dataset.state).toBe('saved');
		expect(el('reading-status').style.display).toBe('flex');
		expect(el('reading-status-message').textContent).toBe('Saved to Lazy Reader');
		expect((el('reading-open-link') as HTMLAnchorElement).href).toBe('https://x.test/read/1');
		expect(el('reading-open-link').style.display).toBe('inline-flex');
		expect(el('reading-done').style.display).toBe('inline-flex');
		expect(el('reading-try-again').style.display).toBe('none');
		expect((document.querySelector('.clipper') as HTMLElement).style.display).toBe('none');
		expect(document.body.classList.contains('has-reading-status')).toBe(true);
	});

	it('saved card without a read link shows only Done', async () => {
		const { showReadingSuccess } = await import('./popup');
		showReadingSuccess(undefined, 'Saved');
		expect(el('reading-open-link').style.display).toBe('none');
		expect(el('reading-done').style.display).toBe('inline-flex');
	});

	it('failed card: Try again only', async () => {
		const { showReadingRetry } = await import('./popup');
		showReadingRetry('Save failed (500).');
		expect(el('reading-status').dataset.state).toBe('failed');
		expect(el('reading-try-again').style.display).toBe('inline-flex');
		expect(el('reading-sign-in').style.display).toBe('none');
		expect(el('reading-done').style.display).toBe('none');
	});

	it('not connected card: Sign in only', async () => {
		const { showReadingRetry } = await import('./popup');
		showReadingRetry('Not connected to Lazy Reader.', true);
		expect(el('reading-status').dataset.state).toBe('signin');
		expect(el('reading-sign-in').style.display).toBe('inline-flex');
		expect(el('reading-try-again').style.display).toBe('none');
	});
});
