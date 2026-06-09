import { App, parseYaml, TFile } from "obsidian";
import { RagflowClient } from "./ragflowClient";
import { SyncStateStore } from "./syncState";
import { sha256 } from "./hash";
import { assembleChanges, classifyByStat, finalizeWithHashes } from "./diff";
import { internalizeMarkdown, noteTitle } from "./internalize";
import {
	frontmatterLinkTargets,
	normalizeMeta,
	splitFrontmatter,
} from "./frontmatter";
import { normalizeTables } from "./tables";
import {
	ChangeKind,
	DatasetMapping,
	DiffResult,
	FileChange,
	RagflowSyncSettings,
	RelatedLinks,
	ScopeConfig,
	SyncedFileRecord,
	VaultEntry,
} from "./types";

/**
 * Version of the Markdown upload transform (frontmatter strip, metadata
 * wikilink cleaning, link internalization, table normalization). Bump this
 * whenever that processing changes so already-synced notes are re-uploaded on
 * the next scan even though their source content is unchanged. Records written
 * before versioning carry no version and so are treated as stale, forcing a
 * one-time re-sync.
 */
export const PROCESSING_VERSION = 3;

const CONTENT_TYPES: Record<string, string> = {
	md: "text/markdown",
	txt: "text/plain",
	pdf: "application/pdf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
};

export interface ApplyResult {
	ok: number;
	failed: number;
	errors: string[];
}

/**
 * Orchestrates the sync: builds the vault snapshot, drives the pure Diff,
 * performs the hashing/persistence IO, and applies changes to RAGFlow. The
 * classification rules themselves live in ./diff (pure, synchronous, tested
 * through an in-memory snapshot).
 */
export class SyncEngine {
	private app: App;
	private client: RagflowClient;
	private store: SyncStateStore;
	private getSettings: () => RagflowSyncSettings;
	/**
	 * Per-run companion-metadata lookup, built at the start of applyChanges and
	 * cleared at the end: source folder -> (linked-file path -> that note's
	 * frontmatter). Null outside an apply run.
	 */
	private companionIndex:
		| Map<string, Map<string, Record<string, unknown>>>
		| null = null;

	constructor(
		app: App,
		client: RagflowClient,
		store: SyncStateStore,
		getSettings: () => RagflowSyncSettings
	) {
		this.app = app;
		this.client = client;
		this.store = store;
		this.getSettings = getSettings;
	}

	private scope(): ScopeConfig {
		const s = this.getSettings();
		return {
			mappings: s.datasetMappings,
			extensions: s.extensions,
			excludeGlobs: s.excludeGlobs,
			processingVersion: PROCESSING_VERSION,
		};
	}

	/** Obsidian adapter for the vault-snapshot seam: every file, unfiltered. */
	private buildSnapshot(): VaultEntry[] {
		return this.app.vault.getFiles().map((f) => ({
			path: f.path,
			size: f.stat.size,
			mtime: f.stat.mtime,
		}));
	}

	private async hashPath(path: string): Promise<string> {
		const bytes = await this.app.vault.adapter.readBinary(path);
		return sha256(bytes);
	}

	private missingMappings(): DatasetMapping[] {
		return this.getSettings().datasetMappings.filter(
			(m) =>
				m.vaultPath.length > 0 &&
				this.app.vault.getAbstractFileByPath(m.vaultPath) === null
		);
	}

	async computeDiff(): Promise<DiffResult> {
		const state = this.getSettings().state;
		const scope = this.scope();

		const stat = classifyByStat(this.buildSnapshot(), state, scope);

		const hashes = new Map<string, string>();
		for (const item of stat.needHash) {
			try {
				hashes.set(item.entry.path, await this.hashPath(item.entry.path));
			} catch (_e) {
				// Leave unset: finalize treats a missing hash as modified.
			}
		}
		const hashed = finalizeWithHashes(stat.needHash, hashes);

		// Apply touch refreshes explicitly (no longer a hidden write inside the
		// classification): identical content, drifted stats -> refresh to keep
		// the next diff on the fast path.
		for (const touch of hashed.touches) {
			await this.store.setFile(touch.vaultPath, {
				...touch.record,
				size: touch.size,
				mtime: touch.mtime,
			});
		}

		return {
			changes: assembleChanges(stat, hashed),
			missingMappings: this.missingMappings(),
		};
	}

	private async datasetIdFor(change: FileChange): Promise<string> {
		if (!change.mapping) {
			throw new Error("Cannot place a file without an owning mapping.");
		}
		return this.client.ensureDatasetId(change.mapping.datasetName);
	}

