import {
	FileChange,
	HashClassification,
	IgnoreSnapshot,
	PendingHash,
	ScopeConfig,
	SnoozeResult,
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
		reprocess: [],
	};
	const inScopePaths = new Set<string>();

	for (const entry of snapshot) {
		const mapping = isInScope(entry.path, scope);
		if (!mapping) continue;
		inScopePaths.add(entry.path);

		const record = state.files[entry.path];
		if (!record) {
			result.news.push({ entry, mapping });
		} else if (record.processingVersion !== scope.processingVersion) {
			// Stale transform version: re-upload even if the source is identical,
			// so plugin processing changes reach already-synced documents.
			result.reprocess.push({ entry, record, mapping });
		} else if (record.metaPending) {
			// Uploaded but its metadata call failed: re-upload to retry the
			// metadata rather than leaving the document permanently without it.
			result.reprocess.push({ entry, record, mapping });
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
	// Version-stale files re-upload as "modified"; hash is left undefined so the
	// upload step recomputes it from the current (unchanged) source bytes.
	for (const { entry, record, mapping } of stat.reprocess) {
		changes.push({
			kind: "modified",
			vaultPath: entry.path,
			mapping,
			record,
			size: entry.size,
			mtime: entry.mtime,
		});
	}
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

/**
 * Apply the ignore snapshots to the assembled change list (pure, synchronous).
 *
 * Each change whose path has an ignore snapshot is flagged `ignored` while it
 * still matches that snapshot; the moment it drifts (content changed, or a
 * deleted-then-ignored path reappears) the entry is reported in `staleIgnores`
 * so the engine drops the snapshot and the change re-surfaces normally. A
 * `pending` snapshot (migrated from the legacy freeze list) is captured into a
 * real one. `currentHashes` supplies the file's current content hash for the
 * cases stats alone cannot decide; when a needed hash is absent the entry is
 * treated as drifted (re-surfaced) to avoid silently freezing an unreadable file.
 */
export function markIgnored(
	changes: FileChange[],
	ignoredEntries: Record<string, IgnoreSnapshot>,
	currentHashes: Map<string, string>
): SnoozeResult {
	const staleIgnores: string[] = [];
	const captured: Record<string, IgnoreSnapshot> = {};

	for (const change of changes) {
		const snap = ignoredEntries[change.vaultPath];
		if (!snap) continue;
		const hashNow = change.hash ?? currentHashes.get(change.vaultPath);

		if ("deleted" in snap) {
			// Ignored while gone: stays ignored only while still gone.
			if (change.kind === "deleted") change.ignored = true;
			else staleIgnores.push(change.vaultPath);
			continue;
		}

		if ("pending" in snap) {
			// Legacy freeze: keep it ignored and capture a real snapshot now.
			change.ignored = true;
			if (change.kind === "deleted") {
				captured[change.vaultPath] = { deleted: true };
			} else if (
				hashNow !== undefined &&
				change.size !== undefined &&
				change.mtime !== undefined
			) {
				captured[change.vaultPath] = {
					hash: hashNow,
					size: change.size,
					mtime: change.mtime,
				};
			}
			continue;
		}

		// Snapshot of a once-present file.
		if (change.kind === "deleted") {
			// Snapshotted present, now gone: drifted — re-surface as a deletion.
			staleIgnores.push(change.vaultPath);
			continue;
		}
		if (change.size === snap.size && change.mtime === snap.mtime) {
			change.ignored = true; // fast path: stats unchanged since ignore.
		} else if (hashNow !== undefined && hashNow === snap.hash) {
			change.ignored = true; // content identical; refresh drifted stats.
			captured[change.vaultPath] = {
				hash: snap.hash,
				size: change.size ?? snap.size,
				mtime: change.mtime ?? snap.mtime,
			};
		} else {
			staleIgnores.push(change.vaultPath); // content drifted: re-surface.
		}
	}

	return { changes, staleIgnores, captured };
}
