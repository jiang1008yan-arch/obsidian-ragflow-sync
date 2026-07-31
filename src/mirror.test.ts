import { describe, expect, it } from "vitest";
import {
	mergeMirrorPlans,
	mirrorTotals,
	planMirrorForDataset,
} from "./mirror";
import {
	ChangeKind,
	DatasetMapping,
	FileChange,
	RagflowDocument,
	SyncedFileRecord,
} from "./types";

const mapping = (datasetName = "raw_policy"): DatasetMapping => ({
	vaultPath: "Notes",
	datasetName,
});

function record(over: Partial<SyncedFileRecord> = {}): SyncedFileRecord {
	return {
		documentId: "doc1",
		datasetId: "ds1",
		hash: "h1",
		size: 10,
		mtime: 100,
		lastSyncedAt: 0,
		...over,
	};
}

function change(
	vaultPath: string,
	kind: ChangeKind,
	over: Partial<FileChange> = {}
): FileChange {
	return { kind, vaultPath, mapping: mapping(), ...over };
}

const doc = (id: string, name: string): RagflowDocument => ({ id, name });

const plan = (remoteDocs: RagflowDocument[], changes: FileChange[]) =>
	planMirrorForDataset("raw_policy", "ds1", remoteDocs, changes);

describe("planMirrorForDataset", () => {
	it("deletes a document the folder does not account for", () => {
		const r = plan(
			[doc("d1", "a.md"), doc("d2", "stranger.md")],
			[change("Notes/a.md", "unchanged", { record: record() })]
		);
		expect(r.orphanDeletes.map((o) => o.documentName)).toEqual(["stranger.md"]);
		expect(r.kept).toBe(1);
		expect(r.changes).toEqual([]);
	});

	it("keeps a name present on both sides even when nothing tracks it", () => {
		// The decisive difference from reconcile: no synced state is consulted, so
		// a lost local record cannot cause a re-upload or a delete.
		const r = plan([doc("d1", "a.md")], [change("Notes/a.md", "unchanged")]);
		expect(r.orphanDeletes).toEqual([]);
		expect(r.changes).toEqual([]);
		expect(r.kept).toBe(1);
	});

	it("re-uploads an up-to-date file the dataset does not actually hold", () => {
		const r = plan([], [change("Notes/a.md", "unchanged", { record: record() })]);
		expect(r.changes).toHaveLength(1);
		expect(r.changes[0].kind).toBe("modified");
		expect(r.changes[0].hash).toBeUndefined();
		expect(r.kept).toBe(0);
	});

	it("carries content drift through, since names alone cannot see it", () => {
		const r = plan(
			[doc("d1", "a.md")],
			[change("Notes/a.md", "modified", { record: record() })]
		);
		expect(r.changes.map((c) => c.kind)).toEqual(["modified"]);
		expect(r.orphanDeletes).toEqual([]);
	});

	it("routes a tracked deletion through the apply run, not the direct delete", () => {
		// Going through the apply run is what clears the synced-state record too.
		const r = plan(
			[doc("d1", "gone.md")],
			[change("Notes/gone.md", "deleted", { record: record({ documentId: "d1" }) })]
		);
		expect(r.orphanDeletes).toEqual([]);
		expect(r.changes.map((c) => c.kind)).toEqual(["deleted"]);
	});

	it("deletes an untracked leftover whose vault file is also gone", () => {
		const r = plan(
			[doc("d9", "gone.md")],
			[change("Notes/gone.md", "deleted", { record: record({ documentId: "d1" }) })]
		);
		expect(r.orphanDeletes.map((o) => o.documentName)).toEqual(["gone.md"]);
	});

	it("deletes RAGFlow (n) duplicates, which no vault name matches", () => {
		const r = plan(
			[doc("d1", "a.md"), doc("d2", "a(1).md"), doc("d3", "a(2).md")],
			[change("Notes/a.md", "unchanged", { record: record() })]
		);
		expect(r.orphanDeletes.map((o) => o.documentName)).toEqual([
			"a(1).md",
			"a(2).md",
		]);
		expect(r.kept).toBe(1);
	});

	it("disregards a snooze, since a mirror must match the folder exactly", () => {
		const r = plan(
			[doc("d1", "a.md")],
			[
				change("Notes/a.md", "modified", { record: record(), ignored: true }),
				change("Notes/b.md", "new", { ignored: true }),
			]
		);
		expect(r.changes).toHaveLength(2);
		expect(r.changes.every((c) => c.ignored === false)).toBe(true);
	});

	it("ignores datasets other mappings own", () => {
		const r = plan(
			[doc("d1", "a.md")],
			[change("Other/b.md", "new", { mapping: mapping("other_kb") })]
		);
		// b.md belongs elsewhere, so it neither uploads here nor spares a.md.
		expect(r.changes).toEqual([]);
		expect(r.orphanDeletes.map((o) => o.documentName)).toEqual(["a.md"]);
	});

	it("uploads everything when the dataset does not exist yet", () => {
		const r = planMirrorForDataset(
			"raw_policy",
			"",
			[],
			[change("Notes/a.md", "new"), change("Notes/b.md", "new")]
		);
		expect(r.changes).toHaveLength(2);
		expect(r.orphanDeletes).toEqual([]);
	});
});

describe("mirrorTotals", () => {
	it("counts deletions from both paths and uploads from the rest", () => {
		const totals = mirrorTotals({
			changes: [
				change("Notes/a.md", "new"),
				change("Notes/b.md", "modified"),
				change("Notes/c.md", "deleted"),
			],
			orphanDeletes: [
				{
					datasetName: "raw_policy",
					datasetId: "ds1",
					documentId: "d9",
					documentName: "x.md",
				},
			],
			kept: 5,
		});
		expect(totals).toEqual({ uploads: 2, deletes: 2, kept: 5 });
	});
});

describe("mergeMirrorPlans", () => {
	it("concatenates plans and sums what each leaves alone", () => {
		const a = plan([doc("d1", "x.md")], []);
		const b = plan([], [change("Notes/b.md", "new")]);
		const merged = mergeMirrorPlans([a, b]);
		expect(merged.orphanDeletes).toHaveLength(1);
		expect(merged.changes).toHaveLength(1);
		expect(merged.kept).toBe(0);
	});
});
