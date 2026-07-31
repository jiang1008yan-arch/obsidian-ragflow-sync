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
	it("prefers the longest matching prefix, whatever the list order", () => {
		const nested = [mapping("Notes"), mapping("Notes/Sub")];
		for (const mappings of [nested, [...nested].reverse()]) {
			const s = scope({ mappings });
			expect(owningMapping("Notes/Sub/a.md", s)?.vaultPath).toBe("Notes/Sub");
		}
	});
	it("still uses the broader mapping for files the nested one does not cover", () => {
		const s = scope({ mappings: [mapping("Notes"), mapping("Notes/Sub")] });
		expect(owningMapping("Notes/other.md", s)?.vaultPath).toBe("Notes");
	});
	it("does not treat a partial folder-name match as a prefix", () => {
		const s = scope({ mappings: [mapping("Notes"), mapping("Notes/Sub")] });
		expect(owningMapping("Notes/Subway/a.md", s)?.vaultPath).toBe("Notes");
	});
	it("leaves sibling mappings routed exactly as before", () => {
		// The common shape: none is a prefix of another, so longest-prefix picks
		// the same mapping first-match always did.
		const s = scope({
			mappings: [mapping("Policy/US", "us"), mapping("Policy/EU", "eu")],
		});
		expect(owningMapping("Policy/EU/a.md", s)?.datasetName).toBe("eu");
		expect(owningMapping("Policy/US/a.md", s)?.datasetName).toBe("us");
	});
	it("treats an empty vaultPath mapping as whole-vault", () => {
		const s = scope({ mappings: [mapping("")] });
		expect(owningMapping("anything/x.md", s)?.vaultPath).toBe("");
	});
	it("lets a real folder mapping beat a whole-vault mapping listed first", () => {
		const s = scope({ mappings: [mapping("", "all"), mapping("Notes", "notes")] });
		expect(owningMapping("Notes/a.md", s)?.datasetName).toBe("notes");
		expect(owningMapping("Elsewhere/a.md", s)?.datasetName).toBe("all");
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
