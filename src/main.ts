import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { RagflowSyncSettingTab } from "./settings";
import { normalizeSettings } from "./settingsMigration";
import { RagflowClient } from "./ragflowClient";
import { SyncStateStore } from "./syncState";
import { SyncEngine } from "./syncEngine";
import { RagflowSyncView, VIEW_TYPE_RAGFLOW_SYNC } from "./statusView";
import { RagflowSyncSettings } from "./types";

export default class RagflowSyncPlugin extends Plugin {
	settings!: RagflowSyncSettings;
	client!: RagflowClient;
	store!: SyncStateStore;
	engine!: SyncEngine;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.client = new RagflowClient(() => this.settings);
		this.store = new SyncStateStore(this.settings.state, () =>
			this.saveSettings()
		);
		this.engine = new SyncEngine(
			this.app,
			this.client,
			this.store,
			() => this.settings
		);

		this.registerView(
			VIEW_TYPE_RAGFLOW_SYNC,
			(leaf) => new RagflowSyncView(leaf, this)
		);

		this.addRibbonIcon("refresh-cw", "RAGFlow Sync", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-ragflow-sync-panel",
			name: "Open sync panel",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "ragflow-scan-diff",
			name: "Scan (vault and RAGFlow)",
			callback: async () => {
				const view = await this.activateView();
				await view?.scan();
			},
		});

		this.addCommand({
			id: "ragflow-sync-all",
			name: "Sync all changes",
			callback: async () => {
				const view = await this.activateView();
				if (!view) return;
				await view.scan();
				await view.syncAll();
			},
		});

		this.addCommand({
			id: "ragflow-mirror",
			name: "Mirror vault to RAGFlow (delete extras, upload what is missing)",
			callback: async () => {
				const view = await this.activateView();
				if (!view) return;
				await view.scan();
				await view.mirror();
			},
		});

		this.addCommand({
			id: "ragflow-force-resync",
			name: "Force re-sync all (re-upload everything)",
			callback: async () => {
				const view = await this.activateView();
				if (!view) return;
				await view.scan();
				await view.forceSyncAll();
			},
		});

		this.addSettingTab(new RagflowSyncSettingTab(this.app, this));
	}

	onunload(): void {
		// Leaves are detached automatically by Obsidian.
	}

	async activateView(): Promise<RagflowSyncView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(VIEW_TYPE_RAGFLOW_SYNC)[0] ?? null;

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: VIEW_TYPE_RAGFLOW_SYNC,
					active: true,
				});
			}
		}
		if (leaf) {
			workspace.revealLeaf(leaf);
			return leaf.view as RagflowSyncView;
		}
		new Notice("Could not open RAGFlow Sync panel.");
		return null;
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) ?? {};
		this.settings = normalizeSettings(data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