	async applyChanges(
		changes: FileChange[],
		onProgress?: (done: number, total: number, label: string) => void
	): Promise<ApplyResult> {
		const actionable = changes.filter((c) => c.kind !== "unchanged");
		let done = 0;
		const result: ApplyResult = { ok: 0, failed: 0, errors: [] };

		this.companionIndex = this.buildCompanionIndex();
		try {
			for (const change of actionable) {
				try {
					if (change.kind === "new") {
						await this.syncUpload(change, undefined);
					} else if (change.kind === "modified") {
						await this.syncUpload(change, change.record);
					} else if (change.kind === "deleted") {
						if (change.record) {
							await this.client.deleteDocuments(change.record.datasetId, [
								change.record.documentId,
							]);
						}
						await this.store.deleteFile(change.vaultPath);
					}
					result.ok += 1;
				} catch (e) {
					result.failed += 1;
					result.errors.push(`${change.vaultPath}: ${(e as Error).message}`);
				}
				done += 1;
				onProgress?.(done, actionable.length, change.vaultPath);
			}
		} finally {
			this.companionIndex = null;
		}
		return result;
	}

	private async syncUpload(
		change: FileChange,
		oldRecord: SyncedFileRecord | undefined
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(change.vaultPath);
		if (!(file instanceof TFile)) {
			throw new Error("File no longer exists in vault.");
		}
		const bytes = await this.app.vault.adapter.readBinary(file.path);
		const hash = change.hash ?? (await sha256(bytes));
		const datasetId = await this.datasetIdFor(change);

		if (oldRecord) {
			// RAGFlow has no in-place replace: delete then re-upload.
			try {
				await this.client.deleteDocuments(oldRecord.datasetId, [
					oldRecord.documentId,
				]);
			} catch (_e) {
				// Old document may already be gone; continue with upload.
			}
		}

		// Change detection always hashes the raw source above; the Markdown
		// transform (frontmatter strip + optional link internalization) only
		// rewrites the bytes we hand to RAGFlow — the vault file is untouched.
		const prepared =
			file.extension.toLowerCase() === "md"
				? this.prepareMarkdown(bytes, file.path)
				: { uploadBytes: bytes, meta: {} as Record<string, unknown> };
		const uploadBytes = prepared.uploadBytes;
		let meta = prepared.meta;

		// Companion metadata: a file with no metadata of its own — chiefly an
		// attachment like a PDF — inherits the frontmatter of a note in the
		// mapping's source folder that links to it. Files that already carry their
		// own metadata, and files no source note links to, are left as-is.
		const sourceFolder = change.mapping?.companionSourceFolder;
		if (Object.keys(meta).length === 0 && sourceFolder) {
			const found = this.lookupCompanion(sourceFolder, file);
			if (found) meta = found;
		}

		const contentType = CONTENT_TYPES[file.extension.toLowerCase()];
		const doc = await this.client.uploadDocument(
			datasetId,
			file.name,
			uploadBytes,
			contentType
		);

		// Set the note's frontmatter as RAGFlow document metadata. Best-effort:
		// a metadata failure should not undo a successful upload.
		if (Object.keys(meta).length > 0) {
			try {
				await this.client.setDocumentMetadata(datasetId, doc.id, meta);
			} catch (e) {
				console.error(
					`RAGFlow Sync: failed to set metadata for ${change.vaultPath}:`,
					e
				);
			}
		}

		await this.store.setFile(change.vaultPath, {
			documentId: doc.id,
			datasetId,
			hash,
			size: file.stat.size,
			mtime: file.stat.mtime,
			lastSyncedAt: Date.now(),
			processingVersion: PROCESSING_VERSION,
		});
	}

	/**
	 * Decode a Markdown file, strip its YAML frontmatter (parsed out as metadata),
	 * optionally internalize its links and convert its tables to HTML, then
	 * re-encode the body as UTF-8. The frontmatter becomes the document's RAGFlow
	 * metadata rather than living in the uploaded text.
	 */
	private prepareMarkdown(
		bytes: ArrayBuffer,
		path: string
	): { uploadBytes: ArrayBuffer; meta: Record<string, unknown> } {
		const text = new TextDecoder().decode(bytes);
		const { yaml, body } = splitFrontmatter(text);

		let meta: Record<string, unknown> = {};
		if (yaml !== null) {
			try {
				meta = normalizeMeta(parseYaml(yaml));
			} catch (e) {
				console.error(`RAGFlow Sync: invalid frontmatter in ${path}:`, e);
			}
		}

		const settings = this.getSettings();
		let transformed = settings.internalizeLinks
			? internalizeMarkdown(body, this.relatedLinks(path))
			: body;
		if (settings.normalizeTables) {
			transformed = normalizeTables(transformed);
		}
		return {
			uploadBytes: new TextEncoder().encode(transformed).buffer,
			meta,
		};
	}

