import { describe, expect, it } from "vitest";
import {
	countNotes,
	forceAllChanges,
	forceSelectedChanges,
	syncSelectedChanges,
	syncAllChanges,
	tabData,
} from "./panelState";
import type { ChangeKind, DatasetCount, FileChange } from "./types";

function change(
	vaultPath: string,
	kind: ChangeKind,
	ignored = false
): FileChange {
	return { vaultPath, kind, ...(ignored ? { ignored: true } : {}) };
}

describe("panel state", () => {
	const changes = [
		change("new.md", "new"),
		change("same.md", "unchanged"),
		change("gone.md", "deleted"),
		change("ignored.md", "modified", true),
	];

	it("shows only actionable non-ignored changes in Scan diff", () => {
		expect(tabData("diff", changes).map((c) => c.vaultPath)).toEqual([
			"new.md",
			"gone.md",
		]);
	});

	it("shows present in-scope files in the Sync picker", () => {
		expect(tabData("sync", changes).map((c) => c.vaultPath)).toEqual([
			"new.md",
			"same.md",
			"ignored.md",
		]);
	});

	it("sync all skips ignored and unchanged changes", () => {
		expect(syncAllChanges(changes).map((c) => c.vaultPath)).toEqual([
			"new.md",
			"gone.md",
		]);
	});

	it("sync selected applies only checked Scan-diff-visible changes", () => {
		const selected = new Set(["new.md", "same.md", "ignored.md"]);

		expect(syncSelectedChanges(changes, selected).map((c) => c.vaultPath)).toEqual([
			"new.md",
		]);
	});

	it("force selected promotes unchanged and ignored picks to modified", () => {
		const forced = forceSelectedChanges(changes, new Set(["same.md", "ignored.md"]));

		expect(forced).toEqual([
			{ vaultPath: "same.md", kind: "modified", hash: undefined },
			{ vaultPath: "ignored.md", kind: "modified", hash: undefined, ignored: false },
		]);
	});

	it("force all promotes unchanged changes but leaves ignored ones alone", () => {
		expect(forceAllChanges(changes)).toEqual([
			change("new.md", "new"),
			{ vaultPath: "same.md", kind: "modified", hash: undefined },
			change("gone.md", "deleted"),
		]);
	});
});

describe("countNotes", () => {
	const count = (over: Partial<DatasetCount> = {}): DatasetCount => ({
		datasetName: "raw_policy",
		remote: 10,
		tracked: 10,
		inScope: 10,
		distinctNames: 10,
		skipped: 0,
		...over,
	});

	it("says nothing when every number agrees", () => {
		expect(countNotes(count())).toEqual([]);
	});

	it("explains documents lost on the RAGFlow side", () => {
		const notes = countNotes(count({ remote: 8 }));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("2 document(s) tracked but not in RAGFlow");
	});

	it("explains files that were never uploaded", () => {
		// distinctNames tracks inScope: these 4 extra files have distinct names, so
		// only the never-uploaded note applies.
		const notes = countNotes(count({ inScope: 14, distinctNames: 14 }));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("4 file(s) never uploaded");
	});

	it("explains the flat-dataset ceiling when names collide", () => {
		const notes = countNotes(count({ distinctNames: 7 }));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("3 file(s) share a document name");
		expect(notes[0]).toContain("never hold more than 7");
	});

	it("explains files the scope settings skip", () => {
		const notes = countNotes(count({ skipped: 330 }));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("330 file(s)");
	});

	it("reports every applicable gap at once", () => {
		// The real shape of a drifted dataset: short remotely, behind on uploads,
		// name collisions capping it, and a pile of out-of-scope files besides.
		const notes = countNotes(
			count({ remote: 559, tracked: 561, inScope: 570, distinctNames: 566, skipped: 12 })
		);
		expect(notes).toHaveLength(4);
	});
});
