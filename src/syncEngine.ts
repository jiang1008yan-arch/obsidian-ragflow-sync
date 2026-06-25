import { App } from "obsidian";
import { RagflowClient } from "./ragflowClient";
import { SyncStateStore } from "./syncState";
import { sha256 } from "./hash";
import {
	assembleChanges,
	classifyByStat,
	finalizeWithHashes,
	markIgnored,
} from "./diff";
import {
	applySyncRun,
	PROCESSING_VERSION,
	type ApplyResult,
} from "./syncApplyRun";
import { ObsidianVaultAccess, type VaultAccess } from "./vaultAccess";
import {
	ChangeKind,
	DatasetMapping,
	DiffResult,
	FileChange,
	IgnoreSnapshot,
	RagflowSyncSettings,
	ScopeConfig,
	VaultEntry,
} from "./types";

export { PROCESSING_VERSION, type ApplyResult } from "./syncApplyRun";

/**
 * Orchestrates the sync: builds the vault snapshot, drives the pure Diff,
 * performs the hashing/persistence IO, and delegates Sync apply runs to
 * syncApplyRun. The classification rules themselves live in ./diff.
 */
export class SyncEngine {
	private vault: VaultAccess;
	private client: RagflowClient;
	private store: SyncStateStore;
	private getSettings: () => RagflowSyncSettings;

	constructor(
		app: App,
		client: RagflowClient,
		store: SyncStateStore,
		getSettings: () => RagflowSyncSettings,
		vault: VaultAccess = new ObsidianVaultAccess(app)
	) {
		this.vault = vault;
		this.client = client;
		this.store = store;
		this.getSettings = getSettings;
	}

	private scope(): ScopeConfig {
		const s = this.getSettings();
		return {
			mappings: s.datasetMappings,
			extensions: s.extensions,
			excludeGlobs: s.excludeGlobs,
			processingVersion: PROCESSING_VERSION,
		};
	}

	/** Obsidian adapter for the vault-snapshot seam: every file, unfiltered. */
	private buildSnapshot(): VaultEntry[] {
		return this.vault.listSnapshot();
	}

	private async hashPath(path: string): Promise<string> {
		const bytes = await this.vault.readBinary(path);
		return sha256(bytes);
	}

	private missingMappings(): DatasetMapping[] {
		return this.getSettings().datasetMappings.filter(
			(m) => m.vaultPath.length > 0 && !this.vault.folderExists(m.vaultPath)
		);
	}

	async computeDiff(): Promise<DiffResult> {
		const settings = this.getSettings();
		const state = settings.state;
		const scope = this.scope();

		const stat = classifyByStat(this.buildSnapshot(), state, scope);

		const hashes = new Map<string, string>();
		for (const item of stat.needHash) {
			try {
				hashes.set(item.entry.path, await this.hashPath(item.entry.path));
			} catch (_e) {
				// Leave unset: finalize treats a missing hash as modified.
			}
		}
		const hashed = finalizeWithHashes(stat.needHash, hashes);

		// Identical content with drifted stats gets a Touch refresh so the next
		// Diff can take the fast path without re-hashing.
		for (const touch of hashed.touches) {
			this.store.setFile(touch.vaultPath, {
				...touch.record,
				size: touch.size,
				mtime: touch.mtime,
			});
		}

		const changes = assembleChanges(stat, hashed);

		// Ignore (snooze) is applied after Diff: still-classified changes are
		// flagged while their ignore snapshot matches, and re-surfaced when stale.
		const snoozeHashes = await this.snoozeHashes(
			changes,
			settings.ignoredEntries
		);
		const snooze = markIgnored(changes, settings.ignoredEntries, snoozeHashes);
		for (const path of snooze.staleIgnores) delete settings.ignoredEntries[path];
		for (const [path, snap] of Object.entries(snooze.captured)) {
			settings.ignoredEntries[path] = snap;
		}

		await this.store.flush();

		return {
			changes: snooze.changes,
			missingMappings: this.missingMappings(),
		};
	}

	/**
	 * Current content hashes for ignored files whose snooze decision cannot be
	 * made from stats alone.
	 */
	private async snoozeHashes(
		changes: FileChange[],
		ignoredEntries: Record<string, IgnoreSnapshot>
	): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		for (const change of changes) {
			const snap = ignoredEntries[change.vaultPath];
			if (!snap || change.kind === "deleted" || change.hash !== undefined) {
				continue;
			}
			const needs =
				"pending" in snap
					? true
					: "deleted" in snap
						? false
						: !(change.size === snap.size && change.mtime === snap.mtime);
			if (!needs) continue;
			try {
				out.set(change.vaultPath, await this.hashPath(change.vaultPath));
			} catch (_e) {
				// Leave unset.
			}
		}
		return out;
	}

	/**
	 * Snapshot a path for Ignore (snooze) at the moment the user ignores it:
	 * `{deleted:true}` if it is gone from the vault, otherwise its current hash
	 * and stats.
	 */
	async snapshotForIgnore(path: string): Promise<IgnoreSnapshot> {
		const file = this.vault.getFile(path);
		if (!file) return { deleted: true };
		const hash = await this.hashPath(path);
		return { hash, size: file.stat.size, mtime: file.stat.mtime };
	}

	async applyChanges(
		changes: FileChange[],
		onProgress?: (done: number, total: number, label: string) => void
	): Promise<ApplyResult> {
		return applySyncRun({
			vault: this.vault,
			client: this.client,
			store: this.store,
			settings: this.getSettings(),
			changes,
			onProgress,
			processingVersion: PROCESSING_VERSION,
		});
	}
}

export function summarize(changes: FileChange[]): Record<ChangeKind, number> {
	const counts: Record<ChangeKind, number> = {
		new: 0,
		modified: 0,
		deleted: 0,
		unchanged: 0,
	};
	for (const c of changes) counts[c.kind] += 1;
	return counts;
}
