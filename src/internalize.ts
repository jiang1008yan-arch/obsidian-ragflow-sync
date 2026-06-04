import { RelatedLinks } from "./types";

/**
 * Pure transformation of Obsidian "double links" into a RAGFlow-friendly form.
 * No IO, no Obsidian: the SyncEngine resolves the related-note titles (from the
 * metadata cache) and hands them here together with the file's raw text. Two
 * jobs: rewrite inline [[wikilinks]] / ![[embeds]] to plain text or standard
 * Markdown, and append a "Related notes" section listing outgoing links and
 * backlinks so the bidirectional relationship survives in the uploaded copy.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;

interface ParsedLink {
	/** The link target before any "#heading" or "|alias" (may be empty for [[#heading]]). */
	target: string;
	heading?: string;
	alias?: string;
}

function parseInner(inner: string): ParsedLink {
	const pipe = inner.indexOf("|");
	const linkPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
	const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : undefined;
	const hash = linkPart.indexOf("#");
	const target = (hash >= 0 ? linkPart.slice(0, hash) : linkPart).trim();
	const heading = hash >= 0 ? linkPart.slice(hash + 1).trim() : undefined;
	return { target, heading, alias: alias || undefined };
}

/** A readable title for a note path/target: last segment, sans a ".md" suffix. */
export function noteTitle(target: string): string {
	const last = target.split("/").pop() ?? target;
	return last.replace(/\.md$/i, "");
}

/** The plain text Obsidian would show for a link (alias > "Note > Heading" > Note). */
function linkDisplay(p: ParsedLink): string {
	if (p.alias) return p.alias;
	if (!p.target) return p.heading ?? "";
	const name = noteTitle(p.target);
	return p.heading ? `${name} > ${p.heading}` : name;
}

/**
 * Replace [[wikilinks]] and ![[embeds]] in the body. Image embeds become
 * standard Markdown images; everything else collapses to its display text.
 */
export function internalizeWikilinks(content: string): string {
	// Embeds first, so the leading "!" is consumed rather than orphaned by the
	// plain-link pass that follows.
	const withEmbeds = content.replace(
		/!\[\[([^[\]]+)\]\]/g,
		(_m, inner: string) => {
			const p = parseInner(inner);
			if (IMAGE_EXT.test(p.target)) {
				return `![${p.alias ?? noteTitle(p.target)}](${p.target})`;
			}
			return linkDisplay(p);
		}
	);
	return withEmbeds.replace(/\[\[([^[\]]+)\]\]/g, (_m, inner: string) =>
		linkDisplay(parseInner(inner))
	);
}

function dedupe(titles: string[]): string[] {
	return [...new Set(titles.filter((t) => t.length > 0))];
}

/**
 * The appended section listing outgoing links and backlinks. Empty string when
 * the note has neither, so callers can append unconditionally.
 */
export function buildRelatedSection(related: RelatedLinks): string {
	const outgoing = dedupe(related.outgoing);
	const incoming = dedupe(related.incoming);
	if (outgoing.length === 0 && incoming.length === 0) return "";

	const lines = ["## Related notes", ""];
	if (outgoing.length > 0) lines.push(`**Links:** ${outgoing.join(", ")}`, "");
	if (incoming.length > 0) lines.push(`**Backlinks:** ${incoming.join(", ")}`, "");
	return lines.join("\n").trimEnd();
}

/** Full transform: rewrite inline links, then append the related-notes section. */
export function internalizeMarkdown(
	content: string,
	related: RelatedLinks
): string {
	const body = internalizeWikilinks(content);
	const section = buildRelatedSection(related);
	if (!section) return body;
	return `${body.replace(/\s+$/, "")}\n\n${section}\n`;
}
