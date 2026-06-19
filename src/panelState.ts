import type { ChangeKind, FileChange } from "./types";
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
