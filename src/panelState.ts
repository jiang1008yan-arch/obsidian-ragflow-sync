import type { ChangeKind, DatasetCount, FileChange } from "./types";
import { diffVisible } from "./tree";

export type PanelTab = "diff" | "sync";

export function tabData(tab: PanelTab, changes: FileChange[]): FileChange[] {
	return tab === "diff"
		? diffVisible(changes)
		: changes.filter((c) => c.kind !== "deleted");
}

export function syncAllChanges(changes: FileChange[]): FileChange[] {
	return changes.filter((c) => !c.ignored && c.kind !== "unchanged");
}

export function syncSelectedChanges(
	changes: FileChange[],
	selected: Set<string>
): FileChange[] {
	return syncAllChanges(changes).filter((c) => selected.has(c.vaultPath));
}

export function forceSelectedChanges(
	changes: FileChange[],
	selected: Set<string>
): FileChange[] {
	return changes
		.filter((c) => selected.has(c.vaultPath))
		.map(forceUploadChange);
}

export function forceAllChanges(changes: FileChange[]): FileChange[] {
	return changes.filter((c) => !c.ignored).map(forceUploadChange);
}

/**
 * Plain-language notes for the numbers in a dataset tally that need explaining.
 * A bare "559 in RAGFlow / 561 tracked / 570 in vault" invites the wrong
 * conclusion, because each gap has a different cause and a different fix.
 * Returns only the notes that apply, in the order a reader should act on them.
 */
export function countNotes(c: DatasetCount): string[] {
	const notes: string[] = [];

	if (c.remote < c.tracked) {
		notes.push(
			`${c.tracked - c.remote} document(s) tracked but not in RAGFlow — ` +
				`badged "Missing in RAGFlow"; sync to re-upload.`
		);
	}
	if (c.inScope > c.tracked) {
		notes.push(
			`${c.inScope - c.tracked} file(s) never uploaded — ` +
				`badged "New"; sync to upload.`
		);
	}
	if (c.inScope > c.distinctNames) {
		notes.push(
			`${c.inScope - c.distinctNames} file(s) share a document name with ` +
				`another file here. Datasets are flat and uploads replace by name, ` +
				`so this dataset can never hold more than ${c.distinctNames} ` +
				`documents — rename them or split the mapping.`
		);
	}
	if (c.skipped > 0) {
		notes.push(
			`${c.skipped} file(s) in the mapped folder(s) are skipped by the ` +
				`extension/exclude settings and are never synced.`
		);
	}

	return notes;
}

function forceUploadChange(change: FileChange): FileChange {
	return change.kind === "unchanged" || change.ignored
		? {
				...change,
				kind: "modified" as ChangeKind,
				hash: undefined,
				...(change.ignored ? { ignored: false } : {}),
			}
		: change;
}
