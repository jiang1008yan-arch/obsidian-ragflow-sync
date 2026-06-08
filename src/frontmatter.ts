/**
 * Pure handling of Obsidian YAML frontmatter. The vault file is never touched;
 * these helpers operate on the in-memory copy the SyncEngine is about to upload.
 * Two jobs: split the leading "---" block off the body so the uploaded document
 * carries no frontmatter, and normalize a parsed frontmatter object into the
 * plain key/value map RAGFlow's document metadata ("meta_fields") expects.
 *
 * YAML parsing itself is injected (Obsidian's parseYaml) so this module stays
 * pure and testable; only the split and the normalization rules live here.
 */

import { stripWikilinks } from "./internalize";

// Frontmatter is only frontmatter when "---" opens the very first line, with a
// matching "---" fence line closing it. Tolerates CRLF and an empty block.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

export interface SplitNote {
	/** Raw YAML between the fences, or null when the note has no frontmatter. */
	yaml: string | null;
	/** The note body with the frontmatter block removed. */
	body: string;
}

/** Split a note's leading frontmatter block from its body. Pure. */
export function splitFrontmatter(text: string): SplitNote {
	const match = FRONTMATTER.exec(text);
	if (!match) return { yaml: null, body: text };
	return { yaml: match[1] ?? "", body: text.slice(match[0].length) };
}

/**
 * Recursively rewrite every Obsidian [[wikilink]] / ![[embed]] inside a metadata
 * value to its plain display text. Walks strings, arrays, and nested mappings so
 * a value like "[[Project A]]" or ["[[A]]", "[[B|b]]"] reaches RAGFlow as clean
 * text; non-string leaves (numbers, booleans, null) pass through untouched.
 */
function cleanWikilinks(value: unknown): unknown {
	if (typeof value === "string") return stripWikilinks(value);
	if (Array.isArray(value)) return value.map(cleanWikilinks);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
			out[key] = cleanWikilinks(v);
		}
		return out;
	}
	return value;
}

/**
 * Normalize a parsed-YAML value into a metadata object. Returns an empty object
 * unless the parse produced a plain key/value mapping; undefined-valued keys are
 * dropped so they are not sent as metadata. Wikilinks in values are cleaned to
 * plain text so RAGFlow metadata never carries raw [[...]] syntax.
 */
export function normalizeMeta(parsed: unknown): Record<string, unknown> {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value === undefined) continue;
		out[key] = cleanWikilinks(value);
	}
	return out;
}
