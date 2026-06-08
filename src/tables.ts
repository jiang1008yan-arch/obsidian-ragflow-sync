/**
 * Pure normalization of Markdown tables into the clean, border-style GFM that
 * RAGFlow's Markdown chunker reliably detects and aligns. No IO, no Obsidian:
 * the SyncEngine hands the note body here before upload.
 *
 * Why not HTML: RAGFlow's General/naive parser converts Markdown pipe tables to
 * HTML itself and renders them as one table chunk, but only newer versions also
 * detect pre-made HTML <table> blocks — older ones keep the raw tags as text.
 * Normalized Markdown works across versions. The real cause of "mis-aligned"
 * tables is a stray "|" inside a cell — most often an Obsidian [[Note|alias]]
 * link — which shifts every column; here each cell is parsed with awareness of
 * [[ ]], `code` spans, and \| escapes, then re-emitted with its interior pipes
 * escaped so columns stay put. Rows are padded/truncated to the header width and
 * a blank line is guaranteed on each side so the table is detected. The vault
 * file is never modified; only the uploaded copy is.
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

/**
 * Make a parsed cell safe to re-emit between pipes: collapse any stray newlines
 * and escape every interior "|" (e.g. from a [[Note|alias]] link or inline
 * code) as "\|" so it can never split the column.
 */
function escapeCell(cell: string): string {
	return cell.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

/** Normalize one delimiter cell to a canonical marker, preserving alignment. */
function normalizeDelim(cell: string): string {
	const left = cell.startsWith(":");
	const right = cell.endsWith(":");
	if (left && right) return ":---:";
	if (right) return "---:";
	if (left) return ":---";
	return "---";
}

/** Emit one Markdown row, padding/truncating to the header width. */
function renderRow(cells: string[], n: number): string {
	const padded = cells.slice(0, n).map(escapeCell);
	while (padded.length < n) padded.push("");
	return `| ${padded.join(" | ")} |`;
}

function renderTable(
	header: string[],
	delim: string[],
	rows: string[][]
): string {
	const n = header.length;
	const delimCells = delim.slice(0, n).map(normalizeDelim);
	while (delimCells.length < n) delimCells.push("---");
	return [
		renderRow(header, n),
		`| ${delimCells.join(" | ")} |`,
		...rows.map((r) => renderRow(r, n)),
	].join("\n");
}

/**
 * Rewrite every GFM table in the Markdown body to clean border-style Markdown,
 * leaving all other text (and tables inside fenced code blocks) untouched. A
 * blank line is ensured before and after each table so RAGFlow detects it.
 */
export function normalizeTables(src: string): string {
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
				if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
				out.push(renderTable(header, delim, rows));
				if (lines[j] !== undefined && lines[j].trim() !== "") out.push("");
				i = j - 1;
				continue;
			}
		}
		out.push(line);
	}
	return out.join("\n");
}
