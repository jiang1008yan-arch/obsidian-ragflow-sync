import { describe, expect, it } from "vitest";
import {
	assembleChanges,
	classifyByStat,
	finalizeWithHashes,
	markIgnored,
} from "./diff";
import {
	DatasetMapping,
	FileChange,
	IgnoreSnapshot,
	ScopeConfig,
	SyncedFileRecord,
	SyncState,
	VaultEntry,
} from "./types";

// In-memory adapter for the vault-snapshot seam — the second adapter that
// makes the seam real and lets the diff rules be tested without Obsidian.
function entry(path: string, size = 10, mtime = 100): VaultEntry {
	return { path, size, mtime };
}

function record(over: Partial<SyncedFileRecord> = {}): SyncedFileRecord {
	return {
		documentId: "d1",
		datasetId: "ds1",
		hash: "h1",
		size: 10,
		mtime: 100,
		lastSyncedAt: 0,
		...over,
	};
}

function state(files: Record<string, SyncedFileRecord>): SyncState {
	return { files };
}

const mapping = (vaultPath: string, datasetName = "ds"): DatasetMapping => ({
	vaultPath,
	datasetName,
});

function scope(over: Partial<ScopeConfig> = {}): ScopeConfig {
	return {
		mappings: [mapping("Notes")],
		extensions: ["md", "pdf"],
		excludeGlobs: [".trash"],
		...over,
	};
}

describe("classifyByStat", () => {
	it("flags an in-scope file with no record as new", () => {
		const r = classifyByStat([entry("Notes/a.md")], state({}), scope());
		expect(r.news.map((n) => n.entry.path)).toEqual(["Notes/a.md"]);
		expect(r.needHash).toHaveLength(0);
		expect(r.deletions).toHaveLength(0);
	});

	it("takes the fast path (no hash) when stats match the record", () => {
		const r = classifyByStat(
			[entry("Notes/a.md", 10, 100)],
			state({ "Notes/a.md": record({ size: 10, mtime: 100 }) }),
			scope()
		);
		expect(r.unchanged.map((u) => u.entry.path)).toEqual(["Notes/a.md"]);
		expect(r.needHash).toHaveLength(0);
	});

	it("defers to a hash check when stats drift", () => {
		const r = classifyByStat(
			[entry("Notes/a.md", 20, 200)],
			state({ "Notes/a.md": record({ size: 10, mtime: 100 }) }),
			scope()
		);
		expect(r.needHash.map((n) => n.entry.path)).toEqual(["Notes/a.md"]);
		expect(r.unchanged).toHaveLength(0);
	});

	it("ignores files whose extension is not allowed", () => {
		const r = classifyByStat([entry("Notes/a.png")], state({}), scope());
		expect(r.news).toHaveLength(0);
	});

	it("ignores excluded paths", () => {
		const r = classifyByStat(
			[entry("Notes/.trash/a.md")],
			state({}),
			scope()
		);
		expect(r.news).toHaveLength(0);
	});

	it("ignores files outside every mapping prefix", () => {
		const r = classifyByStat([entry("Other/a.md")], state({}), scope());
		expect(r.news).toHaveLength(0);
	});

	it("attributes a file to exactly one mapping, the most specific (dedup)", () => {
		const r = classifyByStat(
			[entry("Notes/Sub/a.md")],
			state({}),
			scope({ mappings: [mapping("Notes"), mapping("Notes/Sub")] })
		);
		expect(r.news).toHaveLength(1);
		expect(r.news[0].mapping.vaultPath).toBe("Notes/Sub");
	});

	describe("processing-version reprocess rule", () => {
		it("reprocesses a record whose processingVersion is stale", () => {
			const r = classifyByStat(
				[entry("Notes/a.md", 10, 100)],
				state({ "Notes/a.md": record({ size: 10, mtime: 100, processingVersion: 1 }) }),
				scope({ processingVersion: 2 })
			);
			expect(r.reprocess.map((x) => x.entry.path)).toEqual(["Notes/a.md"]);
			expect(r.unchanged).toHaveLength(0);
			expect(r.needHash).toHaveLength(0);
		});

		it("reprocesses a pre-versioning record when a version is now set", () => {
			const r = classifyByStat(
				[entry("Notes/a.md", 10, 100)],
				state({ "Notes/a.md": record({ size: 10, mtime: 100 }) }), // no version
				scope({ processingVersion: 1 })
			);
			expect(r.reprocess.map((x) => x.entry.path)).toEqual(["Notes/a.md"]);
		});

		it("reprocesses a record whose metadata call previously failed", () => {
			const r = classifyByStat(
				[entry("Notes/a.pdf", 10, 100)],
				state({
					"Notes/a.pdf": record({
						size: 10,
						mtime: 100,
						processingVersion: 2,
						metaPending: true,
					}),
				}),
				scope({ processingVersion: 2 })
			);
			expect(r.reprocess.map((x) => x.entry.path)).toEqual(["Notes/a.pdf"]);
			expect(r.unchanged).toHaveLength(0);
		});

		it("does not reprocess when versions match (stays on the fast path)", () => {
			const r = classifyByStat(
				[entry("Notes/a.md", 10, 100)],
				state({ "Notes/a.md": record({ size: 10, mtime: 100, processingVersion: 2 }) }),
				scope({ processingVersion: 2 })
			);
			expect(r.reprocess).toHaveLength(0);
			expect(r.unchanged.map((u) => u.entry.path)).toEqual(["Notes/a.md"]);
		});

		it("surfaces a reprocessed file as a modified change with no hash", () => {
			const stat = classifyByStat(
				[entry("Notes/a.md", 10, 100)],
				state({ "Notes/a.md": record({ size: 10, mtime: 100, processingVersion: 1 }) }),
				scope({ processingVersion: 2 })
			);
			const hashed = finalizeWithHashes(stat.needHash, new Map());
			const changes = assembleChanges(stat, hashed);
			const modified = changes.filter((c) => c.kind === "modified");
			expect(modified.map((c) => c.vaultPath)).toEqual(["Notes/a.md"]);
			expect(modified[0].hash).toBeUndefined();
			expect(modified[0].record).toBeDefined();
		});
	});

	describe("deletion rule (full unmirror)", () => {
		it("deletes a synced file that is gone from the snapshot", () => {
			const r = classifyByStat(
				[],
				state({ "Notes/a.md": record() }),
				scope()
			);
			expect(r.deletions.map((d) => d.vaultPath)).toEqual(["Notes/a.md"]);
		});

		it("deletes a file that still exists but fell out of scope by extension", () => {
			const r = classifyByStat(
				[entry("Notes/a.md")],
				state({ "Notes/a.md": record() }),
				scope({ extensions: ["pdf"] }) // md no longer allowed
			);
			expect(r.deletions.map((d) => d.vaultPath)).toEqual(["Notes/a.md"]);
		});

		it("deletes files of a removed mapping", () => {
			const r = classifyByStat(
				[entry("Notes/a.md")],
				state({ "Notes/a.md": record() }),
				scope({ mappings: [] }) // mapping removed
			);
			expect(r.deletions.map((d) => d.vaultPath)).toEqual(["Notes/a.md"]);
			expect(r.deletions[0].mapping).toBeUndefined();
		});
	});

});

