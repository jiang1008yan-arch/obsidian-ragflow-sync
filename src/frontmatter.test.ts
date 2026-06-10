import { describe, expect, it } from "vitest";
import {
	frontmatterLinkTargets,
	normalizeMeta,
	splitFrontmatter,
} from "./frontmatter";

describe("splitFrontmatter", () => {
	it("splits a leading frontmatter block from the body", () => {
		const text = "---\ntitle: Hi\ntags: [a, b]\n---\n# Body\n\ntext";
		const { yaml, body } = splitFrontmatter(text);
		expect(yaml).toBe("title: Hi\ntags: [a, b]");
		expect(body).toBe("# Body\n\ntext");
	});

	it("returns null yaml and the full text when there is no frontmatter", () => {
		const text = "# Just a heading\n\nbody";
		expect(splitFrontmatter(text)).toEqual({ yaml: null, body: text });
	});

	it("only treats frontmatter at the very start of the file", () => {
		const text = "intro\n---\ntitle: Hi\n---\nbody";
		expect(splitFrontmatter(text).yaml).toBeNull();
	});

	it("handles an empty frontmatter block", () => {
		const { yaml, body } = splitFrontmatter("---\n---\nbody");
		expect(yaml).toBe("");
		expect(body).toBe("body");
	});

	it("tolerates CRLF line endings", () => {
		const { yaml, body } = splitFrontmatter("---\r\ntitle: Hi\r\n---\r\nbody");
		expect(yaml).toBe("title: Hi");
		expect(body).toBe("body");
	});

	it("does not require a trailing newline after the closing fence", () => {
		const { yaml, body } = splitFrontmatter("---\ntitle: Hi\n---");
		expect(yaml).toBe("title: Hi");
		expect(body).toBe("");
	});
});

describe("frontmatterLinkTargets", () => {
	it("extracts a link target carrying an extension", () => {
		expect(frontmatterLinkTargets({ file: "[[report.pdf]]" })).toEqual([
			"report.pdf",
		]);
	});

	it("strips alias and heading, keeping only the link path", () => {
		expect(
			frontmatterLinkTargets({ a: "[[Notes/Doc|Display]]", b: "[[X#Head]]" })
		).toEqual(["Notes/Doc", "X"]);
	});

	it("finds links inside arrays and nested mappings", () => {
		expect(
			frontmatterLinkTargets({
				files: ["[[a.pdf]]", "plain", "[[b.docx]]"],
				meta: { source: "see [[c.pdf]]" },
			})
		).toEqual(["a.pdf", "b.docx", "c.pdf"]);
	});

	it("handles embeds and returns nothing when there are no links", () => {
		expect(frontmatterLinkTargets({ cover: "![[img.png]]" })).toEqual([
			"img.png",
		]);
		expect(frontmatterLinkTargets({ title: "No links here", n: 3 })).toEqual([]);
	});
});

describe("normalizeMeta", () => {
	it("returns a plain object's key/value pairs", () => {
		expect(normalizeMeta({ title: "Hi", tags: ["a", "b"], n: 3 })).toEqual({
			title: "Hi",
			tags: ["a", "b"],
			n: 3,
		});
	});

	it("drops undefined-valued keys", () => {
		expect(normalizeMeta({ a: 1, b: undefined })).toEqual({ a: 1 });
	});

	it("returns an empty object for non-object frontmatter", () => {
		expect(normalizeMeta(null)).toEqual({});
		expect(normalizeMeta("scalar")).toEqual({});
		expect(normalizeMeta(["a", "b"])).toEqual({});
	});

	it("cleans wikilinks in string values to plain text", () => {
		expect(
			normalizeMeta({ project: "[[Project A]]", note: "see [[B|the B note]]" })
		).toEqual({ project: "Project A", note: "see the B note" });
	});

	it("cleans wikilinks inside arrays of values", () => {
		expect(normalizeMeta({ related: ["[[A]]", "[[notes/C|C]]"] })).toEqual({
			related: ["A", "C"],
		});
	});

	it("serializes nested mappings to JSON strings, wikilinks cleaned", () => {
		// RAGFlow's metadata store only indexes flat scalar/array values; a nested
		// object in meta_fields fails the whole update server-side.
		expect(normalizeMeta({ meta: { source: "[[Ref#Section]]" } })).toEqual({
			meta: '{"source":"Ref > Section"}',
		});
	});

	it("drops null values instead of sending them to RAGFlow", () => {
		expect(normalizeMeta({ a: 1, b: null, c: "x" })).toEqual({ a: 1, c: "x" });
	});

	it("converts YAML dates to ISO strings", () => {
		// js-yaml parses an unquoted `date: 2025-06-01` into a Date object; sent
		// as-is it would reach RAGFlow as an empty {} after the wikilink walk.
		expect(normalizeMeta({ date: new Date("2025-06-01") })).toEqual({
			date: "2025-06-01",
		});
		expect(
			normalizeMeta({ at: new Date("2025-06-01T08:30:00.000Z") })
		).toEqual({ at: "2025-06-01T08:30:00.000Z" });
	});

	it("flattens arrays: nulls dropped, dates and nested values stringified", () => {
		expect(
			normalizeMeta({
				list: ["a", null, 3, new Date("2025-06-01"), { k: "v" }, ["x", "y"]],
			})
		).toEqual({
			list: ["a", 3, "2025-06-01", '{"k":"v"}', '["x","y"]'],
		});
	});

	it("strips embeds and leaves non-string values untouched", () => {
		expect(
			normalizeMeta({ cover: "![[image.png]]", count: 3, done: true })
		).toEqual({ cover: "image.png", count: 3, done: true });
	});

	it("strips the wikilink structure from a companion note's file link", () => {
		// The companion-metadata path normalizes a source note's frontmatter, whose
		// link to the attachment must reach RAGFlow as plain text, not "[[...]]".
		expect(
			normalizeMeta({
				file: "[[report.pdf]]",
				title: "Quarterly Report",
				tags: ["finance", "2025"],
			})
		).toEqual({
			file: "report.pdf",
			title: "Quarterly Report",
			tags: ["finance", "2025"],
		});
	});
});
