import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// obsidian is aliased to test/obsidian-stub.ts via vitest.config.ts so this
// module (which imports parseYaml/TFile, and requestUrl via ragflowClient)
// resolves; none are exercised on the deletion path tested here.
import type { App } from "obsidian";
import { SyncEngine } from "./syncEngine";
import { SyncStateStore } from "./syncState";
import type { RagflowClient } from "./ragflowClient";
import { FileChange, RagflowSyncSettings, SyncedFileRecord } from "./types";

const ENTITY_PATH = "30_Entity/a.md";

function record(over: Partial<SyncedFileRecord> = {}): SyncedFileRecord {
	return {
		documentId: "doc1",
		datasetId: "ds-gone",
		hash: "h",
		size: 1,
		mtime: 1,
		lastSyncedAt: 0,
		...over,
	};
}

function settings(rec: SyncedFileRecord): RagflowSyncSettings {
	return {
		ragflowBaseUrl: "http://localhost",
		apiKey: "k",
		datasetMappings: [],
		extensions: ["md"],
		excludeGlobs: [],
		ignoredEntries: {},
		internalizeLinks: false,
		normalizeTables: false,
		autoParse: false,
		state: { files: { [ENTITY_PATH]: rec } },
	};
}

const deletion: FileChange = {
	kind: "deleted",
	vaultPath: ENTITY_PATH,
	record: record(),
};

function makeEngine(deleteDocuments: ReturnType<typeof vi.fn>) {
	const s = settings(record());
	const store = new SyncStateStore(s.state, async () => {});
	const client = {
		deleteDocuments,
		parseDocuments: vi.fn(),
	} as unknown as RagflowClient;
	const engine = new SyncEngine({} as unknown as App, client, store, () => s);
	return { engine, store };
}

describe("applyChanges deletion", () => {
	beforeEach(() => {
		// The self-heal path logs a warning; keep test output clean.
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops the local record even when the remote document is already gone", async () => {
		// RAGFlow rejects because the document (or its dataset) no longer exists.
		const deleteDocuments = vi
			.fn()
			.mockRejectedValue(new Error("RAGFlow error (404): not found"));
		const { engine, store } = makeEngine(deleteDocuments);

		const result = await engine.applyChanges([deletion]);

		expect(deleteDocuments).toHaveBeenCalledWith("ds-gone", ["doc1"]);
		// The record is removed despite the remote failure, so the phantom
		// deletion does not re-appear on the next scan.
		expect(store.getFile(ENTITY_PATH)).toBeUndefined();
		expect(result.ok).toBe(1);
		expect(result.failed).toBe(0);
	});

	it("drops the local record on a successful remote delete", async () => {
		const deleteDocuments = vi.fn().mockResolvedValue(undefined);
		const { engine, store } = makeEngine(deleteDocuments);

		const result = await engine.applyChanges([deletion]);

		expect(deleteDocuments).toHaveBeenCalledWith("ds-gone", ["doc1"]);
		expect(store.getFile(ENTITY_PATH)).toBeUndefined();
		expect(result.ok).toBe(1);
		expect(result.failed).toBe(0);
	});
});
