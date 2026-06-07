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
 * Normalize a parsed-YAML value into a metadata object. Returns an empty object
 * unless the parse produced a plain key/value mapping; undefined-valued keys are
 * dropped so they are not sent as metadata.
 */
export function normalizeMeta(parsed: unknown): Record<string, unknown> {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value === undefined) continue;
		out[key] = value;
	}
	return out;
}
