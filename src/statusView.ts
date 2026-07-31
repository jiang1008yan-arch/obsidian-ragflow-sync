import { App, ItemView, Modal, Notice, WorkspaceLeaf } from "obsidian";
import type RagflowSyncPlugin from "./main";
import {
	ChangeKind,
	DatasetCount,
	FileChange,
	MirrorPlan,
	RemoteOrphan,
} from "./types";
import { mirrorTotals } from "./mirror";
import { summarize } from "./syncEngine";
import {
	countNotes,
	forceAllChanges,
	forceSelectedChanges,
	syncAllChanges,
	syncSelectedChanges,
	tabData,
	type PanelTab,
} from "./panelState";
import {
	buildTree,
	changeSummary,
	foldersWithChanges,
	isFileLeaf,
	leavesOf,
	sortedChildren,
	TreeNode,
} from "./tree";

export const VIEW_TYPE_RAGFLOW_SYNC = "ragflow-sync-view";

/**
 * Confirmation for a Mirror, which is the one action that deletes documents
 * without the user having picked them one by one. Resolves true only if the
 * confirm button is pressed; dismissing the modal any other way cancels.
 */
class MirrorConfirmModal extends Modal {
	private lines: string[];
	private onConfirm: () => void;
	private confirmed = false;

	constructor(app: App, lines: string[], onConfirm: () => void) {
		super(app);
		this.lines = lines;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.titleEl.setText("Mirror vault to RAGFlow");
		for (const line of this.lines) {
			this.contentEl.createEl("p", { text: line });
		}

		const buttons = this.contentEl.createDiv({ cls: "ragflow-modal-buttons" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();

		const confirm = buttons.createEl("button", { text: "Mirror" });
		confirm.addClass("mod-warning");
		confirm.onclick = () => {
			this.confirmed = true;
			this.close();
		};
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.confirmed) this.onConfirm();
	}
}

const KIND_LABEL: Record<ChangeKind, string> = {
	new: "New",
	modified: "Modified",
	deleted: "Deleted",
	unchanged: "Up to date",
	missing: "Missing in RAGFlow",
};

export class RagflowSyncView extends ItemView {
	plugin: RagflowSyncPlugin;
	/** The full diff: every in-scope file (all kinds) plus deletions. */
	private changes: FileChange[] = [];
	/** RAGFlow documents nothing in the vault accounts for; empty until a reconcile. */
	private orphans: RemoteOrphan[] = [];
	/** Per-dataset tallies from the last reconcile. */
	private counts: DatasetCount[] = [];
	private statusEl: HTMLElement | null = null;
	/** Whether a scan has completed, as distinct from having found changes. */
	private scanned = false;
	private busy = false;
	/** Which tab is showing: the Scan-diff list or the full Sync picker. */
	private activeTab: PanelTab = "diff";
	/** Vault paths ticked in the current tab. Reset when the tab changes. */
	private selected: Set<string> = new Set();
	/** Orphan document ids ticked for deletion. Reset by every scan/reconcile. */
	private selectedOrphans: Set<string> = new Set();
	/** Folder paths currently expanded in the tree. */
	private expanded: Set<string> = new Set();
	/** Selection-dependent buttons, kept so their labels can update live. */
	private syncSelectedBtn: HTMLButtonElement | null = null;
	private ignoreSelectedBtn: HTMLButtonElement | null = null;
	private deleteOrphansBtn: HTMLButtonElement | null = null;

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
			this.scanned = true;
			// A fresh scan is a clean slate: drop any prior selection and expand the
			// folders that hold visible entries so they are visible at a glance. The
			// previous reconcile result is discarded with it — these changes were
			// classified without consulting RAGFlow, so its findings no longer apply.
			this.selected.clear();
			this.clearReconcile();
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

	private clearReconcile(): void {
		this.orphans = [];
		this.counts = [];
		this.selectedOrphans.clear();
	}

