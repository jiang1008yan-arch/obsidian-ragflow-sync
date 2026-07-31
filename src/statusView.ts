import { App, ItemView, Menu, Modal, Notice, WorkspaceLeaf } from "obsidian";
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
 * Confirmation for the menu actions, which rewrite whole datasets rather than
 * the files the user picked. Runs the callback only if the confirm button is
 * pressed; dismissing the modal any other way cancels.
 */
class ConfirmModal extends Modal {
	private title: string;
	private lines: string[];
	private confirmLabel: string;
	private onConfirm: () => void;
	private confirmed = false;

	constructor(
		app: App,
		title: string,
		lines: string[],
		confirmLabel: string,
		onConfirm: () => void
	) {
		super(app);
		this.title = title;
		this.lines = lines;
		this.confirmLabel = confirmLabel;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		for (const line of this.lines) {
			this.contentEl.createEl("p", { text: line });
		}

		const buttons = this.contentEl.createDiv({ cls: "ragflow-modal-buttons" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();

		const confirm = buttons.createEl("button", { text: this.confirmLabel });
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
	/** Per-dataset tallies from the last scan's RAGFlow check. */
	private counts: DatasetCount[] = [];
	/** Why the RAGFlow half of the scan is missing or incomplete, if it is. */
	private remoteNote: string | null = null;
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
	private syncBtn: HTMLButtonElement | null = null;
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

	/**
	 * One scan answers everything: what changed locally, and what the RAGFlow
	 * datasets actually hold.
	 *
	 * The remote half used to be a second button the user had to know to press,
	 * which made a mismatched document count look like the plugin was failing to
	 * notice it. Reading every mapped dataset costs one request per hundred
	 * documents — seconds, not minutes — so there is no reason to make it opt-in.
	 * When RAGFlow cannot be reached the local half still stands on its own and
	 * is shown with a warning, rather than failing the whole scan.
	 */
	async scan(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.setStatus("Scanning your vault...");
		try {
			const result = await this.plugin.engine.computeDiff();
			this.changes = result.changes;
			this.scanned = true;
			// A fresh scan is a clean slate: drop any prior selection and the
			// previous remote findings, which were about a since-replaced list.
			this.selected.clear();
			this.clearRemote();
			if (result.missingMappings.length > 0) {
				new Notice(
					`Some mapped folders were not found: ${result.missingMappings
						.map((m) => m.vaultPath)
						.join(", ")}`
				);
			}

			await this.checkRemote();

			this.expanded = foldersWithChanges(this.changes);
			this.render();
			this.setStatus(this.scanSummary());
		} catch (e) {
			new Notice(`Scan failed: ${(e as Error).message}`);
			this.setStatus(`Scan failed: ${(e as Error).message}`);
		} finally {
			this.busy = false;
		}
	}

	/**
	 * The RAGFlow half of a scan. Never throws: a connection problem downgrades
	 * the scan to its local half with an explanation, because "here is what
	 * changed on disk" is still worth showing when the server is unreachable.
	 */
	private async checkRemote(): Promise<void> {
		if (!this.plugin.settings.apiKey) {
			this.remoteNote =
				"No API key set, so RAGFlow was not checked — the list below reflects " +
				"the plugin's local record only.";
			return;
		}
		try {
			const result = await this.plugin.engine.reconcile(this.changes, (label) =>
				this.setStatus(label)
			);
			this.changes = result.changes;
			this.orphans = result.orphans;
			this.counts = result.counts;
			await this.plugin.saveSettings();
			if (result.absentDatasets.length > 0) {
				this.remoteNote = `Not found in RAGFlow yet: ${result.absentDatasets.join(
					", "
				)}. They are created on the first sync.`;
			}
		} catch (e) {
			this.remoteNote =
				`Could not read RAGFlow (${(e as Error).message}) — the list below ` +
				`reflects the plugin's local record only, so documents added or ` +
				`deleted on the RAGFlow side are not accounted for.`;
		}
	}

	private scanSummary(): string {
		const counts = summarize(this.changes);
		const parts = [
			`${counts.new} new`,
			`${counts.modified} modified`,
			`${counts.deleted} deleted`,
		];
		if (counts.missing > 0) parts.push(`${counts.missing} missing from RAGFlow`);
		if (this.orphans.length > 0) {
			parts.push(`${this.orphans.length} only in RAGFlow`);
		}
		parts.push(`${counts.unchanged} up to date`);
		return `Scan complete: ${parts.join(", ")}.`;
	}

	private clearRemote(): void {
		this.orphans = [];
		this.counts = [];
		this.remoteNote = null;
		this.selectedOrphans.clear();
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
		new ConfirmModal(
			this.app,
			"Mirror vault to RAGFlow",
			lines,
			"Mirror",
			() => void this.runMirror(plan)
		).open();
	}

	/**
	 * Force re-upload, behind a confirmation: it re-sends every in-scope file
	 * regardless of the diff, and each upload is re-parsed by RAGFlow, so on a
	 * large vault it is a much bigger job than the button it sits next to.
	 */
	private confirmForceSyncAll(): void {
		if (this.busy) return;
		const total = this.changes.filter((c) => !c.ignored).length;
		if (total === 0) {
			new Notice("Nothing to re-upload. Run a scan first.");
			return;
		}
		new ConfirmModal(
			this.app,
			"Force re-upload every file",
			[
				`Re-upload all ${total} in-scope file(s), including the ones already ` +
					`up to date.`,
				"RAGFlow re-parses everything that is uploaded, so this can take a " +
					"long time on a large vault. Snoozed (ignored) files are skipped.",
			],
			"Re-upload all",
			() => void this.forceSyncAll()
		).open();
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

		this.syncBtn = null;
		this.deleteOrphansBtn = null;

		this.renderTabs(container.createDiv({ cls: "ragflow-sync-tabs" }));

		const toolbar = container.createDiv({ cls: "ragflow-sync-toolbar" });
		this.renderToolbar(toolbar);

		this.statusEl = container.createDiv({ cls: "ragflow-sync-status" });

		if (this.activeTab === "diff") {
			if (this.remoteNote) {
				container.createDiv({
					cls: "ragflow-sync-warning",
					text: this.remoteNote,
				});
			}
			this.renderCounts(container);
			this.renderOrphans(container);
		}

		const data = this.tabData();
		if (this.changes.length === 0) {
			container.createDiv({
				cls: "ragflow-sync-empty",
				text: 'No results yet. Click "Scan" to compare your vault with RAGFlow.',
			});
		} else if (data.length === 0) {
			container.createDiv({
				cls: "ragflow-sync-empty",
				text:
					this.activeTab === "diff"
						? "Everything is up to date."
						: "No files in scope. Check your dataset mappings in settings.",
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
		// Named for what each lists, not for an action — the toolbar owns the verbs.
		tab("diff", "Changes");
		tab("sync", "All files");
	}

	/**
	 * Three controls, not six. One scan covers both halves of the comparison, one
	 * sync button follows the selection instead of pairing "all" with "selected",
	 * and "Ignore" only appears once there is a selection to ignore.
	 *
	 * The rarer whole-dataset actions hang off the sync button in a menu rather
	 * than taking toolbar slots of their own. They belong next to Sync because
	 * that is what they are variations on, but both rewrite far more than the
	 * everyday button does — Mirror deletes in bulk — so a click on the caret
	 * stands between them and a mis-aimed click on Sync.
	 */
	private renderToolbar(toolbar: HTMLElement): void {
		if (this.activeTab === "diff") {
			const scanBtn = toolbar.createEl("button", { text: "Scan" });
			scanBtn.title =
				"Compare your vault against RAGFlow: what changed locally, and what " +
				"the datasets actually hold.";
			scanBtn.onclick = () => void this.scan();
		}

		const group = toolbar.createDiv({ cls: "ragflow-sync-split" });
		this.syncBtn = group.createEl("button", { text: "Sync" });
		this.syncBtn.addClass("mod-cta");
		this.syncBtn.onclick = () => void this.syncFromToolbar();

		const moreBtn = group.createEl("button", { text: "▾" });
		moreBtn.addClass("ragflow-sync-more");
		moreBtn.title = "Other sync actions";
		moreBtn.onclick = (event) => this.showSyncMenu(event);

		// Only meaningful with a selection, so it stays out of the way until then.
		if (this.activeTab === "diff" && this.selected.size > 0) {
			const ignoreBtn = toolbar.createEl("button", {
				text: `Ignore selected (${this.selected.size})`,
			});
			ignoreBtn.title =
				"Stop showing these files as changes, without deleting anything " +
				"already in RAGFlow. They come back if their content changes.";
			ignoreBtn.onclick = () => void this.ignoreSelected();
		}
	}

	/** The whole-dataset actions, one click removed from the everyday button. */
	private showSyncMenu(event: MouseEvent): void {
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("Mirror: make RAGFlow match my folders…")
				.setIcon("copy")
				.onClick(() => void this.mirror())
		);
		menu.addItem((item) =>
			item
				.setTitle("Force re-upload every file…")
				.setIcon("refresh-cw")
				.onClick(() => void this.confirmForceSyncAll())
		);

		menu.showAtMouseEvent(event);
	}

	/**
	 * The one sync button: ticked files if any are ticked, everything otherwise.
	 * On the Sync tab there is nothing to apply without a selection, since every
	 * file there is offered for a forced re-upload.
	 */
	private async syncFromToolbar(): Promise<void> {
		if (this.selected.size > 0) return this.syncSelected();
		if (this.activeTab === "sync") {
			new Notice("Tick the files you want to re-upload.");
			return;
		}
		return this.syncAll();
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
		if (this.syncBtn) {
			// The label is the explanation: it always names exactly what will run.
			const pending =
				this.activeTab === "diff" ? syncAllChanges(this.changes).length : 0;
			this.syncBtn.setText(
				n > 0
					? `Sync selected (${n})`
					: pending > 0
						? `Sync all (${pending})`
						: "Sync"
			);
			this.syncBtn.disabled = n === 0 && pending === 0;
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
