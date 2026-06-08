import { describe, expect, it } from "vitest";
import { splitRow, tablesToHtml } from "./tables";

describe("splitRow", () => {
	it("drops optional leading/trailing edge pipes", () => {
		expect(splitRow("| a | b |")).toEqual(["a", "b"]);
	});
	it("works without edge pipes", () => {
		expect(splitRow("a | b")).toEqual(["a", "b"]);
	});
	it("does not split on a pipe inside a [[wikilink|alias]]", () => {
		expect(splitRow("| [[Note|alias]] | b |")).toEqual(["[[Note|alias]]", "b"]);
	});
	it("does not split on a pipe inside an inline code span", () => {
		expect(splitRow("| `a | b` | c |")).toEqual(["`a | b`", "c"]);
	});
	it("treats an escaped pipe as literal cell content", () => {
		expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
	});
	it("keeps empty interior cells", () => {
		expect(splitRow("| a |  | c |")).toEqual(["a", "", "c"]);
	});
});

describe("tablesToHtml", () => {
	it("converts a simple GFM table to an HTML table", () => {
		const src = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");
		expect(tablesToHtml(src)).toBe(
			[
				"<table>",
				"<thead>",
				"<tr><th>A</th><th>B</th></tr>",
				"</thead>",
				"<tbody>",
				"<tr><td>1</td><td>2</td></tr>",
				"</tbody>",
				"</table>",
			].join("\n")
		);
	});

	it("preserves surrounding prose and blank lines", () => {
		const src = [
			"Intro paragraph.",
			"",
			"| A | B |",
			"|---|---|",
			"| 1 | 2 |",
			"",
			"Outro.",
		].join("\n");
		const out = tablesToHtml(src);
		expect(out.startsWith("Intro paragraph.\n\n<table>")).toBe(true);
		expect(out.endsWith("</table>\n\nOutro.")).toBe(true);
	});

	it("renders a header-only table with no tbody", () => {
		const src = ["| A | B |", "| --- | --- |"].join("\n");
		expect(tablesToHtml(src)).toBe(
			[
				"<table>",
				"<thead>",
				"<tr><th>A</th><th>B</th></tr>",
				"</thead>",
				"</table>",
			].join("\n")
		);
	});

	it("pads short rows and truncates long ones to the header width", () => {
		const src = ["| A | B |", "|---|---|", "| 1 |", "| x | y | z |"].join("\n");
		const out = tablesToHtml(src);
		expect(out).toContain("<tr><td>1</td><td></td></tr>");
		expect(out).toContain("<tr><td>x</td><td>y</td></tr>");
	});

	it("HTML-escapes cell content", () => {
		const src = ["| A |", "|---|", "| a<b>&c |"].join("\n");
		expect(tablesToHtml(src)).toContain("<td>a&lt;b&gt;&amp;c</td>");
	});

	it("keeps wikilink pipes from breaking columns", () => {
		const src = ["| Name | Ref |", "|---|---|", "| x | [[Note|alias]] |"].join(
			"\n"
		);
		expect(tablesToHtml(src)).toContain(
			"<tr><td>x</td><td>[[Note|alias]]</td></tr>"
		);
	});

	it("leaves tables inside fenced code blocks untouched", () => {
		const src = ["```", "| A | B |", "| --- | --- |", "| 1 | 2 |", "```"].join(
			"\n"
		);
		expect(tablesToHtml(src)).toBe(src);
	});

	it("leaves text without tables untouched", () => {
		const src = "Just a sentence with a | pipe but no table.";
		expect(tablesToHtml(src)).toBe(src);
	});

	it("does not treat a pipe line without a delimiter row as a table", () => {
		const src = ["| A | B |", "not a delimiter", "| 1 | 2 |"].join("\n");
		expect(tablesToHtml(src)).toBe(src);
	});
});
