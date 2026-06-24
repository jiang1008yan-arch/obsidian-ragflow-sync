import { describe, expect, it } from "vitest";
import { noteTags } from "./noteTags";

describe("noteTags", () => {
	it("reads a YAML list", () => {
		expect(noteTags(["ml", "research"])).toEqual(["ml", "research"]);
	});

	it("splits a bare string on whitespace and commas", () => {
		expect(noteTags("ml research")).toEqual(["ml", "research"]);
		expect(noteTags("ml, research,ai")).toEqual(["ml", "research", "ai"]);
	});

	it("strips a leading # from each tag", () => {
		expect(noteTags(["#ml", "#research"])).toEqual(["ml", "research"]);
		expect(noteTags("#ml #research")).toEqual(["ml", "research"]);
	});

	it("keeps a nested tag as its full path", () => {
		expect(noteTags(["area/ml"])).toEqual(["area/ml"]);
		expect(noteTags("#area/ml")).toEqual(["area/ml"]);
	});

	it("coerces numbers and booleans to strings", () => {
		expect(noteTags([2024, true])).toEqual(["2024", "true"]);
	});

	it("de-duplicates, preserving first-seen order", () => {
		expect(noteTags(["ml", "ai", "ml"])).toEqual(["ml", "ai"]);
	});

	it("treats missing/empty/non-tag values as no tags", () => {
		expect(noteTags(undefined)).toEqual([]);
		expect(noteTags(null)).toEqual([]);
		expect(noteTags("")).toEqual([]);
		expect(noteTags("   ")).toEqual([]);
		expect(noteTags({ a: 1 })).toEqual([]);
	});

	it("flattens nested lists and drops empty entries", () => {
		expect(noteTags(["ml", ["ai", ""], "  ", "research"])).toEqual([
			"ml",
			"ai",
			"research",
		]);
	});
});
