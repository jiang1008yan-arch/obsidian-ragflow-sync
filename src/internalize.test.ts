import { describe, expect, it } from "vitest";
import {
	buildRelatedSection,
	internalizeMarkdown,
	internalizeWikilinks,
	noteTitle,
} from "./internalize";

describe("noteTitle", () => {
	it("takes the last path segment and drops a .md suffix", () => {
		expect(noteTitle("Notes/Research/LLM Notes.md")).toBe("LLM Notes");
	});
	it("keeps non-markdown extensions", () => {
		expect(noteTitle("assets/diagram.png")).toBe("diagram.png");
	});
});

describe("internalizeWikilinks", () => {
	it("collapses a bare link to its note title", () => {
		expect(internalizeWikilinks("see [[Some Note]] here")).toBe(
			"see Some Note here"
		);
	});
	it("prefers the alias when present", () => {
		expect(internalizeWikilinks("[[Some Note|the alias]]")).toBe("the alias");
	});
	it("renders a heading link as 'Note > Heading'", () => {
		expect(internalizeWikilinks("[[Note#Section]]")).toBe("Note > Section");
	});
	it("uses the heading text for a same-note heading link", () => {
		expect(internalizeWikilinks("[[#Section]]")).toBe("Section");
	});
	it("strips a folder path and .md from the target", () => {
		expect(internalizeWikilinks("[[Folder/Sub/Note.md]]")).toBe("Note");
	});
	it("turns an image embed into standard Markdown", () => {
		expect(internalizeWikilinks("![[assets/pic.png]]")).toBe(
			"![pic.png](assets/pic.png)"
		);
	});
	it("collapses a non-image embed to its note title", () => {
		expect(internalizeWikilinks("![[Other Note]]")).toBe("Other Note");
	});
	it("rewrites multiple links on one line", () => {
		expect(internalizeWikilinks("[[A]] and [[B|bee]]")).toBe("A and bee");
	});
	it("leaves text without wikilinks untouched", () => {
		expect(internalizeWikilinks("plain [text](http://x) only")).toBe(
			"plain [text](http://x) only"
		);
	});
});

describe("buildRelatedSection", () => {
	it("is empty when there are no related notes", () => {
		expect(buildRelatedSection({ outgoing: [], incoming: [] })).toBe("");
	});
	it("lists links and backlinks, de-duplicated", () => {
		const section = buildRelatedSection({
			outgoing: ["A", "B", "A"],
			incoming: ["C"],
		});
		expect(section).toBe(
			"## Related notes\n\n**Links:** A, B\n\n**Backlinks:** C"
		);
	});
	it("omits an empty group", () => {
		expect(buildRelatedSection({ outgoing: ["A"], incoming: [] })).toBe(
			"## Related notes\n\n**Links:** A"
		);
	});
});

describe("internalizeMarkdown", () => {
	it("rewrites the body and appends the related section", () => {
		const out = internalizeMarkdown("Body links to [[A]].", {
			outgoing: ["A"],
			incoming: ["B"],
		});
		expect(out).toBe(
			"Body links to A.\n\n## Related notes\n\n**Links:** A\n\n**Backlinks:** B\n"
		);
	});
	it("returns only the rewritten body when there are no related notes", () => {
		expect(
			internalizeMarkdown("Just [[A|a]].", { outgoing: [], incoming: [] })
		).toBe("Just a.");
	});
});
