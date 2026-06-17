import { SyncedFileRecord, SyncState } from "./types";

/**
 * Thin wrapper over the persisted SyncState. Mutations update the in-memory
 * state synchronously and mark it dirty; persistence is deferred to flush(),
 * which writes through the provided save callback only when something changed.
 *
 * Deferring the write is what keeps a large sync cheap: data.json holds the
 * whole file database, so the old write-on-every-mutation cost a full
 * serialize-and-write per file (and per touch during a plain scan). Callers now
 * mutate freely and flush periodically / at the end of a batch instead.
 */
export class SyncStateStore {
	private state: SyncState;
	private save: () => Promise<void>;
	private dirty = false;

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

	/** Upsert a record in memory; call flush() to persist. */
	setFile(vaultPath: string, record: SyncedFileRecord): void {
		this.state.files[vaultPath] = record;
		this.dirty = true;
	}

	/** Remove a record in memory; call flush() to persist. */
	deleteFile(vaultPath: string): void {
		delete this.state.files[vaultPath];
		this.dirty = true;
	}

	/** Persist pending mutations, if any. A no-op when nothing changed. */
	async flush(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		await this.save();
	}
}
