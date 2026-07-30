import { describe, expect, it } from "vitest";
import { markMissing, reconcileDataset, trackedCount } from "./reconcile";
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

describe("reconcileDataset", () => {
	it("reports a remote document nothing in the vault accounts for", () => {
		const r = reconcileDataset(
			"raw_policy",
			"ds1",
			[doc("d1", "a.md"), doc("d2", "stranger.md")],
			[change("Notes/a.md", "unchanged", { record: record({ documentId: "d1" }) })],
			new Set(["d1"])
		);
		expect(r.orphans.map((o) => o.documentName)).toEqual(["stranger.md"]);
		expect(r.missingPaths).toEqual([]);
	});

	it("reports a RAGFlow (n) duplicate as an orphan even though the base name matches", () => {
		// The upload path treats "a(1).md" as a duplicate of "a.md" and clears it;
		// here the exact-name rule is what surfaces the copy that got left behind.
		const r = reconcileDataset(
			"raw_policy",
			"ds1",
			[doc("d1", "a.md"), doc("d9", "a(1).md")],
			[change("Notes/a.md", "unchanged", { record: record({ documentId: "d1" }) })],
			new Set(["d1"])
		);
		expect(r.orphans.map((o) => o.documentName)).toEqual(["a(1).md"]);
	});

	it("does not orphan a document a pending upload is about to replace by name", () => {
		const r = reconcileDataset(
			"raw_policy",
			"ds1",
			[doc("d5", "a.md")],
			[change("Notes/a.md", "new")],
			new Set()
		);
		expect(r.orphans).toEqual([]);
	});

	it("orphans the document of a file that is on its way out", () => {
		// A deleted change already removes its own tracked document, but an
		// untracked same-named leftover has nothing to remove it.
		const r = reconcileDataset(
			"raw_policy",
			"ds1",
			[doc("d7", "gone.md")],
			[change("Notes/gone.md", "deleted", { record: record() })],
			new Set()
		);
		expect(r.orphans.map((o) => o.documentName)).toEqual(["gone.md"]);
	});

	it("ignores documents in datasets other mappings own", () => {
		const r = reconcileDataset(
			"raw_policy",
			"ds1",
			[doc("d1", "a.md")],
			[
				change("Other/a.md", "unchanged", {
					mapping: mapping("other_kb"),
					record: record({ documentId: "d1" }),
				}),
			],
			new Set(["d1"])
		);
		// Tracked, so not an orphan; and its path belongs to another dataset, so it
		// is not reported missing here either.
		expect(r.orphans).toEqual([]);
		expect(r.missingPaths).toEqual([]);
	});

	it("reports an up-to-date file whose document was deleted in RAGFlow", () => {
		const r = reconcileDataset(
			"raw_policy",
			"ds1",
			[],
			[change("Notes/a.md", "unchanged", { record: record({ documentId: "d1" }) })],
			new Set(["d1"])
		);
		expect(r.missingPaths).toEqual(["Notes/a.md"]);
	});

	it("reports a record stranded by a deleted-and-recreated dataset", () => {
		const r = reconcileDataset(
			"raw_policy",
			"ds-new",
			[doc("d1", "a.md")],
			[
				change("Notes/a.md", "unchanged", {
					record: record({ documentId: "d1", datasetId: "ds-old" }),
				}),
			],
			new Set(["d1"])
		);
		expect(r.missingPaths).toEqual(["Notes/a.md"]);
	});

	it("leaves already-actionable kinds alone", () => {
		const r = reconcileDataset(
			"raw_policy",
			"ds1",
			[],
			[
				change("Notes/a.md", "modified", { record: record() }),
				change("Notes/b.md", "new"),
				change("Notes/c.md", "deleted", { record: record() }),
			],
			new Set()
		);
		expect(r.missingPaths).toEqual([]);
	});
});

describe("markMissing", () => {
	it("promotes the named paths to missing", () => {
		const changes = [
			change("Notes/a.md", "unchanged"),
			change("Notes/b.md", "unchanged"),
		];
		const r = markMissing(changes, ["Notes/b.md"]);
		expect(r.changes.map((c) => c.kind)).toEqual(["unchanged", "missing"]);
		expect(r.unsnoozed).toEqual([]);
	});

	it("un-snoozes a missing file so it cannot stay hidden forever", () => {
		const changes = [change("Notes/a.md", "unchanged", { ignored: true })];
		const r = markMissing(changes, ["Notes/a.md"]);
		expect(r.changes[0].kind).toBe("missing");
		expect(r.changes[0].ignored).toBe(false);
		expect(r.unsnoozed).toEqual(["Notes/a.md"]);
	});
});

describe("trackedCount", () => {
	it("counts only the records pointing at the given dataset", () => {
		const files = {
			a: { datasetId: "ds1" },
			b: { datasetId: "ds1" },
			c: { datasetId: "ds2" },
		};
		expect(trackedCount(files, "ds1")).toBe(2);
		expect(trackedCount(files, "ds2")).toBe(1);
	});
});
