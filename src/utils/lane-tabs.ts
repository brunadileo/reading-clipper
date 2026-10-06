// READ-236: the three lanes (Read now, Read later, File it) as a radiogroup of
// tabs. #vault-select stays the source of truth: popup.ts reads it on save.
// A tab press or an arrow key writes the lane into the select and fires
// `change`, so the "remember the last lane" listener still runs.

export interface LaneOption {
	value: string;
	label: string;
}

/** Marks the tab for the select's current value; only that tab is in the tab order. */
export function syncLaneTabs(container: HTMLElement, select: HTMLSelectElement): void {
	container.querySelectorAll<HTMLElement>('[role="radio"]').forEach(tab => {
		const on = tab.dataset.value === select.value;
		tab.setAttribute('aria-checked', String(on));
		tab.tabIndex = on ? 0 : -1;
	});
}

export function renderLaneTabs(container: HTMLElement, select: HTMLSelectElement, lanes: LaneOption[]): void {
	container.textContent = '';
	const choose = (value: string, focus: boolean) => {
		if (select.value !== value) {
			select.value = value;
			select.dispatchEvent(new Event('change', { bubbles: true }));
		}
		syncLaneTabs(container, select);
		if (focus) container.querySelector<HTMLElement>(`[data-value="${value}"]`)?.focus();
	};

	lanes.forEach((lane, index) => {
		const tab = document.createElement('button');
		tab.type = 'button';
		tab.className = 'lr-tab';
		tab.setAttribute('role', 'radio');
		tab.dataset.value = lane.value;
		tab.textContent = lane.label;
		tab.addEventListener('click', () => choose(lane.value, false));
		tab.addEventListener('keydown', (event: KeyboardEvent) => {
			let next = -1;
			if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % lanes.length;
			else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + lanes.length) % lanes.length;
			else if (event.key === 'Home') next = 0;
			else if (event.key === 'End') next = lanes.length - 1;
			if (next < 0) return;
			event.preventDefault();
			choose(lanes[next].value, true);
		});
		container.appendChild(tab);
	});

	select.addEventListener('change', () => syncLaneTabs(container, select));
	syncLaneTabs(container, select);
}
