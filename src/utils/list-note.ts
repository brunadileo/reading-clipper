// READ-442: the small note at the bottom of the page after "Add to a list".
// Drawn in a shadow root so the page's CSS cannot touch it. It never takes focus:
// Undo, Open, Try again, Connect and Close are real buttons the keyboard reaches
// by Tab. Status notes are role="status", errors role="alert" and stay until closed.
import type { AddErrorCode, AddOutcome, AddRequest, UndoOutcome } from './list-add';

export type NoteState =
	| { kind: 'adding'; label: string }
	| { kind: 'added'; label: string; id: string; canUndo: boolean; descriptionFailed: boolean; openUrl: string }
	| { kind: 'undone'; label: string }
	| { kind: 'already'; label: string; openUrl: string }
	| { kind: 'moved'; label: string; openUrl: string }
	| { kind: 'error'; code: AddErrorCode | 'kept' | 'undo-failed'; message?: string; retry?: AddRequest; openUrl?: string };

export type NoteButton = 'undo' | 'open' | 'retry' | 'connect' | 'close';

export interface NoteView {
	text: string;
	role: 'status' | 'alert';
	buttons: { id: NoteButton; label: string }[];
	// Milliseconds until it goes away by itself; 0 stays until closed.
	ttl: number;
}

export type Translate = (key: string, substitutions?: string[]) => string;

export const NOTE_TTL_MS = 6000;
export const NOTE_UNDONE_TTL_MS = 3000;
export const NOTE_HOST_ID = 'lazyreader-list-note';

/** Pure: the note for an add's outcome. `request` rides along on failures so Try again can resend it. */
export function outcomeToNote(outcome: AddOutcome, request: AddRequest, openUrl: string): NoteState {
	switch (outcome.kind) {
		case 'added':
			return { kind: 'added', label: outcome.label, id: outcome.id, canUndo: outcome.canUndo, descriptionFailed: outcome.descriptionFailed, openUrl };
		case 'already':
			return { kind: 'already', label: outcome.label, openUrl };
		case 'moved':
			return { kind: 'moved', label: outcome.label, openUrl };
		case 'error':
			return { kind: 'error', code: outcome.code, message: outcome.message, ...(outcome.code === 'failed' ? { retry: request } : {}) };
	}
}

/** Pure: the note for an undo's outcome. */
export function undoOutcomeToNote(outcome: UndoOutcome, label: string, openUrl?: string): NoteState {
	if (outcome.kind === 'removed') return { kind: 'undone', label };
	// A failed or offline undo must not say "Couldn't add": the item is still on the list.
	if (outcome.code === 'failed' || outcome.code === 'offline') {
		return { kind: 'error', code: 'undo-failed', ...(openUrl ? { openUrl } : {}) };
	}
	return { kind: 'error', code: outcome.code };
}

/** Pure: what the note says and offers for a state. */
export function noteView(state: NoteState, t: Translate): NoteView {
	const b = (id: NoteButton, key: string) => ({ id, label: t(key) });
	switch (state.kind) {
		case 'adding':
			return { text: t('noteAdding', [state.label]), role: 'status', buttons: [b('close', 'noteClose')], ttl: 0 };
		case 'added':
			return {
				text: t(state.descriptionFailed ? 'noteAddedFailed' : 'noteAdded', [state.label]),
				role: 'status',
				buttons: state.canUndo && state.id ? [b('undo', 'noteUndo'), b('open', 'noteOpen')] : [b('open', 'noteOpen')],
				ttl: NOTE_TTL_MS,
			};
		case 'undone':
			return { text: t('noteRemoved', [state.label]), role: 'status', buttons: [], ttl: NOTE_UNDONE_TTL_MS };
		case 'already':
			return { text: t('noteAlready', [state.label]), role: 'status', buttons: [b('open', 'noteOpen')], ttl: NOTE_TTL_MS };
		case 'moved':
			return { text: t('noteMoved', [state.label]), role: 'status', buttons: [b('open', 'noteOpen')], ttl: NOTE_TTL_MS };
		case 'error': {
			const close = b('close', 'noteClose');
			switch (state.code) {
				case 'not-connected':
					return { text: t('listAddConnect'), role: 'alert', buttons: [b('connect', 'noteConnect'), close], ttl: 0 };
				case 'offline':
					return { text: t('noteOffline'), role: 'alert', buttons: [close], ttl: 0 };
				case 'too-long':
					return { text: t('noteTooLong'), role: 'alert', buttons: [close], ttl: 0 };
				case 'kept':
					return { text: t('noteKept'), role: 'alert', buttons: [close], ttl: 0 };
				case 'undo-failed':
					return { text: t('noteUndoFailed'), role: 'alert', buttons: state.openUrl ? [b('open', 'noteOpen'), close] : [close], ttl: 0 };
				case 'bad-input':
					return { text: state.message || t('noteFailed'), role: 'alert', buttons: [close], ttl: 0 };
				default:
					return { text: t('noteFailed'), role: 'alert', buttons: state.retry ? [b('retry', 'noteTryAgain'), close] : [close], ttl: 0 };
			}
		}
	}
}

