import { describe, expect, it } from "vitest";
import {
	allFolderPaths,
	buildTree,
	changeSummary,
	foldersWithChanges,
	isFileLeaf,
	leavesOf,
	sortedChildren,
} from "./tree";
import { ChangeKind, FileChange } from "./types";

const change = (vaultPath: string, kind: ChangeKind = "new"): FileChange => ({
	kind,
	vaultPath,
});

describe("buildTree", () => {
	it("nests files under their folder segments", () => {
		const root = buildTree([change("Notes/Research/a.md")]);
		const notes = root.children.get("Notes")!;
		expect(notes.path).toBe("Notes");
		const research = notes.children.get("Research")!;
		expect(research.path).toBe("Notes/Research");
		const file = research.children.get("a.md")!;
		expect(file.change?.vaultPath).toBe("Notes/Research/a.md");
		expect(isFileLeaf(file)).toBe(true);
		expect(isFileLeaf(research)).toBe(false);
	});

	it("merges siblings that share a parent folder", () => {
		const root = buildTree([change("Notes/a.md"), change("Notes/b.md")]);
		expect(root.children.size).toBe(1);
		expect(root.children.get("Notes")!.children.size).toBe(2);
	});

	it("handles a file at the vault root", () => {
		const root = buildTree([change("top.md")]);
		expect(isFileLeaf(root.children.get("top.md")!)).toBe(true);
	});
});

describe("sortedChildren", () => {
	it("lists folders before files, each sorted by name", () => {
		const root = buildTree([
			change("Notes/z.md"),
			change("Notes/a.md"),
			change("Notes/Sub/c.md"),
		]);
		const names = sortedChildren(root.children.get("Notes")!).map((n) => n.name);
		expect(names).toEqual(["Sub", "a.md", "z.md"]);
	});
});

describe("leavesOf", () => {
	it("collects every file leaf under a node", () => {
		const root = buildTree([
			change("Notes/a.md"),
			change("Notes/Sub/b.md"),
			change("Notes/Sub/Deep/c.md"),
		]);
		const paths = leavesOf(root.children.get("Notes")!)
			.map((l) => l.path)
			.sort();
		expect(paths).toEqual([
			"Notes/Sub/Deep/c.md",
			"Notes/Sub/b.md",
			"Notes/a.md",
		]);
	});
});

describe("changeSummary", () => {
	it("summarizes actionable kinds and omits unchanged", () => {
		const root = buildTree([
			change("Notes/a.md", "new"),
			change("Notes/b.md", "new"),
			change("Notes/c.md", "modified"),
			change("Notes/d.md", "unchanged"),
		]);
		expect(changeSummary(leavesOf(root.children.get("Notes")!))).toBe(
			"2 new, 1 modified"
		);
	});

	it("is empty when nothing is actionable", () => {
		const root = buildTree([change("Notes/a.md", "unchanged")]);
		expect(changeSummary(leavesOf(root.children.get("Notes")!))).toBe("");
	});
});

describe("foldersWithChanges / allFolderPaths", () => {
	const changes = [
		change("Notes/Sub/a.md", "new"),
		change("Archive/old.md", "unchanged"),
	];

	it("expands only ancestors of actionable changes", () => {
		expect(foldersWithChanges(changes)).toEqual(
			new Set(["Notes", "Notes/Sub"])
		);
	});

	it("lists every folder for expand-all", () => {
		expect(allFolderPaths(changes)).toEqual(
			new Set(["Notes", "Notes/Sub", "Archive"])
		);
	});
});
