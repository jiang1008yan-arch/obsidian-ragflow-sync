import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentIndex } from "./documentIndex";
import type { RagflowClient } from "./ragflowClient";
import type { RagflowDocument } from "./types";

const listDocuments = vi.fn();
const client = { listDocuments } as unknown as RagflowClient;

const doc = (id: string, name: string): RagflowDocument => ({ id, name });
const none: ReadonlySet<string> = new Set();

describe("DocumentIndex", () => {
	beforeEach(() => listDocuments.mockReset());

	it("lists a dataset once and answers every later collision from memory", async () => {
		listDocuments.mockResolvedValue([doc("d1", "a.md"), doc("d2", "b.md")]);
		const index = new DocumentIndex(client);

		expect(await index.duplicateIds("ds1", "a.md", none)).toEqual(["d1"]);
		expect(await index.duplicateIds("ds1", "b.md", none)).toEqual(["d2"]);
		expect(await index.duplicateIds("ds1", "c.md", none)).toEqual([]);
		expect(listDocuments).toHaveBeenCalledTimes(1);
	});

	it("lists each dataset separately", async () => {
		listDocuments
			.mockResolvedValueOnce([doc("d1", "a.md")])
			.mockResolvedValueOnce([doc("d2", "a.md")]);
		const index = new DocumentIndex(client);

		expect(await index.duplicateIds("ds1", "a.md", none)).toEqual(["d1"]);
		expect(await index.duplicateIds("ds2", "a.md", none)).toEqual(["d2"]);
		expect(listDocuments).toHaveBeenCalledTimes(2);
	});

	it("collects RAGFlow (n) duplicates along with the exact name", async () => {
		listDocuments.mockResolvedValue([
			doc("d1", "a.md"),
			doc("d2", "a(1).md"),
			doc("d3", "a(2).md"),
			doc("d4", "other.md"),
		]);
		const index = new DocumentIndex(client);
		expect((await index.duplicateIds("ds1", "a.md", none)).sort()).toEqual([
			"d1",
			"d2",
			"d3",
		]);
	});

	it("never deletes a (n)-shaped name that is itself a real vault file", async () => {
		// report(2024).md is a document in its own right, not a duplicate of
		// report.md — sweeping it up would silently destroy it.
		listDocuments.mockResolvedValue([
			doc("d1", "report.md"),
			doc("d2", "report(2024).md"),
			doc("d3", "report(1).md"),
		]);
		const index = new DocumentIndex(client);
		const protectedNames = new Set(["report.md", "report(2024).md"]);

		const ids = await index.duplicateIds("ds1", "report.md", protectedNames);
		expect(ids.sort()).toEqual(["d1", "d3"]);
		expect(ids).not.toContain("d2");
	});

	it("still replaces the exact name being uploaded, protected or not", async () => {
		listDocuments.mockResolvedValue([doc("d1", "a.md")]);
		const index = new DocumentIndex(client);
		expect(await index.duplicateIds("ds1", "a.md", new Set(["a.md"]))).toEqual([
			"d1",
		]);
	});

	it("groups same-named documents under one entry", async () => {
		listDocuments.mockResolvedValue([doc("d1", "a.md"), doc("d2", "a.md")]);
		const index = new DocumentIndex(client);
		expect((await index.duplicateIds("ds1", "a.md", none)).sort()).toEqual([
			"d1",
			"d2",
		]);
	});

	it("sees a freshly uploaded document without re-listing", async () => {
		listDocuments.mockResolvedValue([]);
		const index = new DocumentIndex(client);
		await index.duplicateIds("ds1", "a.md", none); // triggers the listing
		index.record("ds1", "a.md", "new1");

		expect(await index.duplicateIds("ds1", "a.md", none)).toEqual(["new1"]);
		expect(listDocuments).toHaveBeenCalledTimes(1);
	});

	it("does not offer a deleted document for deletion twice", async () => {
		listDocuments.mockResolvedValue([doc("d1", "a.md"), doc("d2", "a(1).md")]);
		const index = new DocumentIndex(client);

		const first = await index.duplicateIds("ds1", "a.md", none);
		index.forget("ds1", new Set(first));
		expect(await index.duplicateIds("ds1", "a.md", none)).toEqual([]);
	});

	it("ignores documents with no id", async () => {
		listDocuments.mockResolvedValue([{ name: "a.md" } as RagflowDocument]);
		const index = new DocumentIndex(client);
		expect(await index.duplicateIds("ds1", "a.md", none)).toEqual([]);
	});
});
