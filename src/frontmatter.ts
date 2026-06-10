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
 * Dates (js-yaml parses unquoted YAML timestamps into Date) become ISO strings
 * rather than being walked as objects.
 */
function cleanWikilinks(value: unknown): unknown {
	if (typeof value === "string") return stripWikilinks(value);
	if (value instanceof Date) return isoDate(value);
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

/** A date-only YAML timestamp renders as "YYYY-MM-DD"; otherwise full ISO. */
function isoDate(d: Date): string {
	const iso = d.toISOString();
	return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

/**
 * Coerce one frontmatter value into a shape RAGFlow's metadata store accepts:
 * a JSON scalar (string/number/boolean) or an array of them. Nested mappings
 * are serialized to a JSON string (their wikilinks still cleaned), dates become
 * ISO strings, and null/undefined/non-finite values are dropped — RAGFlow's
 * document-metadata backend rejects updates whose values it cannot index, and
 * one bad value fails the whole metadata call.
 */
function metaValue(value: unknown): unknown {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "string") return stripWikilinks(value);
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : undefined;
	}
	if (value instanceof Date) return isoDate(value);
	if (Array.isArray(value)) {
		return value
			.map(metaValue)
			.filter((v) => v !== undefined)
			.map((v) => (typeof v === "object" ? JSON.stringify(v) : v));
	}
	if (typeof value === "object") {
		return JSON.stringify(cleanWikilinks(value));
	}
	return undefined;
}

/**
 * Collect the [[wikilink]] target paths referenced anywhere in a frontmatter
 * value — strings, arrays, and nested mappings. Each target is stripped of its
 * "|alias" and "#heading" so only the link path remains (e.g. "[[report.pdf]]"
 * -> "report.pdf", "[[a/b|c]]" -> "a/b"). Reads the raw frontmatter text rather
 * than relying on the host recognizing a property as a link, so a link survives
 * even in a plain-text property. Pure.
 */
export function frontmatterLinkTargets(value: unknown): string[] {
	const out: string[] = [];
	const visit = (v: unknown): void => {
		if (typeof v === "string") {
			const re = /\[\[([^[\]]+)\]\]/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(v)) !== null) {
				const path = m[1].split("|")[0].split("#")[0].trim();
				if (path) out.push(path);
			}
		} else if (Array.isArray(v)) {
			v.forEach(visit);
		} else if (v !== null && typeof v === "object") {
			Object.values(v as Record<string, unknown>).forEach(visit);
		}
	};
	visit(value);
	return out;
}

/**
 * Normalize a parsed-YAML value into the flat metadata object RAGFlow accepts.
 * Returns an empty object unless the parse produced a plain key/value mapping.
 * Every value is coerced through metaValue: wikilinks cleaned to plain text,
 * dates to ISO strings, nested mappings to JSON strings, null/undefined keys
 * dropped so a single unindexable value cannot fail the metadata update.
 */
export function normalizeMeta(parsed: unknown): Record<string, unknown> {
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		parsed instanceof Date
	) {
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		const v = metaValue(value);
		if (v === undefined) continue;
		out[key] = v;
	}
	return out;
}
