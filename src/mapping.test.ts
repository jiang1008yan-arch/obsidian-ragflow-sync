import { describe, expect, it } from "vitest";
import {
	extensionOf,
	isCompanionPath,
	isInScope,
	owningMapping,
} from "./mapping";
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

describe("isCompanionPath", () => {
	it("matches a file that sits under a listed folder", () => {
		expect(isCompanionPath("Papers/report.pdf", ["Papers"])).toBe(true);
		expect(isCompanionPath("Papers/Sub/report.pdf", ["Papers"])).toBe(true);
	});
	it("matches an exact file entry", () => {
		expect(isCompanionPath("Papers/report.pdf", ["Papers/report.pdf"])).toBe(
			true
		);
	});
	it("does not match a sibling folder by prefix", () => {
		expect(isCompanionPath("PapersX/a.pdf", ["Papers"])).toBe(false);
	});
	it("ignores empty entries so a blank row selects nothing", () => {
		expect(isCompanionPath("Papers/report.pdf", [""])).toBe(false);
		expect(isCompanionPath("Papers/report.pdf", [])).toBe(false);
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