describe("markIgnored (snooze)", () => {
	const change = (over: Partial<FileChange> = {}): FileChange => ({
		kind: "modified",
		vaultPath: "Notes/a.md",
		size: 10,
		mtime: 100,
		...over,
	});
	const ignores = (
		snap: IgnoreSnapshot,
		path = "Notes/a.md"
	): Record<string, IgnoreSnapshot> => ({ [path]: snap });

	it("flags an ignored file whose stats still match the snapshot (fast path)", () => {
		const c = change({ size: 10, mtime: 100 });
		const r = markIgnored(
			[c],
			ignores({ hash: "h1", size: 10, mtime: 100 }),
			new Map()
		);
		expect(c.ignored).toBe(true);
		expect(r.staleIgnores).toHaveLength(0);
		expect(r.captured).toEqual({});
	});

	it("re-surfaces (drops) an ignored file whose content drifted", () => {
		const c = change({ size: 20, mtime: 200, hash: "h2" });
		const r = markIgnored([c], ignores({ hash: "h1", size: 10, mtime: 100 }), new Map());
		expect(c.ignored).toBeFalsy();
		expect(r.staleIgnores).toEqual(["Notes/a.md"]);
	});

	it("stays ignored via hash when stats drifted but content matches, refreshing the snapshot", () => {
		const c = change({ size: 10, mtime: 999, hash: "h1" });
		const r = markIgnored([c], ignores({ hash: "h1", size: 10, mtime: 100 }), new Map());
		expect(c.ignored).toBe(true);
		expect(r.captured["Notes/a.md"]).toEqual({ hash: "h1", size: 10, mtime: 999 });
	});

	it("uses currentHashes when the change carries no hash", () => {
		const c = change({ kind: "unchanged", size: 10, mtime: 999, hash: undefined });
		const r = markIgnored(
			[c],
			ignores({ hash: "h1", size: 10, mtime: 100 }),
			new Map([["Notes/a.md", "h1"]])
		);
		expect(c.ignored).toBe(true);
		expect(r.captured["Notes/a.md"]).toMatchObject({ hash: "h1", mtime: 999 });
	});

	it("keeps a deleted+ignored entry ignored while it stays gone", () => {
		const c = change({ kind: "deleted", size: undefined, mtime: undefined });
		const r = markIgnored([c], ignores({ deleted: true }), new Map());
		expect(c.ignored).toBe(true);
		expect(r.staleIgnores).toHaveLength(0);
	});

	it("drops a deleted-snapshot ignore when a file reappears at the path", () => {
		const c = change({ kind: "new", size: 5, mtime: 50 });
		const r = markIgnored([c], ignores({ deleted: true }), new Map());
		expect(c.ignored).toBeFalsy();
		expect(r.staleIgnores).toEqual(["Notes/a.md"]);
	});

	it("captures a pending (migrated) ignore into a real snapshot", () => {
		const c = change({ kind: "new", size: 7, mtime: 70, hash: "hn" });
		const r = markIgnored([c], ignores({ pending: true }), new Map());
		expect(c.ignored).toBe(true);
		expect(r.captured["Notes/a.md"]).toEqual({ hash: "hn", size: 7, mtime: 70 });
	});

	it("resolves a pending ignore for a gone file to a deleted snapshot", () => {
		const c = change({ kind: "deleted", size: undefined, mtime: undefined });
		const r = markIgnored([c], ignores({ pending: true }), new Map());
		expect(c.ignored).toBe(true);
		expect(r.captured["Notes/a.md"]).toEqual({ deleted: true });
	});

	it("re-surfaces a present-file snapshot once the file is deleted", () => {
		const c = change({ kind: "deleted", size: undefined, mtime: undefined });
		const r = markIgnored([c], ignores({ hash: "h1", size: 10, mtime: 100 }), new Map());
		expect(c.ignored).toBeFalsy();
		expect(r.staleIgnores).toEqual(["Notes/a.md"]);
	});

	it("leaves unrelated changes untouched", () => {
		const c = change({ vaultPath: "Notes/b.md" });
		const r = markIgnored([c], ignores({ deleted: true }, "Notes/a.md"), new Map());
		expect(c.ignored).toBeFalsy();
		expect(r.staleIgnores).toHaveLength(0);
	});
});

