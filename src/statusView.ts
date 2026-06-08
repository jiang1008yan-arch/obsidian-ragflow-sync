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
	 * Re-upload every in-scope file regardless of diff result, by promoting
	 * "unchanged" entries to "modified". Use when RAGFlow's copies must be
	 * rebuilt without a content or processing-version change to trigger it.
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

		const forceBtn = toolbar.createEl("button", { text: "Force re-sync all" });
		forceBtn.onclick = () => void this.forceSyncAll();

		this.statusEl = container.createDiv({ cls: "ragflow-sync-status" });

		if (this.changes.length === 0) {
			container.createDiv({
				cls: "ragflow-sync-empty",
				text: 'No scan results yet. Click "Scan diff" to compare your vault with RAGFlow.',
			});
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
			header.createSpan({ text: `${KIND_LABEL[kind]} (${list.length})` });

			if (kind !== "unchanged") {
				const btn = header.createEl("button", { text: "Sync these" });
				btn.onclick = () => void this.syncChanges(list);
			}

			for (const change of list) {
				const item = group.createDiv({ cls: "ragflow-sync-item" });
				item.createDiv({
					cls: "ragflow-sync-item-path",
					text: change.vaultPath,
				});
				item.createSpan({
					cls: `ragflow-sync-badge ${kind}`,
					text: KIND_LABEL[kind],
				});
			}
		}
	}
}
