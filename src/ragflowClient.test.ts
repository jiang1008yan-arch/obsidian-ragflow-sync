import { beforeEach, describe, expect, it, vi } from "vitest";
// obsidian is aliased to test/obsidian-stub.ts via vitest.config.ts so this
// module (which imports requestUrl) resolves under test. The stub's requestUrl
// throws, so the calls that go over the wire replace it with this spy.
const requestUrl = vi.fn();
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: (param: unknown) => requestUrl(param),
}));

import { isDuplicateName, RagflowClient } from "./ragflowClient";
import { RagflowSyncSettings } from "./types";

describe("isDuplicateName", () => {
	it("matches the exact name", () => {
		expect(isDuplicateName("notes.md", "notes.md")).toBe(true);
	});

	it("matches RAGFlow (n) duplicate suffixes", () => {
		expect(isDuplicateName("notes(1).md", "notes.md")).toBe(true);
		expect(isDuplicateName("notes(12).md", "notes.md")).toBe(true);
	});

	it("does not match a different stem or extension", () => {
		expect(isDuplicateName("mynotes.md", "notes.md")).toBe(false);
		expect(isDuplicateName("notes-2.md", "notes.md")).toBe(false);
		expect(isDuplicateName("notesnotes.md", "notes.md")).toBe(false);
		expect(isDuplicateName("notes.txt", "notes.md")).toBe(false);
		expect(isDuplicateName("notes(1).txt", "notes.md")).toBe(false);
	});

	it("requires the suffix group to be purely numeric", () => {
		expect(isDuplicateName("notes(a).md", "notes.md")).toBe(false);
		expect(isDuplicateName("notes().md", "notes.md")).toBe(false);
	});

	it("treats stem characters literally, not as regex", () => {
		expect(isDuplicateName("a.b.md", "a.b.md")).toBe(true);
		expect(isDuplicateName("a.b(1).md", "a.b.md")).toBe(true);
		expect(isDuplicateName("axb.md", "a.b.md")).toBe(false);
	});

	it("matches a numeric-paren real name, which callers must then protect", () => {
		// This predicate alone cannot tell a "(2024)" document apart from a "(1)"
		// leftover; DocumentIndex is what keeps a real report(2024).md from being
		// deleted (see documentIndex.test.ts).
		expect(isDuplicateName("report(2024).md", "report.md")).toBe(true);
	});

	it("a (n)-suffixed base only matches itself and its own duplicates", () => {
		expect(isDuplicateName("report(2024).md", "report(2024).md")).toBe(true);
		expect(isDuplicateName("report(2024)(1).md", "report(2024).md")).toBe(true);
		expect(isDuplicateName("report(2023).md", "report(2024).md")).toBe(false);
	});

	it("handles extensionless names", () => {
		expect(isDuplicateName("README", "README")).toBe(true);
		expect(isDuplicateName("README(1)", "README")).toBe(true);
		expect(isDuplicateName("READMEX", "README")).toBe(false);
	});
});

function client(): RagflowClient {
	const settings = {
		ragflowBaseUrl: "https://ragflow.test/",
		apiKey: "k",
		datasetMappings: [],
	} as unknown as RagflowSyncSettings;
	return new RagflowClient(() => settings);
}

/** A successful RAGFlow envelope, as requestUrl would return it. */
const ok = (data: unknown) => ({ status: 200, json: { code: 0, data } });

const docs = (n: number, from = 0) =>
	Array.from({ length: n }, (_, i) => ({ id: `d${from + i}`, name: `f${from + i}.md` }));

describe("listDocuments", () => {
	beforeEach(() => requestUrl.mockReset());

	it("returns a single short page without asking for another", async () => {
		requestUrl.mockResolvedValueOnce(ok({ docs: docs(3) }));
		const all = await client().listDocuments("ds1");
		expect(all.map((d) => d.id)).toEqual(["d0", "d1", "d2"]);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it("paginates until a page comes back short", async () => {
		requestUrl
			.mockResolvedValueOnce(ok({ docs: docs(100) }))
			.mockResolvedValueOnce(ok({ docs: docs(100, 100) }))
			.mockResolvedValueOnce(ok({ docs: docs(7, 200) }));
		const all = await client().listDocuments("ds1");
		expect(all).toHaveLength(207);
		expect(requestUrl).toHaveBeenCalledTimes(3);
		const pages = requestUrl.mock.calls.map((c) =>
			new URL((c[0] as { url: string }).url).searchParams.get("page")
		);
		expect(pages).toEqual(["1", "2", "3"]);
	});

	it("treats an empty dataset as no documents", async () => {
		requestUrl.mockResolvedValueOnce(ok({}));
		expect(await client().listDocuments("ds1")).toEqual([]);
	});
});

describe("findDatasetId", () => {
	beforeEach(() => requestUrl.mockReset());

	it("resolves an existing dataset without creating anything", async () => {
		requestUrl.mockResolvedValueOnce(ok([{ id: "ds1", name: "raw_policy" }]));
		expect(await client().findDatasetId("raw_policy")).toBe("ds1");
		expect(requestUrl).toHaveBeenCalledTimes(1);
		expect((requestUrl.mock.calls[0][0] as { method: string }).method).toBe("GET");
	});

	it("returns undefined rather than creating a dataset that is absent", async () => {
		requestUrl.mockResolvedValueOnce(ok([{ id: "ds1", name: "other" }]));
		expect(await client().findDatasetId("raw_policy")).toBeUndefined();
		// One GET and no POST: a reconcile must never conjure an empty dataset.
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});
});
