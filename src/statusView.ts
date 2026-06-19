import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type RagflowSyncPlugin from "./main";
import { ChangeKind, FileChange } from "./types";
import { summarize } from "./syncEngine";
import {
	allFolderPaths,
	buildTree,
	changeSummary,
	diffVisible,
	foldersWithChanges,
	isFileLeaf,
	leavesOf,
	sortedChildren,
	TreeNode,
} from "./tree";

export const VIEW_TYPE_RAGFLOW_SYNC = "ragflow-sync-view";

const KIND_LABEL: Record<ChangeKind, string> = {
	new: "New",
	modified: "Modified",
	deleted: "Deleted",
	unchanged: "Up to date",
};

/** The two trees the panel switches between. */
type Tab = "diff" | "sync";

export class RagflowSyncView extends ItemView {
	plugin: RagflowSyncPlugin;
	/** The full diff: every in-scope file (all kinds) plus deletions. */
	private changes: FileChange[] = [];
	private statusEl: HTMLElement | null = null;
	private busy = false;
	/** Which tab is showing: the Scan-diff list or the full Sync picker. */
	private activeTab: Tab = "diff";
	/** Vault paths ticked in the current tab. Reset when the tab changes. */
	private selected: Set<string> = new Set();
	/** Folder paths currently expanded in the tree. */
	private expanded: Set<string> = new Set();
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
			// folders that hold visible entries so they are visible at a glance.
			this.selected.clear();
			this.expanded = foldersWithChanges(this.changes);
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

	/** Apply every Scan-diff-visible change that is not snoozed. */
	async syncAll(): Promise<void> {
		await this.syncChanges(this.changes.filter((c) => !c.ignored));
	}

	/**
	 * Re-upload exactly the files the user ticked in the Sync tab, regardless of
	 * diff result. An "unchanged" pick is promoted to "modified" (hash cleared) so
	 * the upload step rebuilds RAGFlow's copy from the current source. Use to
	 * rebuild specific documents — e.g. ones removed or left in a failed state on
	 * the RAGFlow side — without re-uploading the rest.
	 */
	async syncSelected(): Promise<void> {
		const picks = this.changes.filter((c) => this.selected.has(c.vaultPath));
		if (picks.length === 0) {
			new Notice("Tick files or folders to sync.");
			return;
		}
		const forced = picks.map((c) =>
			c.kind === "unchanged" || c.ignored
				? { ...c, kind: "modified" as ChangeKind, hash: undefined, ignored: false }
				: c
		);
		await this.syncChanges(forced);
	}

