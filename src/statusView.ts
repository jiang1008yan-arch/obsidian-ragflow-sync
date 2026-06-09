import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type RagflowSyncPlugin from "./main";
import { ChangeKind, FileChange } from "./types";
import { summarize } from "./syncEngine";

export const VIEW_TYPE_RAGFLOW_SYNC = "ragflow-sync-view";

const KIND_ORDER: ChangeKind[] = ["new", "modified", "deleted", "unchanged"];
const KIND_LABEL: Record<ChangeKind, string> = {
	new: "New",
	modified: "Modified",
	deleted: "Deleted",
	unchanged: "Up to date",
};

export class RagflowSyncView extends ItemView {
	plugin: RagflowSyncPlugin;
	private changes: FileChange[] = [];
	private statusEl: HTMLElement | null = null;
	private busy = false;
	/** Vault paths the user has ticked for a manual re-upload. */
	private selected: Set<string> = new Set();
	/** The "Re-sync selected" button, kept so its label can update live. */
	private resyncBtn: HTMLButtonElement | null = null;

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
			// A fresh scan invalidates any prior tick state.
			this.selected.clear();
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

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("ragflow-sync-view");

		const toolbar = container.createDiv({ cls: "ragflow-sync-toolbar" });

		const scanBtn = toolbar.createEl("button", { text: "Scan diff" });
		scanBtn.onclick = () => void this.scan();

		const syncAllBtn = toolbar.createEl("button", { text: "Sync all" });
		syncAllBtn.addClass("mod-cta");
		syncAllBtn.onclick = () => void this.syncChanges(this.changes);

		this.resyncBtn = toolbar.createEl("button", { text: "Re-sync selected" });
		this.resyncBtn.onclick = () => void this.syncSelected();

		this.statusEl = container.createDiv({ cls: "ragflow-sync-status" });

		if (this.changes.length === 0) {
			container.createDiv({
				cls: "ragflow-sync-empty",
				text: 'No scan results yet. Click "Scan diff" to compare your vault with RAGFlow.',
			});
			this.updateSelectionUi();
			return;
		}

		const byKind = new Map<ChangeKind, FileChange[]>();
		for (const kind of KIND_ORDER) byKind.set(kind, []);
		for (const change of this.changes) byKind.get(change.kind)!.push(change);

		for (const kind of KIND_ORDER) {
			const list = byKind.get(kind)!;
			if (list.length === 0) continue;

			const group = container.createDiv({ cls: "ragflow-sync-group" });
			const header = group.createDiv({ cls: "ragflow-sync-group-header" });

			// Group-level "select all": tick every file in this group at once.
			const groupToggle = header.createEl("label", {
				cls: "ragflow-sync-group-toggle",
			});
			const allTicked = list.every((c) => this.selected.has(c.vaultPath));
			const groupBox = groupToggle.createEl("input", { type: "checkbox" });
			groupBox.checked = allTicked;
			groupBox.onchange = () => {
				for (const c of list) {
					if (groupBox.checked) this.selected.add(c.vaultPath);
					else this.selected.delete(c.vaultPath);
				}
				this.render();
			};
			groupToggle.createSpan({ text: `${KIND_LABEL[kind]} (${list.length})` });

			if (kind !== "unchanged") {
				const btn = header.createEl("button", { text: "Sync these" });
				btn.onclick = () => void this.syncChanges(list);
			}

			for (const change of list) {
				const item = group.createDiv({ cls: "ragflow-sync-item" });

				const main = item.createDiv({ cls: "ragflow-sync-item-main" });
				const box = main.createEl("input", { type: "checkbox" });
				box.checked = this.selected.has(change.vaultPath);
				box.onchange = () => {
					if (box.checked) this.selected.add(change.vaultPath);
					else this.selected.delete(change.vaultPath);
					this.updateSelectionUi();
				};
				main.createDiv({
					cls: "ragflow-sync-item-path",
					text: change.vaultPath,
				});

				item.createSpan({
					cls: `ragflow-sync-badge ${kind}`,
					text: KIND_LABEL[kind],
				});
			}
		}

		this.updateSelectionUi();
	}

	/** Reflect the current tick count on the "Re-sync selected" button. */
	private updateSelectionUi(): void {
		if (!this.resyncBtn) return;
		const n = this.selected.size;
		this.resyncBtn.setText(
			n > 0 ? `Re-sync selected (${n})` : "Re-sync selected"
		);
		this.resyncBtn.toggleClass("mod-warning", n > 0);
		this.resyncBtn.disabled = n === 0;
	}
}
