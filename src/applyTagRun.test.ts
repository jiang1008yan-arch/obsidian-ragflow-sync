import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import type { RagflowClient } from "./ragflowClient";
import { applyTagRun, type TagTarget } from "./applyTagRun";
import type { VaultAccess, VaultFile } from "./vaultAccess";
import {
	DatasetMapping,
	RagflowChunk,
	RagflowSyncSettings,
	SyncedFileRecord,
} from "./types";

function record(over: Partial<SyncedFileRecord> = {}): SyncedFileRecord {
	return {
		documentId: "doc1",
		datasetId: "ds1",
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
		extensions: ["md", "pdf"],
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
	basename: string
): TFile {
	return Object.assign(new TFile(), {
		path,
		name,
		extension,
		basename,
		stat: { size: 8, mtime: 10 },
	}) as TFile;
}

function chunk(over: Partial<RagflowChunk> = {}): RagflowChunk {
	return { id: "c1", content: "body", important_keywords: [], ...over };
}

function emptyVault(over: Partial<VaultAccess> = {}): VaultAccess {
	return {
		listSnapshot: vi.fn(() => []),
		folderExists: vi.fn(() => false),
		getFile: vi.fn(() => undefined),
		readBinary: vi.fn(),
		markdownFilesUnder: vi.fn(() => []),
		frontmatter: vi.fn(async () => undefined),
		resolveLink: vi.fn(() => undefined),
		relatedLinks: vi.fn(() => ({ outgoing: [], incoming: [] })),
		...over,
	};
}

interface FakeClientParts {
	getDocumentStatus?: RagflowClient["getDocumentStatus"];
	listChunks?: RagflowClient["listChunks"];
	updateChunkKeywords?: RagflowClient["updateChunkKeywords"];
}

function fakeClient(parts: FakeClientParts): RagflowClient {
	return {
		getDocumentStatus:
			parts.getDocumentStatus ??
			vi.fn(async () => ({ run: "DONE", chunkCount: 1 })),
		listChunks: parts.listChunks ?? vi.fn(async () => [chunk()]),
		updateChunkKeywords: parts.updateChunkKeywords ?? vi.fn(async () => {}),
	} as unknown as RagflowClient;
}

describe("applyTagRun", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes a markdown note's tags onto every chunk", async () => {
		const note = file("Notes/a.md", "a.md", "md", "a");
		const vault = emptyVault({
			getFile: vi.fn(() => note),
			frontmatter: vi.fn(async () => ({ tags: ["ml", "research"] })),
		});
		const update = vi.fn(async () => {});
		const client = fakeClient({
			listChunks: vi.fn(async () => [
				chunk({ id: "c1" }),
				chunk({ id: "c2" }),
			]),
			updateChunkKeywords: update,
		});
		const target: TagTarget = { vaultPath: note.path, record: record() };

		const result = await applyTagRun({
			vault,
			client,
			settings: settings(),
			targets: [target],
		});

		expect(update).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenCalledWith("ds1", "doc1", "c1", ["ml", "research"], "body");
		expect(result).toMatchObject({ tagged: 1, chunksWritten: 2, failed: 0 });
	});

	it("skips a document that is not parsed yet", async () => {
		const note = file("Notes/a.md", "a.md", "md", "a");
		const update = vi.fn(async () => {});
		const client = fakeClient({
			getDocumentStatus: vi.fn(async () => ({ run: "RUNNING", chunkCount: 0 })),
			updateChunkKeywords: update,
		});
		const vault = emptyVault({
			getFile: vi.fn(() => note),
			frontmatter: vi.fn(async () => ({ tags: ["ml"] })),
		});

		const result = await applyTagRun({
			vault,
			client,
			settings: settings(),
			targets: [{ vaultPath: note.path, record: record() }],
		});

		expect(update).not.toHaveBeenCalled();
		expect(result).toMatchObject({ tagged: 0, skippedUnparsed: 1 });
	});

	it("skips a note with no tags without touching its chunks", async () => {
		const note = file("Notes/a.md", "a.md", "md", "a");
		const status = vi.fn(async () => ({ run: "DONE", chunkCount: 1 }));
		const client = fakeClient({ getDocumentStatus: status });
		const vault = emptyVault({
			getFile: vi.fn(() => note),
			frontmatter: vi.fn(async () => ({ title: "x" })),
		});

		const result = await applyTagRun({
			vault,
			client,
			settings: settings(),
			targets: [{ vaultPath: note.path, record: record() }],
		});

		// No tags means we never even check parse status.
		expect(status).not.toHaveBeenCalled();
		expect(result).toMatchObject({ tagged: 0, skippedNoTags: 1 });
	});

	it("does not rewrite a chunk whose keywords already match", async () => {
		const note = file("Notes/a.md", "a.md", "md", "a");
		const update = vi.fn(async () => {});
		const client = fakeClient({
			listChunks: vi.fn(async () => [
				chunk({ id: "c1", important_keywords: ["research", "ml"] }),
				chunk({ id: "c2", important_keywords: ["stale"] }),
			]),
			updateChunkKeywords: update,
		});
		const vault = emptyVault({
			getFile: vi.fn(() => note),
			frontmatter: vi.fn(async () => ({ tags: ["ml", "research"] })),
		});

		const result = await applyTagRun({
			vault,
			client,
			settings: settings(),
			targets: [{ vaultPath: note.path, record: record() }],
		});

		// c1 already matches (order-insensitive); only c2 is rewritten.
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith("ds1", "doc1", "c2", ["ml", "research"], "body");
		expect(result.chunksWritten).toBe(1);
		expect(result.tagged).toBe(1);
	});

	it("tags a non-markdown document from its companion note's tags", async () => {
		const mapping: DatasetMapping = {
			vaultPath: "Docs",
			datasetName: "KB",
			companionSourceFolder: "Meta",
		};
		const pdf = file("Docs/report.pdf", "report.pdf", "pdf", "report");
		const metaNote = file("Meta/report.md", "report.md", "md", "report");
		const update = vi.fn(async () => {});
		const client = fakeClient({ updateChunkKeywords: update });
		const vault = emptyVault({
			getFile: vi.fn((p: string) => (p === pdf.path ? pdf : undefined)),
			markdownFilesUnder: vi.fn(() => [metaNote] as VaultFile[]),
			frontmatter: vi.fn(async () => ({
				file: "[[report.pdf]]",
				tags: ["finance"],
			})),
			resolveLink: vi.fn(() => pdf),
		});

		const result = await applyTagRun({
			vault,
			client,
			settings: settings({ datasetMappings: [mapping] }),
			targets: [{ vaultPath: pdf.path, record: record(), mapping }],
		});

		expect(update).toHaveBeenCalledWith("ds1", "doc1", "c1", ["finance"], "body");
		expect(result).toMatchObject({ tagged: 1, chunksWritten: 1 });
	});

	it("continues past a failing document and reports it", async () => {
		const a = file("Notes/a.md", "a.md", "md", "a");
		const b = file("Notes/b.md", "b.md", "md", "b");
		const client = fakeClient({
			listChunks: vi.fn(async (_ds: string, docId: string) => {
				if (docId === "bad") throw new Error("boom");
				return [chunk()];
			}),
		});
		const vault = emptyVault({
			getFile: vi.fn((p: string) => (p === a.path ? a : b)),
			frontmatter: vi.fn(async () => ({ tags: ["ml"] })),
		});

		const result = await applyTagRun({
			vault,
			client,
			settings: settings(),
			targets: [
				{ vaultPath: a.path, record: record({ documentId: "bad" }) },
				{ vaultPath: b.path, record: record({ documentId: "ok" }) },
			],
		});

		expect(result.tagged).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.errors[0]).toContain("Notes/a.md");
	});
});
