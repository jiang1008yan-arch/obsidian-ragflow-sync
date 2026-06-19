import { describe, expect, it } from "vitest";
import {
	forceAllChanges,
	forceSelectedChanges,
	syncSelectedChanges,
	syncAllChanges,
	tabData,
} from "./panelState";
import type { ChangeKind, FileChange } from "./types";

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
