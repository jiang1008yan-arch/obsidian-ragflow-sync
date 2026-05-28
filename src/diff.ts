import {
	FileChange,
	HashClassification,
	PendingHash,
	ScopeConfig,
	StatClassification,
	SyncState,
	VaultEntry,
} from "./types";
import { isInScope, owningMapping } from "./mapping";

/**
 * Pure diff: classify a vault snapshot against synced state into changes.
 *
 * No Obsidian, no persistence, no IO. Hashing is kept out of this module:
 * phase 1 (classifyByStat) decides everything it can from stats alone and
 * defers ambiguous entries to `needHash`; the caller hashes those and feeds
 * them to phase 2 (finalizeWithHashes). Scope/ownership reasoning lives in
 * ./mapping; the classification and deletion rules live here. Both synchronous.
 */

/** Phase 1: everything decidable from stats alone. Pure and synchronous. */
export function classifyByStat(
	snapshot: VaultEntry[],
	state: SyncState,
	scope: ScopeConfig
): StatClassification {
	const result: StatClassification = {
		news: [],
		unchanged: [],
		needHash: [],
		deletions: [],
	};
	const inScopePaths = new Set<string>();

	for (const entry of snapshot) {
		const mapping = isInScope(entry.path, scope);
		if (!mapping) continue;
		inScopePaths.add(entry.path);

		const record = state.files[entry.path];
		if (!record) {
			result.news.push({ entry, mapping });
		} else if (record.size === entry.size && record.mtime === entry.mtime) {
			result.unchanged.push({ entry, record, mapping });
		} else {
			result.needHash.push({ entry, record, mapping });
		}
	}

	// Deletion rule: any synced record not in the in-scope snapshot is a
	// deletion — covering gone, filtered-out, and removed-mapping files.
	for (const [vaultPath, record] of Object.entries(state.files)) {
		if (inScopePaths.has(vaultPath)) continue;
		result.deletions.push({
			vaultPath,
			record,
			mapping: owningMapping(vaultPath, scope),
		});
	}

	return result;
}

/** Phase 2: resolve the needHash set into modified vs unchanged. Pure and synchronous. */
export function finalizeWithHashes(
	needHash: PendingHash[],
	hashes: Map<string, string>
): HashClassification {
	const result: HashClassification = {
		modified: [],
		unchanged: [],
		touches: [],
	};

	for (const item of needHash) {
		const hash = hashes.get(item.entry.path);
		const base: FileChange = {
			kind: "unchanged",
			vaultPath: item.entry.path,
			mapping: item.mapping,
			record: item.record,
			hash,
			size: item.entry.size,
			mtime: item.entry.mtime,
		};

		// Missing hash (read failed) is treated as modified to be safe.
		if (hash !== undefined && hash === item.record.hash) {
			result.unchanged.push(base);
			result.touches.push({
				vaultPath: item.entry.path,
				record: item.record,
				size: item.entry.size,
				mtime: item.entry.mtime,
			});
		} else {
			result.modified.push({ ...base, kind: "modified" });
		}
	}

	return result;
}

/** Assemble the full change list from both phases. */
export function assembleChanges(
	stat: StatClassification,
	hashed: HashClassification
): FileChange[] {
	const changes: FileChange[] = [];

	for (const { entry, mapping } of stat.news) {
		changes.push({
			kind: "new",
			vaultPath: entry.path,
			mapping,
			size: entry.size,
			mtime: entry.mtime,
		});
	}
	changes.push(...hashed.modified);
	for (const { vaultPath, record, mapping } of stat.deletions) {
		changes.push({ kind: "deleted", vaultPath, mapping, record });
	}
	for (const { entry, record, mapping } of stat.unchanged) {
		changes.push({
			kind: "unchanged",
			vaultPath: entry.path,
			mapping,
			record,
			size: entry.size,
			mtime: entry.mtime,
		});
	}
	changes.push(...hashed.unchanged);

	return changes;
}
