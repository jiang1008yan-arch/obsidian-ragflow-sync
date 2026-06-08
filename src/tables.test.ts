import { describe, expect, it } from "vitest";
import { splitRow, normalizeTables } from "./tables";

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

describe("normalizeTables", () => {
	it("leaves an already-canonical table unchanged", () => {
		const src = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");
		expect(normalizeTables(src)).toBe(src);
	});

	it("rewrites a borderless table to border style", () => {
		const src = ["A | B", "--- | ---", "1 | 2"].join("\n");
		expect(normalizeTables(src)).toBe(
			["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n")
		);
	});

	it("escapes a wikilink-alias pipe so columns stay aligned", () => {
		const src = ["| Name | Ref |", "|---|---|", "| x | [[Note|alias]] |"].join(
			"\n"
		);
		expect(normalizeTables(src)).toContain("| x | [[Note\\|alias]] |");
	});

	it("escapes any other interior pipe in a cell", () => {
		const src = ["| A | B |", "|---|---|", "| a \\| b | c |"].join("\n");
		expect(normalizeTables(src)).toContain("| a \\| b | c |");
	});

	it("pads short rows and truncates long ones to the header width", () => {
		const src = ["| A | B |", "|---|---|", "| 1 |", "| x | y | z |"].join("\n");
		const out = normalizeTables(src);
		expect(out).toContain("| 1 |  |");
		expect(out).toContain("| x | y |");
	});

	it("preserves column alignment markers", () => {
		const src = ["| A | B | C |", "| :--- | ---: | :---: |", "| 1 | 2 | 3 |"].join(
			"\n"
		);
		expect(normalizeTables(src)).toContain("| :--- | ---: | :---: |");
	});

	it("inserts blank lines around a table that lacks them", () => {
		const src = ["Intro", "| A | B |", "|---|---|", "| 1 | 2 |", "Outro"].join(
			"\n"
		);
		expect(normalizeTables(src)).toBe(
			[
				"Intro",
				"",
				"| A | B |",
				"| --- | --- |",
				"| 1 | 2 |",
				"",
				"Outro",
			].join("\n")
		);
	});

	it("does not add extra blank lines when they already exist", () => {
		const src = [
			"Intro",
			"",
			"| A | B |",
			"| --- | --- |",
			"| 1 | 2 |",
			"",
			"Outro",
		].join("\n");
		expect(normalizeTables(src)).toBe(src);
	});

	it("leaves tables inside fenced code blocks untouched", () => {
		const src = ["```", "| A | B |", "| --- | --- |", "| 1 | 2 |", "```"].join(
			"\n"
		);
		expect(normalizeTables(src)).toBe(src);
	});

	it("leaves text without tables untouched", () => {
		const src = "Just a sentence with a | pipe but no table.";
		expect(normalizeTables(src)).toBe(src);
	});

	it("does not treat a pipe line without a delimiter row as a table", () => {
		const src = ["| A | B |", "not a delimiter", "| 1 | 2 |"].join("\n");
		expect(normalizeTables(src)).toBe(src);
	});
});