describe("finalizeWithHashes", () => {
	it("marks modified when the hash differs", () => {
		const stat = classifyByStat(
			[entry("Notes/a.md", 20, 200)],
			state({ "Notes/a.md": record({ hash: "old", size: 10, mtime: 100 }) }),
			scope()
		);
		const hashed = finalizeWithHashes(
			stat.needHash,
			new Map([["Notes/a.md", "new"]])
		);
		expect(hashed.modified.map((c) => c.vaultPath)).toEqual(["Notes/a.md"]);
		expect(hashed.touches).toHaveLength(0);
	});

	it("emits a touch refresh when stats drifted but content is identical", () => {
		const stat = classifyByStat(
			[entry("Notes/a.md", 10, 999)],
			state({ "Notes/a.md": record({ hash: "same", size: 10, mtime: 100 }) }),
			scope()
		);
		const hashed = finalizeWithHashes(
			stat.needHash,
			new Map([["Notes/a.md", "same"]])
		);
		expect(hashed.unchanged.map((c) => c.vaultPath)).toEqual(["Notes/a.md"]);
		expect(hashed.touches[0]).toMatchObject({
			vaultPath: "Notes/a.md",
			mtime: 999,
		});
	});

	it("treats a missing hash (read failure) as modified", () => {
		const stat = classifyByStat(
			[entry("Notes/a.md", 20, 200)],
			state({ "Notes/a.md": record({ hash: "old" }) }),
			scope()
		);
		const hashed = finalizeWithHashes(stat.needHash, new Map());
		expect(hashed.modified).toHaveLength(1);
	});
});

describe("assembleChanges", () => {
	it("merges both phases into one change list", () => {
		const snapshot = [
			entry("Notes/new.md"),
			entry("Notes/same.md", 10, 100),
			entry("Notes/edited.md", 20, 200),
		];
		const st = state({
			"Notes/same.md": record({ size: 10, mtime: 100, hash: "s" }),
			"Notes/edited.md": record({ size: 10, mtime: 100, hash: "old" }),
			"Notes/gone.md": record(),
		});
		const stat = classifyByStat(snapshot, st, scope());
		const hashed = finalizeWithHashes(
			stat.needHash,
			new Map([["Notes/edited.md", "new"]])
		);
		const changes = assembleChanges(stat, hashed);
		const byKind = (k: string) =>
			changes.filter((c) => c.kind === k).map((c) => c.vaultPath).sort();
		expect(byKind("new")).toEqual(["Notes/new.md"]);
		expect(byKind("modified")).toEqual(["Notes/edited.md"]);
		expect(byKind("deleted")).toEqual(["Notes/gone.md"]);
		expect(byKind("unchanged")).toEqual(["Notes/same.md"]);
	});
});
