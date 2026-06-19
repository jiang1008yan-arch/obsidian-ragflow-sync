import type {
	DatasetMapping,
	RagflowSyncSettings,
	SyncedFileRecord,
} from "./types";

export const DEFAULT_SETTINGS: RagflowSyncSettings = {
	ragflowBaseUrl: "http://127.0.0.1:9380",
	apiKey: "",
	datasetMappings: [],
	extensions: ["md", "pdf", "docx"],
	excludeGlobs: [".trash", ".obsidian"],
	ignoredEntries: {},
	internalizeLinks: false,
	normalizeTables: true,
	autoParse: true,
	state: { files: {} },
};

export function normalizeSettings(data: Record<string, unknown>): RagflowSyncSettings {
	const settings = Object.assign({}, DEFAULT_SETTINGS, data) as RagflowSyncSettings;
	settings.state = Object.assign(
		{ files: {} },
		(data.state as Record<string, unknown> | undefined) ?? {}
	) as RagflowSyncSettings["state"];
	settings.ignoredEntries = Object.assign({}, settings.ignoredEntries ?? {});

	migrateLegacyMappings(settings, data);
	removeObsoleteCompanionSettings(settings);
	dropLegacyRecords(settings);
	migrateIgnoredPaths(settings, data);

	return settings;
}

function migrateLegacyMappings(
	settings: RagflowSyncSettings,
	data: Record<string, unknown>
): void {
	const legacyMappings = data.folderMappings as
		| { vaultPath?: string; ragflowBaseFolder?: string }[]
		| undefined;
	if (legacyMappings && settings.datasetMappings.length === 0) {
		settings.datasetMappings = legacyMappings.map((m) => ({
			vaultPath: m.vaultPath ?? "",
			datasetName: m.ragflowBaseFolder ?? "",
		}));
	}
	delete (settings as unknown as Record<string, unknown>).folderMappings;
}

function removeObsoleteCompanionSettings(settings: RagflowSyncSettings): void {
	delete (settings as unknown as Record<string, unknown>).companionMetadataPaths;
	for (const mapping of settings.datasetMappings as Array<
		DatasetMapping & { companionMetadata?: boolean }
	>) {
		delete mapping.companionMetadata;
	}
}

function dropLegacyRecords(settings: RagflowSyncSettings): void {
	const files = settings.state.files;
	const isLegacyRecord = Object.values(files).some(
		(r) => (r as Partial<SyncedFileRecord>).documentId === undefined
	);
	if (isLegacyRecord) {
		settings.state.files = {};
	}
}

function migrateIgnoredPaths(
	settings: RagflowSyncSettings,
	data: Record<string, unknown>
): void {
	const legacyIgnored = (data as { ignoredPaths?: unknown }).ignoredPaths;
	if (Array.isArray(legacyIgnored)) {
		for (const path of legacyIgnored) {
			if (typeof path === "string" && !settings.ignoredEntries[path]) {
				settings.ignoredEntries[path] = { pending: true };
			}
		}
	}
	delete (settings as unknown as Record<string, unknown>).ignoredPaths;
}