	/**
	 * Remote reconcile: ask RAGFlow what it actually holds and fold the answer
	 * into the current scan. A plain scan compares the vault with the local
	 * synced state only, so drift on the RAGFlow side — documents uploaded
	 * outside the plugin, leftovers from a lost synced state, "name(n).ext"
	 * duplicates, documents deleted in the RAGFlow UI — is invisible to it and
	 * only shows up here.
	 */
	async reconcile(): Promise<void> {
		if (this.busy) return;
		if (!this.plugin.settings.apiKey) {
			new Notice("Set your RAGFlow API key in settings first.");
			return;
		}
		// Gate on "has a scan run", not "did it find anything": a vault with no
		// in-scope files at all is precisely when a dataset full of orphans matters.
		if (!this.scanned) await this.scan();
		if (!this.scanned) return;

		this.busy = true;
		this.setStatus("Reconciling with RAGFlow...");
		try {
			const result = await this.plugin.engine.reconcile(this.changes, (label) =>
				this.setStatus(label)
			);
			this.changes = result.changes;
			this.orphans = result.orphans;
			this.selectedOrphans.clear();
			this.counts = result.counts;
			await this.plugin.saveSettings();
			this.expanded = foldersWithChanges(this.changes);
			this.render();

			const missing = summarize(this.changes).missing;
			const parts = [`${this.orphans.length} orphaned document(s) in RAGFlow`];
			if (missing > 0) parts.push(`${missing} file(s) missing from RAGFlow`);
			if (result.absentDatasets.length > 0) {
				parts.push(`dataset(s) not found: ${result.absentDatasets.join(", ")}`);
			}
			this.setStatus(`Reconcile complete: ${parts.join(", ")}.`);
		} catch (e) {
			new Notice(`Reconcile failed: ${(e as Error).message}`);
			this.setStatus(`Reconcile failed: ${(e as Error).message}`);
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Mirror: make every mapped dataset match its source folder exactly —
	 * documents the folder does not account for are deleted, files the dataset
	 * lacks are uploaded, names on both sides are left alone.
	 *
	 * Unlike a scan or a reconcile this judges by name rather than through the
	 * local synced state, so it is the recovery path when that state is wrong or
	 * lost. It disregards snoozes, and it always confirms first, because it is
	 * the one action that deletes documents the user did not pick individually.
	 */
	async mirror(): Promise<void> {
		if (this.busy) return;
		if (!this.plugin.settings.apiKey) {
			new Notice("Set your RAGFlow API key in settings first.");
			return;
		}
		if (!this.scanned) await this.scan();
		if (!this.scanned) return;

		this.busy = true;
		this.setStatus("Planning mirror...");
		let plan: MirrorPlan;
		try {
			plan = await this.plugin.engine.planMirror(this.changes, (label) =>
				this.setStatus(label)
			);
		} catch (e) {
			new Notice(`Mirror planning failed: ${(e as Error).message}`);
			this.setStatus(`Mirror planning failed: ${(e as Error).message}`);
			this.busy = false;
			return;
		}
		this.busy = false;

		const totals = mirrorTotals(plan);
		if (totals.uploads === 0 && totals.deletes === 0) {
			this.setStatus(
				`Mirror: already matching (${totals.kept} document(s) in place).`
			);
			new Notice("RAGFlow already matches your vault.");
			return;
		}

		const lines = [
			`Upload ${totals.uploads} file(s) to RAGFlow.`,
			`Delete ${totals.deletes} document(s) from RAGFlow.`,
			`Leave ${totals.kept} document(s) untouched.`,
			"Deletions cannot be undone. Snoozed (ignored) files are included: a " +
				"mirror makes RAGFlow match your vault exactly.",
		];
		new MirrorConfirmModal(this.app, lines, () => void this.runMirror(plan)).open();
	}

	/** Execute a confirmed Mirror plan: uploads and record-clearing deletes first, then orphans. */
	private async runMirror(plan: MirrorPlan): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const applied = await this.plugin.engine.applyChanges(
				plan.changes,
				(done, total, label) => this.setStatus(`Mirroring ${done}/${total}: ${label}`)
			);
			const removed = await this.plugin.engine.deleteOrphans(
				plan.orphanDeletes,
				(done, total, label) => this.setStatus(`${label} ${done}/${total}`)
			);

			let msg = `Mirror done: ${applied.ok} file(s) synced`;
			if (removed.ok > 0) msg += `, ${removed.ok} document(s) deleted`;
			if (applied.parsed > 0) msg += `, parsing ${applied.parsed}`;
			const failed = applied.failed + removed.failed;
			if (failed > 0) msg += `, ${failed} failed`;
			msg += ".";
			new Notice(msg);

			const errors = [...applied.errors, ...removed.errors];
			if (errors.length > 0) console.error("RAGFlow Sync mirror errors:", errors);
		} catch (e) {
			new Notice(`Mirror failed: ${(e as Error).message}`);
		} finally {
			this.busy = false;
			await this.scan();
		}
	}

