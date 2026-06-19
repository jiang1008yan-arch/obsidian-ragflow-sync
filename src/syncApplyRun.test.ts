import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import type { RagflowClient } from "./ragflowClient";
import { applySyncRun } from "./syncApplyRun";
import { SyncStateStore } from "./syncState";
import type { VaultAccess, VaultFile } from "./vaultAccess";
import {
	DatasetMapping,
	FileChange,
	RagflowSyncSettings,
	SyncedFileRecord,
} from "./types";

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

function settings(over: Partial<RagflowSyncSettings> = {}): RagflowSyncSettings {
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
		state: { files: {} },
		...over,
	};
}

function file(
	path: string,
	name: string,
	extension: string,
	basename: string,
	size = 8,
	mtime = 10
): TFile {
	return Object.assign(new TFile(), {
		path,
		name,
		extension,
		basename,
		stat: { size, mtime },
	}) as TFile;
}

function emptyVault(over: Partial<VaultAccess> = {}): VaultAccess {
	return {
		listSnapshot: vi.fn(() => []),
		folderExists: vi.fn(() => false),
		getFile: vi.fn(() => undefined),
		readBinary: vi.fn(),
		markdownFilesUnder: vi.fn(() => []),
		frontmatter: vi.fn(() => undefined),
		resolveLink: vi.fn(() => undefined),
		relatedLinks: vi.fn(() => ({ outgoing: [], incoming: [] })),
		...over,
	};
}

describe("applySyncRun deletion", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops the local record even when the remote document is already gone", async () => {
		const s = settings({ state: { files: { [ENTITY_PATH]: record() } } });
		const store = new SyncStateStore(s.state, async () => {});
		const client = {
			deleteDocuments: vi
				.fn()
				.mockRejectedValue(new Error("RAGFlow error (404): not found")),
			parseDocuments: vi.fn(),
		} as unknown as RagflowClient;
		const change: FileChange = {
			kind: "deleted",
			vaultPath: ENTITY_PATH,
			record: record(),
		};

		const result = await applySyncRun({
			vault: emptyVault(),
			client,
			store,
			settings: s,
			changes: [change],
		});

		expect(client.deleteDocuments).toHaveBeenCalledWith("ds-gone", ["doc1"]);
		expect(store.getFile(ENTITY_PATH)).toBeUndefined();
		expect(result.ok).toBe(1);
		expect(result.failed).toBe(0);
	});
});

describe("applySyncRun upload", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("queues an uploaded document for parsing even when metadata update fails", async () => {
		const mapping: DatasetMapping = {
			vaultPath: "Docs",
			datasetName: "Knowledge",
			companionSourceFolder: "Meta",
		};
		const pdf = file("Docs/report.pdf", "report.pdf", "pdf", "report");
		const metaNote = file("Meta/report.md", "report.md", "md", "report");
		const s = settings({
			datasetMappings: [mapping],
			extensions: ["pdf"],
			autoParse: true,
		});
		const store = new SyncStateStore(s.state, async () => {});
		const parseDocuments = vi.fn().mockResolvedValue(undefined);
		const client = {
			ensureDatasetId: vi.fn().mockResolvedValue("ds1"),
			findDuplicateDocumentIds: vi.fn().mockResolvedValue([]),
			uploadDocument: vi.fn().mockResolvedValue({ id: "doc1", name: "report.pdf" }),
			setDocumentMetadata: vi
				.fn()
				.mockRejectedValue(new Error("metadata rejected")),
			parseDocuments,
		} as unknown as RagflowClient;
		const vault = emptyVault({
			getFile: vi.fn((path: string) =>
				path === pdf.path ? (pdf as VaultFile) : undefined
			),
			readBinary: vi
				.fn()
				.mockResolvedValue(new TextEncoder().encode("pdf-body").buffer),
			markdownFilesUnder: vi.fn(() => [metaNote as VaultFile]),
			frontmatter: vi.fn((note: VaultFile) =>
				note.path === metaNote.path
					? { file: "[[report.pdf]]", title: "Report" }
					: undefined
			),
			resolveLink: vi.fn((linkpath: string) =>
				linkpath === "report.pdf" ? (pdf as VaultFile) : undefined
			),
		});
		const change: FileChange = {
			kind: "new",
			vaultPath: pdf.path,
			mapping,
			size: pdf.stat.size,
			mtime: pdf.stat.mtime,
		};

		const result = await applySyncRun({
			vault,
			client,
			store,
			settings: s,
			changes: [change],
		});

		expect(client.setDocumentMetadata).toHaveBeenCalledWith("ds1", "doc1", {
			file: "report.pdf",
			title: "Report",
		});
		expect(store.getFile(pdf.path)?.metaPending).toBe(true);
		expect(parseDocuments).toHaveBeenCalledWith("ds1", ["doc1"]);
		expect(result.failed).toBe(1);
		expect(result.parsed).toBe(1);
	});
});
