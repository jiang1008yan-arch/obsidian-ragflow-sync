import { describe, expect, it } from "vitest";
import { extensionOf, isInScope, owningMapping, placement } from "./mapping";
import { FolderMapping, ScopeConfig } from "./types";

const mapping = (vaultPath: string, ragflowBaseFolder = "rf"): FolderMapping => ({
	vaultPath,
	ragflowBaseFolder,
});

function scope(over: Partial<ScopeConfig> = {}): ScopeConfig {
	return {
		mappings: [mapping("Notes")],
		extensions: ["md", "pdf"],
		excludeGlobs: [".trash"],
		...over,
	};
}

describe("extensionOf", () => {
	it("lowercases the extension after the last dot", () => {
		expect(extensionOf("a/b/File.PDF")).toBe("pdf");
	});
	it("returns empty for a dotless name", () => {
		expect(extensionOf("a/b/README")).toBe("");
	});
	it("ignores dots in folder names", () => {
		expect(extensionOf("a.b/file")).toBe("");
	});
});

describe("owningMapping", () => {
	it("returns the first prefix-owning mapping", () => {
		const s = scope({ mappings: [mapping("Notes"), mapping("Notes/Sub")] });
		expect(owningMapping("Notes/Sub/a.md", s)?.vaultPath).toBe("Notes");
	});
	it("treats an empty vaultPath mapping as whole-vault", () => {
		const s = scope({ mappings: [mapping("")] });
		expect(owningMapping("anything/x.md", s)?.vaultPath).toBe("");
	});
});

describe("isInScope", () => {
	it("rejects disallowed extensions and excluded paths", () => {
		expect(isInScope("Notes/a.png", scope())).toBeUndefined();
		expect(isInScope("Notes/.trash/a.md", scope())).toBeUndefined();
		expect(isInScope("Notes/a.md", scope())?.vaultPath).toBe("Notes");
	});
});

describe("placement", () => {
	it("appends the file's sub-folders to the base folder", () => {
		expect(placement(mapping("Notes", "rf/X"), "Notes/Sub/a.md")).toEqual([
			"rf",
			"X",
			"Sub",
		]);
	});
	it("is just the base folder for a file directly under the mapping", () => {
		expect(placement(mapping("Notes", "rf"), "Notes/a.md")).toEqual(["rf"]);
	});
	it("handles a whole-vault mapping (empty vaultPath)", () => {
		expect(placement(mapping("", "rf"), "Sub/a.md")).toEqual(["rf", "Sub"]);
	});
	it("handles an empty base folder", () => {
		expect(placement(mapping("Notes", ""), "Notes/Sub/a.md")).toEqual(["Sub"]);
	});
	it("preserves unicode and spaces in folder names", () => {
		expect(placement(mapping("笔记", "知识库"), "笔记/项目 A/a.md")).toEqual([
			"知识库",
			"项目 A",
		]);
	});
});