	/**
	 * Delete the ticked orphans from RAGFlow. Deliberately its own action rather
	 * than part of "Sync all": a mapped dataset may legitimately hold documents
	 * that did not come from this vault, and those must not be swept away by the
	 * ordinary sync button.
	 */
	async deleteSelectedOrphans(): Promise<void> {
		if (this.busy) return;
		const picked = this.orphans.filter((o) =>
			this.selectedOrphans.has(o.documentId)
		);
		if (picked.length === 0) {
			new Notice("Tick the orphaned documents you want to delete.");
			return;
		}
		this.busy = true;
		try {
			const result = await this.plugin.engine.deleteOrphans(
				picked,
				(done, total, label) => this.setStatus(`${label} ${done}/${total}`)
			);
			let msg = `Deleted ${result.ok} orphaned document(s).`;
			if (result.failed > 0) msg += ` ${result.failed} failed.`;
			new Notice(msg);
			if (result.errors.length > 0) {
				console.error("RAGFlow Sync orphan delete errors:", result.errors);
			}
			// Drop what RAGFlow accepted; anything that failed stays listed to retry.
			const gone = new Set(result.deletedIds);
			this.orphans = this.orphans.filter((o) => !gone.has(o.documentId));
			// The per-dataset tallies counted the documents we just removed.
			this.counts = [];
			this.selectedOrphans.clear();
			this.render();
			this.setStatus(msg);
		} catch (e) {
			new Notice(`Delete failed: ${(e as Error).message}`);
		} finally {
			this.busy = false;
		}
	}

	/** Apply every Scan-diff-visible change that is not snoozed. */
	async syncAll(): Promise<void> {
		await this.syncChanges(syncAllChanges(this.changes));
	}

	/** Apply exactly the files the user ticked in the active tab. */
	async syncSelected(): Promise<void> {
		const selectedChanges =
			this.activeTab === "diff"
				? syncSelectedChanges(this.changes, this.selected)
				: forceSelectedChanges(this.changes, this.selected);
		if (selectedChanges.length === 0) {
			new Notice("Tick files or folders to sync.");
			return;
		}
		await this.syncChanges(selectedChanges);
	}

