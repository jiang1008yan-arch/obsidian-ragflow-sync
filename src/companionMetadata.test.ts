import { describe, expect, it, vi } from "vitest";
import type { VaultAccess, VaultFile } from "./vaultAccess";
import { buildCompanionIndex, lookupCompanion } from "./companionMetadata";
import type { RagflowSyncSettings } from "./types";

function file(path: string, name: string, basename: string): VaultFile {
	return { path, name, basename, extension: name.split(".").pop() ?? "", stat: { size: 1, mtime: 1 } };
}

function settings(): RagflowSyncSettings {
	return {
		ragflowBaseUrl: "http://localhost",
		apiKey: "k",
		datasetMappings: [
			{
				vaultPath: "Docs",
				datasetName: "Knowledge",
				companionSourceFolder: "Meta",
			},
		],
		extensions: ["pdf"],
		excludeGlobs: [],
		ignoredEntries: {},
		internalizeLinks: false,
		normalizeTables: false,
		autoParse: false,
		state: { files: {} },
	};
}

describe("Companion metadata", () => {
	it("indexes frontmatter links from the mapping's companion folder", async () => {
		const pdf = file("Docs/report.pdf", "report.pdf", "report");
		const note = file("Meta/report.md", "report.md", "report");
		const vault = {
			markdownFilesUnder: vi.fn(() => [note]),
			frontmatter: vi.fn(() => ({ file: "[[report.pdf]]", title: "Report" })),
			resolveLink: vi.fn(() => pdf),
		} as unknown as VaultAccess;

		const index = await buildCompanionIndex(settings(), vault);

		expect(lookupCompanion(index, "Meta", pdf)).toEqual({
			file: "report.pdf",
			title: "Report",
		});
		expect(vault.markdownFilesUnder).toHaveBeenCalledWith("Meta");
	});

	it("falls back from split document parts to the unsplit stem", async () => {
		const source = file("Docs/ADA-Standard_2010.pdf", "ADA-Standard_2010.pdf", "ADA-Standard_2010");
		const part = file("Docs/ADA-Standard_2010_p1-90.pdf", "ADA-Standard_2010_p1-90.pdf", "ADA-Standard_2010_p1-90");
		const note = file("Meta/ada.md", "ada.md", "ada");
		const vault = {
			markdownFilesUnder: vi.fn(() => [note]),
			frontmatter: vi.fn(() => ({ file: "[[ADA-Standard_2010]]", title: "ADA" })),
			resolveLink: vi.fn(() => source),
		} as unknown as VaultAccess;

		const index = await buildCompanionIndex(settings(), vault);

		expect(lookupCompanion(index, "Meta", part)).toEqual({
			file: "ADA-Standard_2010",
			title: "ADA",
		});
	});
});
