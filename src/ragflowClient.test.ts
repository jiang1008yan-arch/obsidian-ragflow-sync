import { describe, expect, it } from "vitest";
// obsidian is aliased to test/obsidian-stub.ts via vitest.config.ts so this
// module (which imports requestUrl) resolves under test.
import { isDuplicateName } from "./ragflowClient";

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

	it("accepted (B) risk: a numeric-paren real name collides with its base", () => {
		// Uploading report.md intentionally also clears report(2024).md.
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
