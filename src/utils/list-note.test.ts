// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { noteView, outcomeToNote, undoOutcomeToNote, showListNote, removeListNote, getNoteRoot, NOTE_HOST_ID, type NoteState } from './list-note';

const t = (key: string, subs?: string[]) => (subs?.length ? `${key}(${subs.join(',')})` : key);
const added: NoteState = { kind: 'added', label: 'Books', id: 'i1', canUndo: true, descriptionFailed: false, openUrl: 'https://lazyreader.app/lists/book' };

describe('noteView', () => {
	it('added: Undo and Open for 6 s', () => {
		const v = noteView(added, t);
		expect(v).toMatchObject({ text: 'noteAdded(Books)', role: 'status', ttl: 6000 });
		expect(v.buttons.map(b => b.id)).toEqual(['undo', 'open']);
	});
	it('added without undo (not created, or no id): Open only', () => {
		expect(noteView({ ...added, canUndo: false }, t).buttons.map(b => b.id)).toEqual(['open']);
		expect(noteView({ ...added, id: '' }, t).buttons.map(b => b.id)).toEqual(['open']);
	});
	it('description failed has its own words (EC-8)', () => {
		expect(noteView({ ...added, descriptionFailed: true }, t).text).toBe('noteAddedFailed(Books)');
	});
	it('adding, undone, already, moved', () => {
		expect(noteView({ kind: 'adding', label: 'Books' }, t)).toMatchObject({ text: 'noteAdding(Books)', buttons: [{ id: 'close', label: 'noteClose' }], ttl: 0 });
		expect(noteView({ kind: 'undone', label: 'Books' }, t)).toMatchObject({ text: 'noteRemoved(Books)', ttl: 3000 });
		expect(noteView({ kind: 'already', label: 'Tools', openUrl: 'u' }, t)).toMatchObject({ text: 'noteAlready(Tools)', ttl: 6000 });
		expect(noteView({ kind: 'moved', label: 'Books', openUrl: 'u' }, t).text).toBe('noteMoved(Books)');
	});
	it('errors are alerts that stay until closed', () => {
		for (const code of ['not-connected', 'offline', 'too-long', 'kept', 'bad-input', 'failed'] as const) {
			const v = noteView({ kind: 'error', code }, t);
			expect(v.role).toBe('alert');
			expect(v.ttl).toBe(0);
			expect(v.buttons.some(b => b.id === 'close')).toBe(true);
		}
		expect(noteView({ kind: 'error', code: 'not-connected' }, t).buttons.map(b => b.id)).toEqual(['connect', 'close']);
		expect(noteView({ kind: 'error', code: 'bad-input', message: 'No list called x' }, t).text).toBe('No list called x');
		expect(noteView({ kind: 'error', code: 'bad-input' }, t).text).toBe('noteFailed');
	});
	it('Try again only when there is a request to resend', () => {
		const retry = { list: 'a', label: 'A', text: 'x' };
		expect(noteView({ kind: 'error', code: 'failed', retry }, t).buttons.map(b => b.id)).toEqual(['retry', 'close']);
		expect(noteView({ kind: 'error', code: 'failed' }, t).buttons.map(b => b.id)).toEqual(['close']);
	});
});

describe('outcomeToNote', () => {
	const req = { list: 'book', label: 'Books', text: 'x' };
	it('carries the request on a failure only', () => {
		expect(outcomeToNote({ kind: 'error', code: 'failed' }, req, 'u')).toMatchObject({ retry: req });
		expect('retry' in outcomeToNote({ kind: 'error', code: 'offline' }, req, 'u')).toBe(false);
	});
	it('maps added, already, moved', () => {
		expect(outcomeToNote({ kind: 'added', id: 'i', label: 'B', canUndo: true, descriptionFailed: false }, req, 'u')).toMatchObject({ kind: 'added', openUrl: 'u', canUndo: true });
		expect(outcomeToNote({ kind: 'already', label: 'B' }, req, 'u')).toEqual({ kind: 'already', label: 'B', openUrl: 'u' });
		expect(outcomeToNote({ kind: 'moved', label: 'B' }, req, 'u')).toEqual({ kind: 'moved', label: 'B', openUrl: 'u' });
	});
	it('a failed or offline undo has its own words and keeps Open', () => {
		const n = undoOutcomeToNote({ kind: 'error', code: 'failed' }, 'Books', 'https://lazyreader.app/lists/book');
		expect(n).toEqual({ kind: 'error', code: 'undo-failed', openUrl: 'https://lazyreader.app/lists/book' });
		const v = noteView(n, t);
		expect(v.text).toBe('noteUndoFailed');
		expect(v.buttons.map(b => b.id)).toEqual(['open', 'close']);
		expect(undoOutcomeToNote({ kind: 'error', code: 'offline' }, 'Books')).toEqual({ kind: 'error', code: 'undo-failed' });
		expect(noteView({ kind: 'error', code: 'undo-failed' }, t).buttons.map(b => b.id)).toEqual(['close']);
	});
	it('the adding note has a Close button', () => {
		expect(noteView({ kind: 'adding', label: 'Books' }, t).buttons.map(b => b.id)).toEqual(['close']);
	});
	it('undo outcomes', () => {
		expect(undoOutcomeToNote({ kind: 'removed' }, 'Books')).toEqual({ kind: 'undone', label: 'Books' });
		expect(undoOutcomeToNote({ kind: 'error', code: 'kept' }, 'Books')).toEqual({ kind: 'error', code: 'kept' });
	});
});

