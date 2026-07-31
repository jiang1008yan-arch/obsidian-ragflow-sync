import {
	DatasetReconciliation,
	FileChange,
	RagflowDocument,
	RemoteOrphan,
} from "./types";

/**
 * Pure Remote reconcile: classify what RAGFlow actually holds against the
 * vault-side change list and the synced state.
 *
 * The Diff deliberately never talks to RAGFlow — it compares a vault snapshot
 * with the synced state, so every drift that happens on the *remote* side is
 * invisible to it: documents uploaded outside the plugin, leftovers from a lost
 * synced state, RAGFlow's "name(n).ext" duplicates, and documents deleted in the
 * RAGFlow UI all leave the two document counts unequal with nothing to show in
 * Scan diff. This module is what closes that gap. No IO here either: the engine
 * fetches the document lists and feeds them in.
 */

/** Last path segment — the name the upload path gives the RAGFlow document. */
function baseName(vaultPath: string): string {
	const slash = vaultPath.lastIndexOf("/");
	return slash < 0 ? vaultPath : vaultPath.slice(slash + 1);
}

/**
 * Names this dataset is expected to hold: the basename of every in-scope file
 * routed to it that is not on its way out. A pending "new"/"modified" upload
 * counts — the upload replaces by name, so a same-named document already there
 * is about to be consumed rather than orphaned.
 */
function expectedNames(changes: FileChange[], datasetName: string): Set<string> {
	const names = new Set<string>();
	for (const change of changes) {
		if (change.kind === "deleted") continue;
		if (change.mapping?.datasetName !== datasetName) continue;
		names.add(baseName(change.vaultPath));
	}
	return names;
}

/**
 * Reconcile one dataset. Returns the documents nothing accounts for (orphans)
 * and the vault paths whose tracked document has vanished remotely.
 *
 * Orphan matching is by *exact* name, unlike the duplicate cleanup on the
 * upload path: `report(1).md` is precisely the leftover we want reported when
 * the vault only has `report.md`.
 *
 * A tracked record counts as remotely missing when its document id is absent
 * from the dataset, and also when it points at a different dataset id than the
 * one this name resolves to now — that is the fingerprint of a dataset deleted
 * and recreated in RAGFlow, which strands every record that referenced it.
 */
export function reconcileDataset(
	datasetName: string,
	datasetId: string,
	remoteDocs: RagflowDocument[],
	changes: FileChange[],
	trackedDocumentIds: Set<string>
): DatasetReconciliation {
	const expected = expectedNames(changes, datasetName);
	const remoteIds = new Set(remoteDocs.map((d) => d.id));

	const orphans: RemoteOrphan[] = [];
	for (const doc of remoteDocs) {
		if (!doc.id) continue;
		if (trackedDocumentIds.has(doc.id)) continue;
		if (expected.has(doc.name)) continue;
		orphans.push({
			datasetName,
			datasetId,
			documentId: doc.id,
			documentName: doc.name,
		});
	}

	const missingPaths: string[] = [];
	for (const change of changes) {
		// Only up-to-date files can be "missing": every other kind is already
		// scheduled for an upload or a delete that settles the discrepancy.
		if (change.kind !== "unchanged") continue;
		if (change.mapping?.datasetName !== datasetName) continue;
		const record = change.record;
		if (!record) continue;
		if (record.datasetId !== datasetId || !remoteIds.has(record.documentId)) {
			missingPaths.push(change.vaultPath);
		}
	}

	return { orphans, missingPaths };
}

/**
 * Promote the given paths from "unchanged" to "missing" (mutates in place, as
 * markIgnored does). Returns the paths that were snoozed at the time: a vault-
 * side snooze says "this file is fine as it is", which stops being true once its
 * document is gone from RAGFlow, so the caller drops those snapshots and the
 * entry re-surfaces instead of staying hidden forever.
 */
export function markMissing(
	changes: FileChange[],
	missingPaths: string[]
): { changes: FileChange[]; unsnoozed: string[] } {
	const paths = new Set(missingPaths);
	const unsnoozed: string[] = [];

	for (const change of changes) {
		if (!paths.has(change.vaultPath)) continue;
		change.kind = "missing";
		if (change.ignored) {
			change.ignored = false;
			unsnoozed.push(change.vaultPath);
		}
	}

	return { changes, unsnoozed };
}

/** How many synced-state records point at a given dataset id. */
export function trackedCount(
	files: Record<string, { datasetId: string }>,
	datasetId: string
): number {
	return Object.values(files).filter((r) => r.datasetId === datasetId).length;
}
