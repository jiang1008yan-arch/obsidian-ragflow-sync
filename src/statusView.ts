import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type RagflowSyncPlugin from "./main";
import { ChangeKind, FileChange } from "./types";
import { summarize } from "./syncEngine";

export const VIEW_TYPE_RAGFLOW_SYNC = "ragflow-sync-view";

const KIND_LABEL: Record<ChangeKind, string> = {
	new: "New",
	modified: "Modified",
	deleted: "Deleted",
	unchanged: "Up to date",
};

/** A node in the vault-folder tree the panel renders the diff into. */
interface TreeNode {
	/** Last path segment (folder or file name). */
	name: string;
	/** Full vault path to this node. */
	path: string;
	/** Child folders and files, keyed by their name segment. */
	children: Map<string, TreeNode>;
	/** Present only on a file leaf: the diff entry for that file. */
	change?: FileChange;
}

export class RagflowSyncView extends ItemView {
	plugin: RagflowSyncPlugin;
	private changes: FileChange[] = [];
	private statusEl: HTMLElement | null = null;
	private busy = false;
	/** Vault paths the user has ticked for a manual re-upload. */
	private selected: Set<string> = new Set();
	/** Folder paths currently expanded in the tree. */
	private expanded: Set<string> = new Set();
	/** Whether the "Ignored" section at the bottom is expanded. */
	private ignoredExpanded = false;
	/** Selection-dependent buttons, kept so their labels can update live. */
	private syncSelectedBtn: HTMLButtonElement | null = null;
	private ignoreSelectedBtn: HTMLButtonElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: RagflowSyncPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_RAGFLOW_SYNC;
	}

	getDisplayText(): string {
		return "RAGFlow Sync";
	}

	getIcon(): string {
		return "refresh-cw";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		// no-op
	}

	private setStatus(text: string): void {
		if (this.statusEl) this.statusEl.setText(text);
	}

	async scan(): Promise<void> {
		if (this.busy) return;
		if (!this.plugin.settings.apiKey) {
			new Notice("Set your RAGFlow API key in settings first.");
			return;
		}
		this.busy = true;
		this.setStatus("Scanning for differences...");
		try {
			const result = await this.plugin.engine.computeDiff();
			this.changes = result.changes;
			// A fresh scan is a clean slate: drop any prior selection and expand the
			// folders that hold actionable changes so they are visible at a glance.
			this.selected.clear();
			this.expanded = this.foldersWithChanges(this.changes);
			if (result.missingMappings.length > 0) {
				new Notice(
					`Some mapped folders were not found: ${result.missingMappings
						.map((m) => m.vaultPath)
						.join(", ")}`
				);
			}
			this.render();
			const counts = summarize(this.changes);
			this.setStatus(
				`Scan complete: ${counts.new} new, ${counts.modified} modified, ${counts.deleted} deleted, ${counts.unchanged} up to date.`
			);
		} catch (e) {
			new Notice(`Scan failed: ${(e as Error).message}`);
			this.setStatus(`Scan failed: ${(e as Error).message}`);
		} finally {
			this.busy = false;
		}
	}

	async syncAll(): Promise<void> {
		await this.syncChanges(this.changes);
	}

	/**
	 * Re-upload exactly the files the user ticked, regardless of diff result.
	 * An "unchanged" pick is promoted to "modified" (hash cleared) so the upload
	 * step rebuilds RAGFlow's copy from the current source; a "deleted" pick
	 * stays a deletion. Use to rebuild specific documents — e.g. ones removed or
	 * left in a failed state on the RAGFlow side — without re-uploading the rest.
	 */
	async syncSelected(): Promise<void> {
		const picks = this.changes.filter((c) => this.selected.has(c.vaultPath));
		if (picks.length === 0) {
			new Notice("No files selected. Tick the files you want to re-upload.");
			return;
		}
		const forced = picks.map((c) =>
			c.kind === "unchanged"
				? { ...c, kind: "modified" as ChangeKind, hash: undefined }
				: c
		);
		await this.syncChanges(forced);
	}

	/**
	 * Re-upload every in-scope file regardless of diff result, by promoting
	 * "unchanged" entries to "modified". The command-palette "force re-sync"
	 * escape hatch; the panel offers per-file selection instead.
	 */
	async forceSyncAll(): Promise<void> {
		const forced = this.changes.map((c) =>
			c.kind === "unchanged"
				? { ...c, kind: "modified" as ChangeKind, hash: undefined }
				: c
		);
		await this.syncChanges(forced);
	}

	async syncChanges(changes: FileChange[]): Promise<void> {
		if (this.busy) return;
		const actionable = changes.filter((c) => c.kind !== "unchanged");
		if (actionable.length === 0) {
			new Notice("Nothing to sync.");
			return;
		}
		this.busy = true;
		try {
			const result = await this.plugin.engine.applyChanges(
				actionable,
				(done, total, label) => {
					this.setStatus(`Syncing ${done}/${total}: ${label}`);
				}
			);
			let msg = `Synced ${result.ok} item(s).`;
			if (result.parsed > 0) msg += ` Parsing ${result.parsed}.`;
			if (result.failed > 0) msg += ` ${result.failed} failed.`;
			new Notice(msg);
			if (result.errors.length > 0) {
				console.error("RAGFlow Sync errors:", result.errors);
			}
		} catch (e) {
			new Notice(`Sync failed: ${(e as Error).message}`);
		} finally {
			this.busy = false;
			await this.scan();
		}
	}

	/**
	 * Freeze the ticked files: add them to the persistent ignore list so the Diff
	 * skips them — never uploaded, and any already-synced document left in place.
	 * Dropped from the current diff view without a re-scan; they reappear under
	 * "Ignored" where they can be un-ignored.
	 */
	async ignoreSelected(): Promise<void> {
		if (this.selected.size === 0) {
			new Notice("No files selected. Tick the files you want to ignore.");
			return;
		}
		const picked = this.selected;
		const merged = new Set(this.plugin.settings.ignoredPaths);
		for (const path of picked) merged.add(path);
		this.plugin.settings.ignoredPaths = [...merged].sort((a, b) =>
			a.localeCompare(b)
		);
		await this.plugin.saveSettings();

		this.changes = this.changes.filter((c) => !picked.has(c.vaultPath));
		this.selected = new Set();
		this.render();
		new Notice(`Ignoring ${picked.size} file(s).`);
	}

	/** Un-freeze one path, then re-scan so it re-enters the diff classified. */
	async unignore(path: string): Promise<void> {
		this.plugin.settings.ignoredPaths =
			this.plugin.settings.ignoredPaths.filter((p) => p !== path);
		await this.plugin.saveSettings();
		this.render();
		await this.scan();
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("ragflow-sync-view");

		this.syncSelectedBtn = null;
		this.ignoreSelectedBtn = null;
		const toolbar = container.createDiv({ cls: "ragflow-sync-toolbar" });
		this.renderToolbar(toolbar);

		this.statusEl = container.createDiv({ cls: "ragflow-sync-status" });

		if (this.changes.length === 0) {
			container.createDiv({
				cls: "ragflow-sync-empty",
				text: 'No scan results yet. Click "Scan diff" to compare your vault with RAGFlow.',
			});
		} else {
			const tree = container.createDiv({ cls: "ragflow-sync-tree" });
			const root = this.buildTree(this.changes);
			this.renderChildren(tree, root, 0);
		}

		this.renderIgnored(container);
		this.updateSelectionUi();
	}

	private renderToolbar(toolbar: HTMLElement): void {
		const scanBtn = toolbar.createEl("button", { text: "Scan diff" });
		scanBtn.onclick = () => void this.scan();

		const syncAllBtn = toolbar.createEl("button", { text: "Sync all" });
		syncAllBtn.addClass("mod-cta");
		syncAllBtn.onclick = () => void this.syncChanges(this.changes);

		this.syncSelectedBtn = toolbar.createEl("button", { text: "Sync selected" });
		this.syncSelectedBtn.onclick = () => void this.syncSelected();

		this.ignoreSelectedBtn = toolbar.createEl("button", {
			text: "Ignore selected",
		});
		this.ignoreSelectedBtn.onclick = () => void this.ignoreSelected();

		if (this.changes.length > 0) {
			const expandBtn = toolbar.createEl("button", { text: "Expand all" });
			expandBtn.onclick = () => {
				this.expanded = this.allFolderPaths(this.changes);
				this.render();
			};
			const collapseBtn = toolbar.createEl("button", { text: "Collapse all" });
			collapseBtn.onclick = () => {
				this.expanded.clear();
				this.render();
			};
		}
	}

	/** Render the folders-then-files under a node, sorted, at the given depth. */
	private renderChildren(
		parent: HTMLElement,
		node: TreeNode,
		depth: number
	): void {
		const entries = [...node.children.values()].sort((a, b) => {
			const aFolder = a.children.size > 0;
			const bFolder = b.children.size > 0;
			if (aFolder !== bFolder) return aFolder ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const child of entries) {
			if (child.children.size > 0) this.renderFolder(parent, child, depth);
			else this.renderFile(parent, child, depth);
		}
	}

	private renderFolder(
		parent: HTMLElement,
		node: TreeNode,
		depth: number
	): void {
		const leaves = this.leavesOf(node);
		const expanded = this.expanded.has(node.path);

		const row = parent.createDiv({ cls: "ragflow-tree-row ragflow-tree-folder" });
		row.style.paddingLeft = `${depth * 16}px`;

		const twisty = row.createSpan({
			cls: "ragflow-tree-twisty",
			text: expanded ? "▾" : "▸",
		});
		twisty.onclick = (e) => {
			e.stopPropagation();
			this.toggleFolder(node.path);
		};

		const box = row.createEl("input", { type: "checkbox" });
		const picked = leaves.filter((l) => this.selected.has(l.path)).length;
		box.checked = picked > 0 && picked === leaves.length;
		box.indeterminate = picked > 0 && picked < leaves.length;
		box.onclick = (e) => e.stopPropagation();
		box.onchange = () => {
			for (const leaf of leaves) {
				if (box.checked) this.selected.add(leaf.path);
				else this.selected.delete(leaf.path);
			}
			this.render();
		};

		const label = row.createDiv({ cls: "ragflow-tree-name" });
		label.setText(node.name);
		label.onclick = () => this.toggleFolder(node.path);

		const summary = this.summaryText(leaves);
		if (summary) {
			row.createSpan({ cls: "ragflow-tree-count", text: summary });
		}

		if (expanded) {
			const childWrap = parent.createDiv({ cls: "ragflow-tree-children" });
			this.renderChildren(childWrap, node, depth + 1);
		}
	}

	private renderFile(
		parent: HTMLElement,
		node: TreeNode,
		depth: number
	): void {
		const change = node.change!;
		const row = parent.createDiv({ cls: "ragflow-tree-row ragflow-tree-file" });
		// Indent past the folder twisty so files line up under the folder name.
		row.style.paddingLeft = `${depth * 16 + 16}px`;

		const box = row.createEl("input", { type: "checkbox" });
		box.checked = this.selected.has(change.vaultPath);
		box.onchange = () => {
			if (box.checked) this.selected.add(change.vaultPath);
			else this.selected.delete(change.vaultPath);
			// A file's tick changes its folders' tri-state, so re-render the tree.
			this.render();
		};

		row.createDiv({ cls: "ragflow-tree-name", text: node.name });
		row.createSpan({
			cls: `ragflow-sync-badge ${change.kind}`,
			text: KIND_LABEL[change.kind],
		});
	}

	/** Collapsible list of ignored (frozen) paths, each with an un-ignore action. */
	private renderIgnored(container: HTMLElement): void {
		const paths = this.plugin.settings.ignoredPaths;
		if (paths.length === 0) return;

		const section = container.createDiv({ cls: "ragflow-sync-ignored" });
		const header = section.createDiv({ cls: "ragflow-tree-row ragflow-ignored-header" });
		const twisty = header.createSpan({
			cls: "ragflow-tree-twisty",
			text: this.ignoredExpanded ? "▾" : "▸",
		});
		twisty.onclick = () => this.toggleIgnored();
		const label = header.createDiv({ cls: "ragflow-tree-name" });
		label.setText(`Ignored (${paths.length})`);
		label.onclick = () => this.toggleIgnored();

		const unignoreAll = header.createEl("button", { text: "Un-ignore all" });
		unignoreAll.onclick = async () => {
			this.plugin.settings.ignoredPaths = [];
			await this.plugin.saveSettings();
			this.render();
			await this.scan();
		};

		if (!this.ignoredExpanded) return;
		const list = section.createDiv({ cls: "ragflow-tree-children" });
		for (const path of paths) {
			const row = list.createDiv({ cls: "ragflow-tree-row ragflow-tree-file" });
			row.style.paddingLeft = "16px";
			row.createDiv({ cls: "ragflow-tree-name", text: path });
			const btn = row.createEl("button", { text: "Un-ignore" });
			btn.onclick = () => void this.unignore(path);
		}
	}

	private toggleIgnored(): void {
		this.ignoredExpanded = !this.ignoredExpanded;
		this.render();
	}

	private toggleFolder(path: string): void {
		if (this.expanded.has(path)) this.expanded.delete(path);
		else this.expanded.add(path);
		this.render();
	}

	/** Reflect the current tick count on the selection-dependent buttons. */
	private updateSelectionUi(): void {
		const n = this.selected.size;
		if (this.syncSelectedBtn) {
			this.syncSelectedBtn.setText(
				n > 0 ? `Sync selected (${n})` : "Sync selected"
			);
			this.syncSelectedBtn.toggleClass("mod-warning", n > 0);
			this.syncSelectedBtn.disabled = n === 0;
		}
		if (this.ignoreSelectedBtn) {
			this.ignoreSelectedBtn.setText(
				n > 0 ? `Ignore selected (${n})` : "Ignore selected"
			);
			this.ignoreSelectedBtn.disabled = n === 0;
		}
	}

	/** Build a nested folder tree from a flat list of file changes. */
	private buildTree(changes: FileChange[]): TreeNode {
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

	/** Every file leaf under a node, in no particular order. */
	private leavesOf(node: TreeNode): TreeNode[] {
		if (node.change && node.children.size === 0) return [node];
		const out: TreeNode[] = [];
		for (const child of node.children.values()) {
			out.push(...this.leavesOf(child));
		}
		return out;
	}

	/** A compact "2 new, 1 modified" summary of a folder's actionable leaves. */
	private summaryText(leaves: TreeNode[]): string {
		const counts: Record<ChangeKind, number> = {
			new: 0,
			modified: 0,
			deleted: 0,
			unchanged: 0,
		};
		for (const leaf of leaves) {
			if (leaf.change) counts[leaf.change.kind] += 1;
		}
		const parts: string[] = [];
		if (counts.new) parts.push(`${counts.new} new`);
		if (counts.modified) parts.push(`${counts.modified} modified`);
		if (counts.deleted) parts.push(`${counts.deleted} deleted`);
		return parts.join(", ");
	}

	/** Ancestor folders of every actionable change — the default-expanded set. */
	private foldersWithChanges(changes: FileChange[]): Set<string> {
		const set = new Set<string>();
		for (const change of changes) {
			if (change.kind === "unchanged") continue;
			this.addAncestorFolders(change.vaultPath, set);
		}
		return set;
	}

	/** Every folder path in the tree, for "Expand all". */
	private allFolderPaths(changes: FileChange[]): Set<string> {
		const set = new Set<string>();
		for (const change of changes) {
			this.addAncestorFolders(change.vaultPath, set);
		}
		return set;
	}

	private addAncestorFolders(vaultPath: string, set: Set<string>): void {
		const parts = vaultPath.split("/");
		let acc = "";
		for (let i = 0; i < parts.length - 1; i++) {
			acc = acc ? `${acc}/${parts[i]}` : parts[i];
			set.add(acc);
		}
	}
}
