import { describe, expect, it } from "vitest";
import { normalizeMeta, splitFrontmatter } from "./frontmatter";

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
});
