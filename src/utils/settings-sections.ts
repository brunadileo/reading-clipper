// The Settings page has four groups. Every other section name (the hidden
// Obsidian pages, an old bookmark like ?section=templates, a template id)
// falls back to Connection.
export const SETTINGS_SECTIONS = ['connection', 'sync', 'shortcuts', 'about'] as const;
export type LazyReaderSection = typeof SETTINGS_SECTIONS[number];
export const DEFAULT_SECTION: LazyReaderSection = 'connection';

export function resolveSection(section: string | null | undefined): LazyReaderSection {
	return (SETTINGS_SECTIONS as readonly string[]).includes(section ?? '')
		? (section as LazyReaderSection)
		: DEFAULT_SECTION;
}