	/**
	 * Re-upload every in-scope file regardless of diff result, by promoting
	 * "unchanged" entries to "modified". Snoozed (ignored) files are left alone.
	 * The command-palette "force re-sync" escape hatch; the panel offers per-file
	 * selection instead.
	 */
	async forceSyncAll(): Promise<void> {
		await this.syncChanges(forceAllChanges(this.changes));
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

	/** The change list backing the active tab. */
	private tabData(): FileChange[] {
		return tabData(this.activeTab, this.changes);
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("ragflow-sync-view");

		this.syncSelectedBtn = null;
		this.ignoreSelectedBtn = null;
		this.deleteOrphansBtn = null;

		this.renderTabs(container.createDiv({ cls: "ragflow-sync-tabs" }));

		const toolbar = container.createDiv({ cls: "ragflow-sync-toolbar" });
		this.renderToolbar(toolbar);

		this.statusEl = container.createDiv({ cls: "ragflow-sync-status" });

		if (this.activeTab === "diff") {
			this.renderCounts(container);
			this.renderOrphans(container);
		}

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
		const tab = (id: PanelTab, label: string) => {
			const btn = bar.createEl("button", { text: label });
			btn.toggleClass("mod-cta", this.activeTab === id);
			btn.onclick = () => {
				if (this.activeTab === id) return;
				this.activeTab = id;
				this.selected.clear();
				this.render();
				// The Sync picker has no scan button of its own; load the file list
				// on first visit so it isn't an empty tab with no way to populate it.
				if (id === "sync" && this.changes.length === 0) void this.scan();
			};
		};
		tab("diff", "Scan diff");
		tab("sync", "Sync");
	}

	private renderToolbar(toolbar: HTMLElement): void {
		if (this.activeTab === "diff") {
			const scanBtn = toolbar.createEl("button", { text: "Scan diff" });
			scanBtn.onclick = () => void this.scan();

			const reconcileBtn = toolbar.createEl("button", { text: "Reconcile" });
			reconcileBtn.title =
				"Compare against the documents actually in RAGFlow. A scan only " +
				"compares your vault with the plugin's local record, so documents " +
				"added or deleted on the RAGFlow side never show up in it.";
			reconcileBtn.onclick = () => void this.reconcile();

			const mirrorBtn = toolbar.createEl("button", { text: "Mirror" });
			mirrorBtn.title =
				"Make RAGFlow match your vault folders exactly: delete documents " +
				"the folders do not account for, upload what is missing, leave the " +
				"rest alone. Judged by filename rather than the plugin's local " +
				"record, so it works even when that record is wrong. Confirms first.";
			mirrorBtn.onclick = () => void this.mirror();

			this.syncSelectedBtn = toolbar.createEl("button", {
				text: "Sync selected",
			});
			this.syncSelectedBtn.addClass("mod-cta");
			this.syncSelectedBtn.onclick = () => void this.syncSelected();

			const syncAllBtn = toolbar.createEl("button", { text: "Sync all" });
			syncAllBtn.onclick = () => void this.syncAll();

			this.ignoreSelectedBtn = toolbar.createEl("button", {
				text: "Ignore selected",
			});
			this.ignoreSelectedBtn.onclick = () => void this.ignoreSelected();
		} else {
			this.syncSelectedBtn = toolbar.createEl("button", {
				text: "Sync selected",
			});
			this.syncSelectedBtn.addClass("mod-cta");
			this.syncSelectedBtn.onclick = () => void this.syncSelected();
		}
	}

	/**
	 * The per-dataset tallies from the last reconcile, one line per dataset plus
	 * a note wherever a number needs explaining. The three counts answer
	 * different questions: RAGFlow below tracked means documents were lost
	 * remotely, tracked below vault means files were never uploaded.
	 */
	private renderCounts(container: HTMLElement): void {
		if (this.counts.length === 0) return;
		const box = container.createDiv({ cls: "ragflow-sync-counts" });
		for (const c of this.counts) {
			box.createDiv({
				cls: "ragflow-sync-count-line",
				text:
					`${c.datasetName}: ${c.remote} in RAGFlow / ` +
					`${c.tracked} tracked / ${c.inScope} in vault`,
			});
			for (const note of countNotes(c)) {
				box.createDiv({ cls: "ragflow-sync-count-note", text: note });
			}
		}
	}

	/**
	 * Orphaned RAGFlow documents, listed outside the file tree because they have
	 * no vault path to hang under — they exist only on the RAGFlow side.
	 */
	private renderOrphans(container: HTMLElement): void {
		if (this.orphans.length === 0) return;

		const section = container.createDiv({ cls: "ragflow-sync-orphans" });
		const header = section.createDiv({ cls: "ragflow-sync-orphans-header" });

		const all = header.createEl("input", { type: "checkbox" });
		all.checked = this.selectedOrphans.size === this.orphans.length;
		all.indeterminate =
			this.selectedOrphans.size > 0 &&
			this.selectedOrphans.size < this.orphans.length;
		all.onchange = () => {
			this.selectedOrphans.clear();
			if (all.checked) {
				for (const o of this.orphans) this.selectedOrphans.add(o.documentId);
			}
			this.render();
		};

		header.createDiv({
			cls: "ragflow-tree-name",
			text: `In RAGFlow only (${this.orphans.length})`,
		});

		this.deleteOrphansBtn = header.createEl("button", {
			text: "Delete from RAGFlow",
		});
		this.deleteOrphansBtn.addClass("mod-warning");
		this.deleteOrphansBtn.onclick = () => void this.deleteSelectedOrphans();

		for (const orphan of this.orphans) {
			const row = section.createDiv({
				cls: "ragflow-tree-row ragflow-tree-file",
			});
			const box = row.createEl("input", { type: "checkbox" });
			box.checked = this.selectedOrphans.has(orphan.documentId);
			box.onchange = () => {
				if (box.checked) this.selectedOrphans.add(orphan.documentId);
				else this.selectedOrphans.delete(orphan.documentId);
				this.render();
			};
			row.createDiv({ cls: "ragflow-tree-name", text: orphan.documentName });
			row.createSpan({
				cls: "ragflow-tree-count",
				text: orphan.datasetName,
			});
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
		// Only New / Modified / Deleted reach here — unchanged and ignored files
		// are filtered out of the Scan diff list.
		if (this.activeTab === "diff") {
			row.createSpan({
				cls: `ragflow-sync-badge ${change.kind}`,
				text: KIND_LABEL[change.kind],
			});
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
			this.ignoreSelectedBtn.setText(
				n > 0 ? `Ignore selected (${n})` : "Ignore selected"
			);
			this.ignoreSelectedBtn.disabled = n === 0;
		}
		if (this.deleteOrphansBtn) {
			const picked = this.selectedOrphans.size;
			this.deleteOrphansBtn.setText(
				picked > 0
					? `Delete ${picked} from RAGFlow`
					: "Delete from RAGFlow"
			);
			this.deleteOrphansBtn.disabled = picked === 0;
		}
	}
}
