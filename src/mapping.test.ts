import { describe, expect, it } from "vitest";
import { extensionOf, isInScope, owningMapping } from "./mapping";
import { DatasetMapping, ScopeConfig } from "./types";

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
	it("returns the owning mapping's target dataset", () => {
		const s = scope({ mappings: [mapping("Notes", "Research")] });
		expect(isInScope("Notes/a.md", s)?.datasetName).toBe("Research");
	});
});
