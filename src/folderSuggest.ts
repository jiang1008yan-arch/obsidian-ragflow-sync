import { AbstractInputSuggest, App } from "obsidian";

/**
 * Autocomplete for a text input. Backs both the vault-folder picker and the
 * RAGFlow-dataset picker in settings: the candidate list is supplied by a
 * callback (read fresh each keystroke, so async-loaded dataset names appear once
 * fetched), and it stays a free-text field — typing a not-yet-existing dataset
 * name is still allowed, since sync creates a missing target dataset.
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
