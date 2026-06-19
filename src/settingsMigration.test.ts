import { describe, expect, it } from "vitest";
import { normalizeSettings } from "./settingsMigration";

describe("normalizeSettings", () => {
	it("migrates legacy folder mappings into dataset mappings", () => {
		const settings = normalizeSettings({
			folderMappings: [{ vaultPath: "Notes", ragflowBaseFolder: "KB" }],
		});

		expect(settings.datasetMappings).toEqual([
			{ vaultPath: "Notes", datasetName: "KB" },
		]);
		expect("folderMappings" in (settings as unknown as Record<string, unknown>)).toBe(false);
	});

	it("drops legacy file-management records and migrates ignored paths", () => {
		const settings = normalizeSettings({
			ignoredPaths: ["Notes/a.md"],
			state: {
				files: {
					"Notes/a.md": { ragflowPath: "/legacy" },
				},
			},
		});

		expect(settings.state.files).toEqual({});
		expect(settings.ignoredEntries).toEqual({
			"Notes/a.md": { pending: true },
		});
	});

	it("removes obsolete companion metadata settings", () => {
		const settings = normalizeSettings({
			datasetMappings: [
				{ vaultPath: "Docs", datasetName: "KB", companionMetadata: true },
			],
			companionMetadataPaths: ["Meta"],
		});

		expect(settings.datasetMappings).toEqual([
			{ vaultPath: "Docs", datasetName: "KB" },
		]);
		expect("companionMetadataPaths" in (settings as unknown as Record<string, unknown>)).toBe(false);
	});
});
