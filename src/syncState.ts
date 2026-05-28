import { SyncedFileRecord, SyncState } from "./types";

/**
 * Thin wrapper over the persisted SyncState. Mutations are written through a
 * provided save callback so the plugin's data.json stays in sync.
 */
export class SyncStateStore {
	private state: SyncState;
	private save: () => Promise<void>;

	constructor(state: SyncState, save: () => Promise<void>) {
		this.state = state;
		this.save = save;
	}

	getFile(vaultPath: string): SyncedFileRecord | undefined {
		return this.state.files[vaultPath];
	}

	allFiles(): Record<string, SyncedFileRecord> {
		return this.state.files;
	}

	async setFile(vaultPath: string, record: SyncedFileRecord): Promise<void> {
		this.state.files[vaultPath] = record;
		await this.save();
	}

	async deleteFile(vaultPath: string): Promise<void> {
		delete this.state.files[vaultPath];
		await this.save();
	}
}