	/**
	 * Re-upload every in-scope file regardless of diff result, by promoting
	 * "unchanged" entries to "modified". Snoozed (ignored) files are left alone.
	 * The command-palette "force re-sync" escape hatch; the panel offers per-file
	 * selection instead.
	 */
	async forceSyncAll(): Promise<void> {
		const forced = this.changes
			.filter((c) => !c.ignored)
			.map((c) =>
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
	 * Snooze the ticked files: snapshot each and add it to ignoredEntries so the
	 * Scan diff shows it with an "Ignored" badge and "Sync all" skips it. It
	 * re-surfaces on the next scan once its content drifts from the snapshot.
	 */
	async ignoreSelected(): Promise<void> {
		if (this.selected.size === 0) {
			new Notice("Tick the files you want to ignore.");
			return;
		}
		const picked = [...this.selected];
		for (const path of picked) {
			this.plugin.settings.ignoredEntries[path] =
				await this.plugin.engine.snapshotForIgnore(path);
		}
		await this.plugin.saveSettings();
		// Reflect the snooze immediately without a rescan.
		for (const change of this.changes) {
			if (this.selected.has(change.vaultPath)) change.ignored = true;
		}
		this.selected.clear();
		this.render();
		new Notice(`Ignoring ${picked.length} file(s).`);
	}

	/** Un-snooze the ticked files so they re-enter the diff classified normally. */
	async unignoreSelected(): Promise<void> {
		if (this.selected.size === 0) {
			new Notice("Tick the ignored files you want to un-ignore.");
			return;
		}
		const picked = [...this.selected];
		for (const path of picked) {
			delete this.plugin.settings.ignoredEntries[path];
		}
		await this.plugin.saveSettings();
		for (const change of this.changes) {
			if (this.selected.has(change.vaultPath)) change.ignored = false;
		}
		this.selected.clear();
		this.render();
	}

	/** Whether every ticked file is currently snoozed (drives the toggle label). */
	private allSelectedIgnored(): boolean {
		if (this.selected.size === 0) return false;
		return this.changes
			.filter((c) => this.selected.has(c.vaultPath))
			.every((c) => c.ignored);
	}

	/** The change list backing the active tab. */
	private tabData(): FileChange[] {
		return this.activeTab === "diff"
			? diffVisible(this.changes)
			: // Sync picker: every present in-scope file (deletions have no file).
				this.changes.filter((c) => c.kind !== "deleted");
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("ragflow-sync-view");

		this.syncSelectedBtn = null;
		this.ignoreSelectedBtn = null;

		this.renderTabs(container.createDiv({ cls: "ragflow-sync-tabs" }));

		const toolbar = container.createDiv({ cls: "ragflow-sync-toolbar" });
		this.renderToolbar(toolbar);

		this.statusEl = container.createDiv({ cls: "ragflow-sync-status" });

		const data = this.tabData();
		if (this.changes.length === 0) {
			container.createDiv({
				cls: "ragflow-sync-empty",
				text: 'No scan results yet. Click "Scan diff" to compare your vault with RAGFlow.',
			});
		} else if (data.length === 0) {
			container.createDiv({
				cls: "ragflow-sync-empty",
				text:
					this.activeTab === "diff"
						? "Everything is up to date."
						: "No in-scope files to show.",
			});
		} else {
			const tree = container.createDiv({ cls: "ragflow-sync-tree" });
			this.renderChildren(tree, buildTree(data), 0);
		}

		this.updateSelectionUi();
	}

	/** The Scan diff / Sync segmented toggle. */
	private renderTabs(bar: HTMLElement): void {
		const tab = (id: Tab, label: string) => {
			const btn = bar.createEl("button", { text: label });
			btn.toggleClass("mod-cta", this.activeTab === id);
			btn.onclick = () => {
				if (this.activeTab === id) return;
				this.activeTab = id;
				this.selected.clear();
				this.render();
			};
		};
		tab("diff", "Scan diff");
		tab("sync", "Sync");
	}

	private renderToolbar(toolbar: HTMLElement): void {
		const scanBtn = toolbar.createEl("button", { text: "Scan diff" });
		scanBtn.onclick = () => void this.scan();

		if (this.activeTab === "diff") {
			const syncAllBtn = toolbar.createEl("button", { text: "Sync all" });
			syncAllBtn.addClass("mod-cta");
			syncAllBtn.onclick = () => void this.syncAll();

			this.ignoreSelectedBtn = toolbar.createEl("button", {
				text: "Ignore selected",
			});
			this.ignoreSelectedBtn.onclick = () =>
				void (this.allSelectedIgnored()
					? this.unignoreSelected()
					: this.ignoreSelected());
		} else {
			this.syncSelectedBtn = toolbar.createEl("button", {
				text: "Sync selected",
			});
			this.syncSelectedBtn.addClass("mod-cta");
			this.syncSelectedBtn.onclick = () => void this.syncSelected();
		}

		if (this.changes.length > 0) {
			const expandBtn = toolbar.createEl("button", { text: "Expand all" });
			expandBtn.onclick = () => {
				this.expanded = allFolderPaths(this.tabData());
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
		for (const child of sortedChildren(node)) {
			if (isFileLeaf(child)) this.renderFile(parent, child, depth);
			else this.renderFolder(parent, child, depth);
		}
	}

	private renderFolder(
		parent: HTMLElement,
		node: TreeNode,
		depth: number
	): void {
		const leaves = leavesOf(node);
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

		// The Sync picker is status-free; only the Scan diff tab summarizes counts.
		if (this.activeTab === "diff") {
			const summary = changeSummary(leaves);
			if (summary) {
				row.createSpan({ cls: "ragflow-tree-count", text: summary });
			}
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

		// Badges live only in the Scan diff tab; the Sync picker shows no status.
		if (this.activeTab === "diff") {
			const kind = change.ignored ? "ignored" : change.kind;
			const text = change.ignored ? "Ignored" : KIND_LABEL[change.kind];
			row.createSpan({ cls: `ragflow-sync-badge ${kind}`, text });
		}
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
		}
		if (this.ignoreSelectedBtn) {
			const unignore = this.allSelectedIgnored();
			const verb = unignore ? "Un-ignore selected" : "Ignore selected";
			this.ignoreSelectedBtn.setText(n > 0 ? `${verb} (${n})` : verb);
			this.ignoreSelectedBtn.disabled = n === 0;
		}
	}
}
