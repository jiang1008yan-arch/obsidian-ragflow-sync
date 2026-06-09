import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, RagflowSyncSettingTab } from "./settings";
import { RagflowClient } from "./ragflowClient";
import { SyncStateStore } from "./syncState";
import { SyncEngine } from "./syncEngine";
import { RagflowSyncView, VIEW_TYPE_RAGFLOW_SYNC } from "./statusView";
import { DatasetMapping, RagflowSyncSettings } from "./types";

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
			name: "Scan for differences",
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Ensure nested state object exists and is well-formed.
		this.settings.state = Object.assign({ files: {} }, data.state ?? {});
		// Own the array rather than sharing DEFAULT_SETTINGS' reference, so edits
		// (and the migration below) never mutate the defaults.
		this.settings.companionMetadataPaths = [
			...(data.companionMetadataPaths ?? []),
		];
		this.migrateLegacyData(data);
	}

	/**
	 * Migrate data.json written by the File-Management era of the plugin:
	 * `folderMappings` (vault folder -> RAGFlow folder path) become
	 * `datasetMappings` (vault folder -> dataset name), and any synced records
	 * still keyed to File-Management files are dropped so everything re-syncs
	 * into datasets on the next run.
	 */
	private migrateLegacyData(data: Record<string, unknown>): void {
		const legacyMappings = data.folderMappings as
			| { vaultPath?: string; ragflowBaseFolder?: string }[]
			| undefined;
		if (legacyMappings && this.settings.datasetMappings.length === 0) {
			this.settings.datasetMappings = legacyMappings.map((m) => ({
				vaultPath: m.vaultPath ?? "",
				datasetName: m.ragflowBaseFolder ?? "",
			}));
		}
		delete (this.settings as unknown as Record<string, unknown>).folderMappings;

		// The per-mapping `companionMetadata` flag was replaced by the path-based
		// `companionMetadataPaths` list. Carry any enabled mappings over, then drop
		// the obsolete flag from each mapping.
		for (const mapping of this.settings.datasetMappings as Array<
			DatasetMapping & { companionMetadata?: boolean }
		>) {
			if (
				mapping.companionMetadata &&
				!this.settings.companionMetadataPaths.includes(mapping.vaultPath)
			) {
				this.settings.companionMetadataPaths.push(mapping.vaultPath);
			}
			delete mapping.companionMetadata;
		}

		const files = this.settings.state.files;
		const isLegacyRecord = Object.values(files).some(
			(r) => (r as { documentId?: string }).documentId === undefined
		);
		if (isLegacyRecord) {
			this.settings.state.files = {};
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
