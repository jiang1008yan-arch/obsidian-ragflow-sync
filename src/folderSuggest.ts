import { AbstractInputSuggest, App } from "obsidian";

/**
 * Autocomplete for a folder-path text input. Backs both the Obsidian-folder and
 * the RAGFlow-folder pickers in settings: the candidate list is supplied by a
 * callback (read fresh each keystroke, so async-loaded RAGFlow paths appear once
 * fetched), and it stays a free-text field — typing a not-yet-existing RAGFlow
 * path is still allowed, since sync creates missing target folders.
 */
export class FolderInputSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private items: () => string[],
		private onPick: (value: string) => void
	) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		return this.items().filter((path) => path.toLowerCase().includes(q));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value === "" ? "/ (root)" : value);
	}

	selectSuggestion(value: string): void {
		this.setValue(value);
		this.onPick(value);
		this.close();
	}
}
