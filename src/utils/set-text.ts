// Status lines are role="status" regions: write only when the text changes, so
// a screen reader is not told the same thing again on every storage event.
export function setText(el: Element | null, text: string): void {
	if (el && el.textContent !== text) el.textContent = text;
}