	/**
	 * Build the companion-metadata lookup for this apply run. For each distinct
	 * source folder configured on a mapping, scan that folder's notes; whenever a
	 * note's frontmatter links to a file (e.g. `file: "[[report.pdf]]"`), record
	 * that the linked file inherits the note's normalized frontmatter. Keyed by
	 * source folder so an attachment only matches notes from its own mapping's
	 * folder. The link target is read straight from the frontmatter text and
	 * indexed under several keys (see indexCompanionTarget) so resolution survives
	 * a link that carries an extension, omits one, or does not resolve uniquely.
	 */
	private buildCompanionIndex(): Map<
		string,
		Map<string, Record<string, unknown>>
	> {
		const index = new Map<string, Map<string, Record<string, unknown>>>();
		const folders = new Set(
			this.getSettings()
				.datasetMappings.map((m) => m.companionSourceFolder)
				.filter((f): f is string => !!f && f.length > 0)
		);

		for (const folder of folders) {
			const map = new Map<string, Record<string, unknown>>();
			const prefix = `${folder}/`;
			const notes = this.app.vault
				.getMarkdownFiles()
				.filter((f) => f.path === folder || f.path.startsWith(prefix));

			for (const note of notes) {
				const fm = this.app.metadataCache.getFileCache(note)?.frontmatter;
				if (!fm) continue;
				const targets = frontmatterLinkTargets(fm);
				if (targets.length === 0) continue;
				const meta = normalizeMeta(fm);
				for (const target of targets) {
					this.indexCompanionTarget(map, note, target, meta);
				}
			}
			index.set(folder, map);
		}
		return index;
	}

	/**
	 * Record a companion match under every key a later upload might look it up by,
	 * so a link survives whether or not it carries an extension and whether or not
	 * it resolves to a unique vault path: the resolved path (when Obsidian can
	 * resolve it), plus the link's file name and its extension-less base, both
	 * lower-cased and prefixed so the key spaces never collide.
	 */
	private indexCompanionTarget(
		map: Map<string, Record<string, unknown>>,
		note: TFile,
		linkpath: string,
		meta: Record<string, unknown>
	): void {
		const dest = this.app.metadataCache.getFirstLinkpathDest(
			linkpath,
			note.path
		);
		if (dest) map.set(dest.path, meta);

		const name = (linkpath.split("/").pop() ?? linkpath).trim();
		if (!name) return;
		map.set(`name:${name.toLowerCase()}`, meta);
		const dot = name.lastIndexOf(".");
		const base = dot > 0 ? name.slice(0, dot) : name;
		map.set(`base:${base.toLowerCase()}`, meta);
	}

	/** A file's companion metadata: by resolved path, then file name, then base. */
	private lookupCompanion(
		sourceFolder: string,
		file: TFile
	): Record<string, unknown> | undefined {
		const map = this.companionIndex?.get(sourceFolder);
		if (!map) return undefined;
		return (
			map.get(file.path) ??
			map.get(`name:${file.name.toLowerCase()}`) ??
			map.get(`base:${file.basename.toLowerCase()}`)
		);
	}

	/**
	 * Outgoing links and backlinks for a note, as titles, from Obsidian's
	 * resolved-link graph. Only note-to-note (.md) relationships are listed;
	 * attachments and unresolved links are ignored.
	 */
	private relatedLinks(path: string): RelatedLinks {
		const resolved = this.app.metadataCache.resolvedLinks ?? {};
		const isNote = (p: string) => p.toLowerCase().endsWith(".md");

		const outgoing = Object.keys(resolved[path] ?? {})
			.filter((target) => target !== path && isNote(target))
			.map(noteTitle);

		const incoming: string[] = [];
		for (const [source, targets] of Object.entries(resolved)) {
			if (source !== path && isNote(source) && targets[path]) {
				incoming.push(noteTitle(source));
			}
		}
		return { outgoing, incoming };
	}
}

export function summarize(changes: FileChange[]): Record<ChangeKind, number> {
	const counts: Record<ChangeKind, number> = {
		new: 0,
		modified: 0,
		deleted: 0,
		unchanged: 0,
	};
	for (const c of changes) counts[c.kind] += 1;
	return counts;
}
