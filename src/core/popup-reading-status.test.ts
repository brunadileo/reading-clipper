// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

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

describe('auto-close after a save (READ-236)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		(window as any).close = vi.fn();
	});
	afterEach(() => vi.useRealTimers());

	it('closes after 1.5 s when untouched', async () => {
		const { scheduleAutoClose } = await import('./popup');
		scheduleAutoClose();
		vi.advanceTimersByTime(1499);
		expect(window.close).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2);
		expect(window.close).toHaveBeenCalledTimes(1);
	});

	it('does not close after the pointer enters the card', async () => {
		const { scheduleAutoClose } = await import('./popup');
		scheduleAutoClose();
		el('reading-status').dispatchEvent(new MouseEvent('mouseenter'));
		vi.advanceTimersByTime(5000);
		expect(window.close).not.toHaveBeenCalled();
	});

	it('does not close after focus moves inside the card', async () => {
		const { scheduleAutoClose } = await import('./popup');
		scheduleAutoClose();
		el('reading-done').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		vi.advanceTimersByTime(5000);
		expect(window.close).not.toHaveBeenCalled();
	});
});

describe('reading note cap in code points (READ-399)', () => {
	it('capReadingNote keeps 10,000 emoji and cuts the rest, never splitting a pair', async () => {
		const { capReadingNote } = await import('./popup');
		expect(capReadingNote('')).toBe('');
		expect(capReadingNote(undefined as unknown as string)).toBe('');
		expect(capReadingNote('<script>é</script>')).toBe('<script>é</script>');
		const ok = '😀'.repeat(10000);
		expect(capReadingNote(ok)).toBe(ok);
		const cut = capReadingNote('😀'.repeat(10005));
		expect(Array.from(cut)).toHaveLength(10000);
		expect(cut).toBe(ok);
	});

	it('typing past the cap trims the textarea and keeps the caret in range', async () => {
		document.body.innerHTML = '<textarea id="reading-note"></textarea>';
		const { wireReadingNoteCap } = await import('./popup');
		wireReadingNoteCap();
		const t = document.getElementById('reading-note') as HTMLTextAreaElement;
		t.value = '😀'.repeat(10003);
		t.dispatchEvent(new Event('input'));
		expect(Array.from(t.value)).toHaveLength(10000);
		expect(t.selectionStart).toBeLessThanOrEqual(t.value.length);
	});
});
