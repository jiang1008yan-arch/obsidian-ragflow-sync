/**
 * Pure conversion of GitHub-Flavored-Markdown tables into HTML <table> blocks.
 * No IO, no Obsidian: the SyncEngine hands the note body here before upload.
 *
 * Why: RAGFlow's Markdown chunker is fragile with pipe ("|") tables — a single
 * unescaped pipe (notably from an Obsidian [[Note|alias]] link sitting inside a
 * cell) shifts every column, and tables that lack surrounding blank lines or a
 * clean delimiter row get sliced into the surrounding prose. An explicit HTML
 * table is unambiguous: RAGFlow keeps it intact as one structured chunk, and the
 * column-splitting here honors [[ ]] and `code` spans so pipes inside them never
 * break a row. The vault file is never modified; only the uploaded copy is.
 */

/** Opening/closing fence for a code block; tables inside are left untouched. */
const FENCE = /^\s*(```|~~~)/;

/** A delimiter cell: optional leading/trailing ":" around one or more dashes. */
const DELIM_CELL = /^:?-+:?$/;

/**
 * Split one table row into trimmed cell strings. Honors backslash escapes,
 * inline `code` spans, and [[wikilink|alias]] pipes — none of which split a
 * column. Optional leading/trailing edge pipes are dropped.
 */
export function splitRow(line: string): string[] {
	const cells: string[] = [];
	let cur = "";
	let inCode = false;
	let bracketDepth = 0;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && i + 1 < line.length) {
			const next = line[i + 1];
			// A literal "\|" renders as "|" inside the cell; keep other escapes.
			cur += next === "|" ? "|" : "\\" + next;
			i++;
			continue;
		}
		if (ch === "`") {
			inCode = !inCode;
			cur += ch;
			continue;
		}
		if (!inCode && ch === "[" && line[i + 1] === "[") {
			bracketDepth++;
			cur += "[[";
			i++;
			continue;
		}
		if (!inCode && ch === "]" && line[i + 1] === "]" && bracketDepth > 0) {
			bracketDepth--;
			cur += "]]";
			i++;
			continue;
		}
		if (ch === "|" && !inCode && bracketDepth === 0) {
			cells.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	cells.push(cur);
	if (cells.length > 1 && cells[0].trim() === "") cells.shift();
	if (cells.length > 1 && cells[cells.length - 1].trim() === "") cells.pop();
	return cells.map((c) => c.trim());
}

/** True when every cell of a row is a GFM alignment marker (the delimiter row). */
function isDelimiterRow(cells: string[]): boolean {
	return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One <tr> with `n` cells of the given tag, padding/truncating to width. */
function renderRow(tag: "th" | "td", cells: string[], n: number): string {
	const padded = cells.slice(0, n);
	while (padded.length < n) padded.push("");
	return `<tr>${padded.map((c) => `<${tag}>${esc(c)}</${tag}>`).join("")}</tr>`;
}

function renderTable(header: string[], rows: string[][]): string {
	const n = header.length;
	const head = `<thead>\n${renderRow("th", header, n)}\n</thead>`;
	const body =
		rows.length > 0
			? `\n<tbody>\n${rows.map((r) => renderRow("td", r, n)).join("\n")}\n</tbody>`
			: "";
	return `<table>\n${head}${body}\n</table>`;
}

/**
 * Rewrite every GFM table in the Markdown body to an HTML <table>, leaving all
 * other text (and tables inside fenced code blocks) untouched.
 */
export function tablesToHtml(src: string): string {
	const lines = src.split("\n");
	const out: string[] = [];
	let inFence = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (FENCE.test(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}

		const next = lines[i + 1];
		if (next !== undefined && line.includes("|")) {
			const header = splitRow(line);
			const delim = splitRow(next);
			if (
				header.length >= 1 &&
				header.length === delim.length &&
				isDelimiterRow(delim)
			) {
				const rows: string[][] = [];
				let j = i + 2;
				while (j < lines.length) {
					const l = lines[j];
					if (l.trim() === "" || FENCE.test(l) || !l.includes("|")) break;
					rows.push(splitRow(l));
					j++;
				}
				out.push(renderTable(header, rows));
				i = j - 1;
				continue;
			}
		}
		out.push(line);
	}
	return out.join("\n");
}
