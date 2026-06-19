import { ChangeKind, FileChange } from "./types";

/**
 * Pure folder-tree helpers for the sync panel: turning the flat diff into a
 * nested vault-folder tree, summarizing a folder's changes, and computing which
 * folders to expand. No Obsidian, no DOM — the view renders these results.
 */

/** A node in the vault-folder tree the panel renders the diff into. */
export interface TreeNode {
	/** Last path segment (folder or file name). */
	name: string;
	/** Full vault path to this node. */
	path: string;
	/** Child folders and files, keyed by their name segment. */
	children: Map<string, TreeNode>;
	/** Present only on a file leaf: the diff entry for that file. */
	change?: FileChange;
}

/** Build a nested folder tree from a flat list of file changes. */
export function buildTree(changes: FileChange[]): TreeNode {
	const root: TreeNode = { name: "", path: "", children: new Map() };
	for (const change of changes) {
		const parts = change.vaultPath.split("/");
		let node = root;
		let acc = "";
		parts.forEach((part, i) => {
			acc = acc ? `${acc}/${part}` : part;
			let child = node.children.get(part);
			if (!child) {
				child = { name: part, path: acc, children: new Map() };
				node.children.set(part, child);
			}
			if (i === parts.length - 1) child.change = change;
			node = child;
		});
	}
	return root;
}

/** A node is a file leaf when it carries a change and has no children. */
export function isFileLeaf(node: TreeNode): boolean {
	return !!node.change && node.children.size === 0;
}

/** A node's direct children, folders first then files, each group sorted by name. */
export function sortedChildren(node: TreeNode): TreeNode[] {
	return [...node.children.values()].sort((a, b) => {
		const aFolder = a.children.size > 0;
		const bFolder = b.children.size > 0;
		if (aFolder !== bFolder) return aFolder ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

/** Every file leaf under a node, in no particular order. */
export function leavesOf(node: TreeNode): TreeNode[] {
	if (isFileLeaf(node)) return [node];
	const out: TreeNode[] = [];
	for (const child of node.children.values()) out.push(...leavesOf(child));
	return out;
}

/** A compact "2 new, 1 modified" summary of a folder's actionable leaves. */
export function changeSummary(leaves: TreeNode[]): string {
	const counts: Record<ChangeKind, number> = {
		new: 0,
		modified: 0,
		deleted: 0,
		unchanged: 0,
	};
	let ignored = 0;
	for (const leaf of leaves) {
		if (!leaf.change) continue;
		if (leaf.change.ignored) ignored += 1;
		else counts[leaf.change.kind] += 1;
	}
	const parts: string[] = [];
	if (counts.new) parts.push(`${counts.new} new`);
	if (counts.modified) parts.push(`${counts.modified} modified`);
	if (counts.deleted) parts.push(`${counts.deleted} deleted`);
	if (ignored) parts.push(`${ignored} ignored`);
	return parts.join(", ");
}

/**
 * The changes the Scan diff tab shows: everything actionable plus snoozed
 * (ignored) entries, but not files that are merely up to date. The Sync tab
 * uses the full list instead so any file can be picked for a manual upload.
 */
export function diffVisible(changes: FileChange[]): FileChange[] {
	return changes.filter((c) => c.ignored || c.kind !== "unchanged");
}

/** Ancestor folder paths of a vault path (excludes the file itself). */
function addAncestorFolders(vaultPath: string, set: Set<string>): void {
	const parts = vaultPath.split("/");
	let acc = "";
	for (let i = 0; i < parts.length - 1; i++) {
		acc = acc ? `${acc}/${parts[i]}` : parts[i];
		set.add(acc);
	}
}

/** Ancestor folders of every Scan-diff-visible entry — the default-expanded set. */
export function foldersWithChanges(changes: FileChange[]): Set<string> {
	const set = new Set<string>();
	for (const change of changes) {
		if (change.kind === "unchanged" && !change.ignored) continue;
		addAncestorFolders(change.vaultPath, set);
	}
	return set;
}

/** Every folder path in the tree, for "Expand all". */
export function allFolderPaths(changes: FileChange[]): Set<string> {
	const set = new Set<string>();
	for (const change of changes) addAncestorFolders(change.vaultPath, set);
	return set;
}
