/**
 * Pure extraction of a note's tags into the flat keyword list RAGFlow chunks
 * carry as `important_keywords`. The input is the value of the frontmatter
 * `tags` key (already-parsed YAML), never the whole note.
 *
 * Obsidian accepts several shapes for `tags`, so this tolerates all of them:
 * a YAML list (`[ml, research]`), a single string, or a bare string with
 * whitespace/comma-separated tags. A leading "#" is stripped; a nested tag like
 * "area/ml" is kept as the full path (the "/" is not a separator). The result is
 * de-duplicated with first-seen order preserved. A missing/empty value yields an
 * empty list, which the caller treats as "skip this note".
 */
export function noteTags(tagsValue: unknown): string[] {
	const out: string[] = [];
	const push = (raw: string): void => {
		for (const piece of raw.split(/[\s,]+/)) {
			const tag = piece.replace(/^#+/, "").trim();
			if (tag) out.push(tag);
		}
	};
	const visit = (v: unknown): void => {
		if (v === null || v === undefined) return;
		if (Array.isArray(v)) {
			v.forEach(visit);
		} else if (typeof v === "string") {
			push(v);
		} else if (typeof v === "number" || typeof v === "boolean") {
			push(String(v));
		}
		// Objects/dates carry no meaningful tag; ignore them.
	};
	visit(tagsValue);
	return [...new Set(out)];
}
