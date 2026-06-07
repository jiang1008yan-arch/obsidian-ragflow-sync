import { App, parseYaml, TFile } from "obsidian";
import { RagflowClient } from "./ragflowClient";
import { SyncStateStore } from "./syncState";
import { sha256 } from "./hash";
import { assembleChanges, classifyByStat, finalizeWithHashes } from "./diff";
import { internalizeMarkdown, noteTitle } from "./internalize";
import { normalizeMeta, splitFrontmatter } from "./frontmatter";
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
		const { uploadBytes, meta } =
			file.extension.toLowerCase() === "md"
				? this.prepareMarkdown(bytes, file.path)
				: { uploadBytes: bytes, meta: {} };

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
		});
	}

	/**
	 * Decode a Markdown file, strip its YAML frontmatter (parsed out as metadata),
	 * optionally internalize its links, and re-encode the body as UTF-8. The
	 * frontmatter becomes the document's RAGFlow metadata rather than living in
	 * the uploaded text.
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

		const transformed = this.getSettings().internalizeLinks
			? internalizeMarkdown(body, this.relatedLinks(path))
			: body;
		return {
			uploadBytes: new TextEncoder().encode(transformed).buffer,
			meta,
		};
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
