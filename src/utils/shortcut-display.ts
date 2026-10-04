// Which commands the Shortcuts group lists, how they are labelled, and how a
// shortcut string from the browser is split into keys. The other commands stay
// in the manifest; they are only left out of this list.
export const SHORTCUT_ROWS: Record<string, { label: string; description?: string }> = {
	_execute_action: { label: 'Open the clipper' },
	quick_clip: { label: 'Save this page now', description: 'Saves without opening the clipper.' },
};

export const SHORTCUT_ORDER = ['_execute_action', 'quick_clip'];

/** Chrome on Mac returns glyphs without separators ("⇧⌘O"); elsewhere it returns "Ctrl+Shift+O". */
export function shortcutKeys(shortcut: string | null | undefined): string[] {
	const s = (shortcut ?? '').trim();
	if (!s) return [];
	if (s.includes('+') && s.length > 1) {
		return s.split('+').map(k => k.trim()).filter(Boolean);
	}
	return Array.from(s);
}