// Colours pass WCAG AA: white on #1b2738 15.07, #b9d3f7 on #1b2738 9.85,
// white on #7a2b1f 9.58, #ffd3c9 on #7a2b1f 7.03.
const CSS = `
:host{all:initial}
.note{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);box-sizing:border-box;max-width:90vw;background:#1b2738;color:#fff;border-radius:10px;padding:4px 6px 4px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 6px 20px rgba(27,39,56,.25);overflow-wrap:anywhere}
.note.err{background:#7a2b1f}
.note button{all:unset;box-sizing:border-box;color:#b9d3f7;min-height:44px;padding:0 12px;border-radius:8px;cursor:pointer;font-weight:600;display:inline-flex;align-items:center}
.note.err button{color:#ffd3c9}
.note button:focus-visible{outline:2px solid #b9d3f7;outline-offset:-2px}
.note.err button:focus-visible{outline-color:#ffd3c9}
@media (prefers-reduced-motion:no-preference){.note{animation:in .15s ease-out}@keyframes in{from{opacity:0}to{opacity:1}}}
`;

let timer: ReturnType<typeof setTimeout> | null = null;
// The shadow root is closed, so the page cannot reach into it; we keep the handle.
let ownHost: HTMLElement | null = null;
let ownRoot: ShadowRoot | null = null;

/** Test hook: the closed root of the note on screen, or null. */
export function getNoteRoot(doc: Document): ShadowRoot | null {
	const host = doc.getElementById(NOTE_HOST_ID);
	return host && host === ownHost ? ownRoot : null;
}

function clearTimer() {
	if (timer !== null) { clearTimeout(timer); timer = null; }
}

export function removeListNote(doc: Document): void {
	clearTimer();
	doc.getElementById(NOTE_HOST_ID)?.remove();
}

/**
 * Draw (or replace) the note. A second add replaces the first on screen (EC-6).
 * The timer pauses while the pointer or keyboard focus is on the note.
 */
export function showListNote(doc: Document, state: NoteState, t: Translate, onAction: (id: NoteButton, state: NoteState) => void): void {
	clearTimer();
	const view = noteView(state, t);
	let host = doc.getElementById(NOTE_HOST_ID);
	// An element with our id that is not ours (a page squatting on it) goes; we build a fresh host.
	if (host && (host !== ownHost || !ownRoot)) { host.remove(); host = null; }
	if (!host) {
		host = doc.createElement('div');
		host.id = NOTE_HOST_ID;
		host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;bottom:0;width:0;height:0';
		ownRoot = host.attachShadow({ mode: 'closed' });
		ownHost = host;
		(doc.body || doc.documentElement).appendChild(host);
	}
	const root = ownRoot!;
	root.replaceChildren();
	const style = doc.createElement('style');
	style.textContent = CSS;
	const note = doc.createElement('div');
	note.className = view.role === 'alert' ? 'note err' : 'note';
	note.setAttribute('role', view.role);
	const text = doc.createElement('span');
	text.textContent = view.text;
	note.append(text);
	for (const btn of view.buttons) {
		const el = doc.createElement('button');
		el.type = 'button';
		el.textContent = btn.label;
		el.addEventListener('click', () => {
			if (btn.id === 'close') removeListNote(doc);
			else onAction(btn.id, state);
		});
		note.append(el);
	}
	root.append(style, note);

	if (view.ttl > 0) {
		const start = () => { clearTimer(); timer = setTimeout(() => removeListNote(doc), view.ttl); };
		start();
		note.addEventListener('mouseenter', clearTimer);
		note.addEventListener('focusin', clearTimer);
		note.addEventListener('mouseleave', start);
		note.addEventListener('focusout', start);
	}
}