describe('showListNote', () => {
	beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ''; });
	afterEach(() => { removeListNote(document); vi.useRealTimers(); });
	const root = () => getNoteRoot(document)!;

	it('draws in a shadow root with role=status and 44 px buttons, and takes no focus', () => {
		showListNote(document, added, t, () => {});
		const note = root().querySelector('.note')!;
		expect(note.getAttribute('role')).toBe('status');
		expect(note.textContent).toContain('noteAdded(Books)');
		expect(root().querySelectorAll('button').length).toBe(2);
		expect(root().querySelector('style')!.textContent).toMatch(/min-height:44px/);
		expect(root().querySelector('style')!.textContent).toMatch(/prefers-reduced-motion:no-preference/);
		expect(document.activeElement).toBe(document.body);
		expect(document.body.textContent).not.toContain('noteAdded');
	});
	it('errors use role=alert and stay past 6 s until Close', () => {
		showListNote(document, { kind: 'error', code: 'offline' }, t, () => {});
		expect(root().querySelector('.note')!.getAttribute('role')).toBe('alert');
		vi.advanceTimersByTime(60_000);
		expect(document.getElementById(NOTE_HOST_ID)).not.toBeNull();
		(root().querySelector('button') as HTMLButtonElement).click();
		expect(document.getElementById(NOTE_HOST_ID)).toBeNull();
	});
	it('goes away after 6 s; pauses while hovered', () => {
		showListNote(document, added, t, () => {});
		vi.advanceTimersByTime(5000);
		root().querySelector('.note')!.dispatchEvent(new Event('mouseenter'));
		vi.advanceTimersByTime(60_000);
		expect(document.getElementById(NOTE_HOST_ID)).not.toBeNull();
		root().querySelector('.note')!.dispatchEvent(new Event('mouseleave'));
		vi.advanceTimersByTime(6001);
		expect(document.getElementById(NOTE_HOST_ID)).toBeNull();
	});
	it('a second note replaces the first (EC-6) and the old timer does not remove the new one', () => {
		showListNote(document, added, t, () => {});
		vi.advanceTimersByTime(5000);
		showListNote(document, { ...added, id: 'i2' }, t, () => {});
		expect(document.querySelectorAll(`#${NOTE_HOST_ID}`).length).toBe(1);
		vi.advanceTimersByTime(3000);
		expect(document.getElementById(NOTE_HOST_ID)).not.toBeNull();
	});
	it('button clicks call back with the id and state', () => {
		const spy = vi.fn();
		showListNote(document, added, t, spy);
		(root().querySelectorAll('button')[0] as HTMLButtonElement).click();
		expect(spy).toHaveBeenCalledWith('undo', added);
		(root().querySelectorAll('button')[1] as HTMLButtonElement).click();
		expect(spy).toHaveBeenLastCalledWith('open', added);
	});
	it('the shadow root is closed, and a squatter with our id is replaced', () => {
		showListNote(document, added, t, () => {});
		expect(document.getElementById(NOTE_HOST_ID)!.shadowRoot).toBeNull();
		removeListNote(document);
		const squat = document.createElement('div');
		squat.id = NOTE_HOST_ID;
		squat.attachShadow({ mode: 'open' }).innerHTML = '<p>fake</p>';
		document.body.append(squat);
		showListNote(document, added, t, () => {});
		expect(document.querySelectorAll(`#${NOTE_HOST_ID}`).length).toBe(1);
		expect(document.getElementById(NOTE_HOST_ID)).not.toBe(squat);
		expect(root().querySelector('.note')!.textContent).toContain('noteAdded(Books)');
	});
	it('the adding note is closable and stays until closed', () => {
		showListNote(document, { kind: 'adding', label: 'Books' }, t, () => {});
		vi.advanceTimersByTime(60_000);
		const btn = root().querySelector('button') as HTMLButtonElement;
		expect(btn.textContent).toBe('noteClose');
		btn.click();
		expect(document.getElementById(NOTE_HOST_ID)).toBeNull();
	});
	it('page text is never parsed as HTML', () => {
		showListNote(document, { kind: 'error', code: 'bad-input', message: '<img src=x onerror=alert(1)>' }, t, () => {});
		expect(root().querySelector('img')).toBeNull();
		expect(root().querySelector('.note')!.textContent).toContain('<img');
	});
});
