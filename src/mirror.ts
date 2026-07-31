import { FileChange, MirrorPlan, RagflowDocument, RemoteOrphan } from "./types";

/**
 * Pure Mirror planner: make a dataset match its source folder, judged by name.
 *
 * The Diff and the Remote reconcile both reason through the Synced state, so a
 * lost or stale local record misleads them. A Mirror deliberately does not: it
 * compares the set of in-scope filenames routed to a dataset against the set of
 * document names actually in it, and lets that decide. A document the folder
 * does not account for is deleted, a file the dataset lacks is uploaded, and a
 * name on both sides is left alone. That makes it the recovery path when the
 * synced state cannot be trusted at all.
 *
 * Two things it still takes from the Diff, because names alone cannot see them:
 * content drift (a file whose bytes changed keeps its name, so the hash
 * classification is what catches it) and record cleanup (a vault file that is
 * gone needs its Synced state record removed, not just its document).
 *
 * An **Ignore (snooze) is deliberately disregarded**: a snooze says "leave this
 * one alone", which cannot survive an instruction to make the dataset match the
 * folder exactly.
 */

/** Last path segment — the name the upload path gives the RAGFlow document. */
function baseName(vaultPath: string): string {
	const slash = vaultPath.lastIndexOf("/");
	return slash < 0 ? vaultPath : vaultPath.slice(slash + 1);
}

/** Re-upload an otherwise up-to-date file, as forceUploadChange does. */
function promote(change: FileChange): FileChange {
	return { ...change, kind: "modified", hash: undefined, ignored: false };
}

/**
 * Plan one dataset. `remoteDocs` is empty for a dataset that does not exist
 * yet — everything is then an upload, and the upload path creates it.
 */
export function planMirrorForDataset(
	datasetName: string,
	datasetId: string,
	remoteDocs: RagflowDocument[],
	changes: FileChange[]
): MirrorPlan {
	const mine = changes.filter((c) => c.mapping?.datasetName === datasetName);
	const vaultNames = new Set(
		mine.filter((c) => c.kind !== "deleted").map((c) => baseName(c.vaultPath))
	);
	const remoteNames = new Set(remoteDocs.map((d) => d.name));

	// Documents a "deleted" change already removes. Routing those through the
	// apply run instead of the direct delete is what clears their Synced state
	// record too, so a mirror does not leave the local database full of ghosts.
	const handledIds = new Set(
		mine
			.filter((c) => c.kind === "deleted" && c.record)
			.map((c) => c.record!.documentId)
	);

	const orphanDeletes: RemoteOrphan[] = [];
	for (const doc of remoteDocs) {
		if (!doc.id) continue;
		if (vaultNames.has(doc.name)) continue;
		if (handledIds.has(doc.id)) continue;
		orphanDeletes.push({
			datasetName,
			datasetId,
			documentId: doc.id,
			documentName: doc.name,
		});
	}

	const planned: FileChange[] = [];
	let kept = 0;
	for (const change of mine) {
		if (change.kind === "unchanged") {
			// Up to date locally, but only really present if the dataset holds the
			// name. If it does not, the local record is lying and we re-upload.
			if (remoteNames.has(baseName(change.vaultPath))) kept += 1;
			else planned.push(promote(change));
			continue;
		}
		// new / modified / missing / deleted all carry an action already; a snooze
		// on any of them does not survive a mirror.
		planned.push({ ...change, ignored: false });
	}

	return { changes: planned, orphanDeletes, kept };
}

/** Uploads, deletions and untouched files in a plan — the confirmation figures. */
export function mirrorTotals(plan: MirrorPlan): {
	uploads: number;
	deletes: number;
	kept: number;
} {
	let uploads = 0;
	let deletes = plan.orphanDeletes.length;
	for (const change of plan.changes) {
		if (change.kind === "deleted") deletes += 1;
		else uploads += 1;
	}
	return { uploads, deletes, kept: plan.kept };
}

/** Merge per-dataset plans into the single plan a mirror run executes. */
export function mergeMirrorPlans(plans: MirrorPlan[]): MirrorPlan {
	const merged: MirrorPlan = { changes: [], orphanDeletes: [], kept: 0 };
	for (const plan of plans) {
		merged.changes.push(...plan.changes);
		merged.orphanDeletes.push(...plan.orphanDeletes);
		merged.kept += plan.kept;
	}
	return merged;
}
