import { parseYaml } from "obsidian";
import { isNotFound, RagflowClient } from "./ragflowClient";
import { DocumentIndex } from "./documentIndex";
import { SyncStateStore } from "./syncState";
import { sha256 } from "./hash";
import { internalizeMarkdown } from "./internalize";
import { normalizeMeta, splitFrontmatter } from "./frontmatter";
import { normalizeTables } from "./tables";
import {
	buildCompanionIndex,
	lookupCompanion,
	type CompanionIndex,
} from "./companionMetadata";
import {
	FileChange,
	RagflowSyncSettings,
	SyncedFileRecord,
} from "./types";
import type { VaultAccess } from "./vaultAccess";

export const PROCESSING_VERSION = 4;

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

const FLUSH_EVERY = 25;

const EMPTY_NAMES: ReadonlySet<string> = new Set();

/**
 * Files in flight at once. Each file costs several round trips, and they are
 * independent, so a small pool turns a long serial chain into a much shorter
 * one. Kept modest so a big sync does not flood a self-hosted RAGFlow.
 */
const UPLOAD_CONCURRENCY = 4;

/** Run `worker` over `items`, at most `limit` at a time, in list order. */
async function runPool<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	const runners = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const index = next++;
				if (index >= items.length) return;
				await worker(items[index]);
			}
		}
	);
	await Promise.all(runners);
}

export interface ApplyResult {
	ok: number;
	failed: number;
	errors: string[];
	/** Documents queued for parsing in RAGFlow (0 when auto-parse is off). */
	parsed: number;
}

export interface SyncApplyRunInput {
	vault: VaultAccess;
	client: RagflowClient;
	store: SyncStateStore;
	settings: RagflowSyncSettings;
	changes: FileChange[];
	onProgress?: (done: number, total: number, label: string) => void;
	processingVersion?: number;
}

interface UploadResult {
	datasetId: string;
	documentId: string;
	error?: Error;
}

/**
 * A Sync apply run applies non-unchanged Change kinds to RAGFlow and the Synced
 * state. It owns upload/delete ordering, metadata retry semantics, parse queue
 * construction, periodic flushes, and per-file accounting.
 */
export async function applySyncRun(input: SyncApplyRunInput): Promise<ApplyResult> {
	const run = new SyncApplyRun(input);
	return run.apply();
}

class SyncApplyRun {
	private vault: VaultAccess;
	private client: RagflowClient;
	private store: SyncStateStore;
	private settings: RagflowSyncSettings;
	private changes: FileChange[];
	private onProgress?: (done: number, total: number, label: string) => void;
	private processingVersion: number;
	private index: DocumentIndex;
	/** dataset name -> vault filenames under it, built on first use. */
	private protectedNames = new Map<string, Set<string>>();

	constructor(input: SyncApplyRunInput) {
		this.vault = input.vault;
		this.client = input.client;
		this.store = input.store;
		this.settings = input.settings;
		this.changes = input.changes;
		this.onProgress = input.onProgress;
		this.processingVersion = input.processingVersion ?? PROCESSING_VERSION;
		this.index = new DocumentIndex(input.client);
	}

	async apply(): Promise<ApplyResult> {
		const actionable = this.changes.filter((c) => c.kind !== "unchanged");
		// Uploads before deletions, as the assembled change list has always
		// ordered them; only the parallelism within each phase is new.
		const uploads = actionable.filter((c) => c.kind !== "deleted");
		const deletions = actionable.filter((c) => c.kind === "deleted");

		let done = 0;
		const result: ApplyResult = { ok: 0, failed: 0, errors: [], parsed: 0 };
		const uploaded = new Map<string, string[]>();

		const companionIndex = await buildCompanionIndex(this.settings, this.vault);
		let sinceFlush = 0;

		const step = async (change: FileChange): Promise<void> => {
			try {
				if (change.kind === "new" || change.kind === "missing") {
					// "missing" means a reconcile found the tracked document gone from
					// RAGFlow, so there is nothing to delete first: upload as if new.
					const up = await this.syncUpload(change, undefined, companionIndex);
					this.recordUpload(uploaded, up);
					if (up.error) throw up.error;
				} else if (change.kind === "modified") {
					const up = await this.syncUpload(change, change.record, companionIndex);
					this.recordUpload(uploaded, up);
					if (up.error) throw up.error;
				} else if (change.kind === "deleted") {
					await this.syncDelete(change);
				}
				result.ok += 1;
			} catch (e) {
				result.failed += 1;
				result.errors.push(`${change.vaultPath}: ${(e as Error).message}`);
			}
			done += 1;
			if (++sinceFlush >= FLUSH_EVERY) {
				sinceFlush = 0;
				await this.store.flush();
			}
			this.onProgress?.(done, actionable.length, change.vaultPath);
		};

		try {
			await runPool(uploads, UPLOAD_CONCURRENCY, step);
			await runPool(deletions, UPLOAD_CONCURRENCY, step);
		} finally {
			await this.store.flush();
		}

		if (this.settings.autoParse) {
			await this.parseUploaded(uploaded, done, actionable.length, result);
		}

		return result;
	}

	private async syncDelete(change: FileChange): Promise<void> {
		if (change.record) {
			try {
				await this.client.deleteDocuments(change.record.datasetId, [
					change.record.documentId,
				]);
			} catch (e) {
				// A document RAGFlow says it does not have is already in the state we
				// wanted, so clearing the record is correct. Any other failure left
				// the document in place: keep the record and report the failure, so
				// the deletion is retried instead of quietly becoming an orphan that
				// only a reconcile could ever find again.
				if (!isNotFound(e)) throw e;
			}
		}
		this.store.deleteFile(change.vaultPath);
	}

	private async parseUploaded(
		uploaded: Map<string, string[]>,
		done: number,
		total: number,
		result: ApplyResult
	): Promise<void> {
		for (const [datasetId, ids] of uploaded) {
			this.onProgress?.(done, total, `Parsing ${ids.length} document(s)...`);
			try {
				await this.client.parseDocuments(datasetId, ids);
				result.parsed += ids.length;
			} catch (e) {
				result.errors.push(
					`parse (dataset ${datasetId}): ${(e as Error).message}`
				);
			}
		}
	}

	private recordUpload(
		uploaded: Map<string, string[]>,
		up: { datasetId: string; documentId: string }
	): void {
		const ids = uploaded.get(up.datasetId);
		if (ids) ids.push(up.documentId);
		else uploaded.set(up.datasetId, [up.documentId]);
	}

	private async syncUpload(
		change: FileChange,
		oldRecord: SyncedFileRecord | undefined,
		companionIndex: CompanionIndex
	): Promise<UploadResult> {
		const file = this.vault.getFile(change.vaultPath);
		if (!file) {
			throw new Error("File no longer exists in vault.");
		}
		const bytes = await this.vault.readBinary(file.path);
		const hash = change.hash ?? (await sha256(bytes));
		const datasetId = await this.datasetIdFor(change);

		if (oldRecord) {
			try {
				await this.client.deleteDocuments(oldRecord.datasetId, [
					oldRecord.documentId,
				]);
			} catch (_e) {
				// Old document may already be gone; continue with upload.
			}
		}

		await this.clearDuplicateDocuments(
			datasetId,
			file.name,
			change.mapping?.datasetName
		);

		const prepared =
			file.extension.toLowerCase() === "md"
				? this.prepareMarkdown(bytes, file.path)
				: { uploadBytes: bytes, meta: {} as Record<string, unknown> };
		const uploadBytes = prepared.uploadBytes;
		let meta = prepared.meta;

		const sourceFolder = change.mapping?.companionSourceFolder;
		if (Object.keys(meta).length === 0 && sourceFolder) {
			const found = lookupCompanion(companionIndex, sourceFolder, file);
			if (found) {
				meta = found;
			} else {
				console.warn(
					`RAGFlow Sync: no companion metadata for ${change.vaultPath} - ` +
						`no note in "${sourceFolder}" has a frontmatter link to it, ` +
						`so the document is uploaded without metadata.`
				);
			}
		}

		const contentType = CONTENT_TYPES[file.extension.toLowerCase()];
		const doc = await this.client.uploadDocument(
			datasetId,
			file.name,
			uploadBytes,
			contentType
		);
		this.index.record(datasetId, file.name, doc.id);

		let metaError: Error | null = null;
		if (Object.keys(meta).length > 0) {
			metaError = await this.setDocumentMetadataBestEffort(
				datasetId,
				doc.id,
				change.vaultPath,
				meta
			);
		}

		this.store.setFile(change.vaultPath, {
			documentId: doc.id,
			datasetId,
			hash,
			size: file.stat.size,
			mtime: file.stat.mtime,
			lastSyncedAt: Date.now(),
			processingVersion: this.processingVersion,
			...(metaError ? { metaPending: true } : {}),
		});

		delete this.settings.ignoredEntries[change.vaultPath];

		return {
			datasetId,
			documentId: doc.id,
			...(metaError
				? {
						error: new Error(
							`uploaded, but setting metadata failed: ${metaError.message} ` +
								`(document kept; metadata will be retried on the next scan)`
						),
					}
				: {}),
		};
	}

	private async setDocumentMetadataBestEffort(
		datasetId: string,
		documentId: string,
		vaultPath: string,
		meta: Record<string, unknown>
	): Promise<Error | null> {
		try {
			await this.client.setDocumentMetadata(datasetId, documentId, meta);
			return null;
		} catch (e) {
			const batchError = e as Error;
			console.warn(
				`RAGFlow Sync: metadata update for ${vaultPath} failed as a batch; ` +
					`retrying field by field:`,
				batchError,
				"\nmeta_fields sent:",
				JSON.stringify(meta)
			);

			const accepted: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(meta)) {
				const candidate = { ...accepted, [key]: value };
				try {
					await this.client.setDocumentMetadata(
						datasetId,
						documentId,
						candidate
					);
					accepted[key] = value;
				} catch (fieldError) {
					console.warn(
						`RAGFlow Sync: dropped metadata field "${key}" for ` +
							`${vaultPath}: ${(fieldError as Error).message}`,
						"\nfield sent:",
						JSON.stringify({ [key]: value })
					);
				}
			}

			if (Object.keys(accepted).length > 0) {
				return null;
			}

			console.error(
				`RAGFlow Sync: failed to set metadata for ${vaultPath}:`,
				batchError,
				"\nmeta_fields sent:",
				JSON.stringify(meta)
			);
			return batchError;
		}
	}

	/**
	 * Filenames the vault holds for a dataset. A document whose name is one of
	 * these is a real file's document, never a duplicate to sweep up.
	 */
	private protectedNamesFor(datasetName: string | undefined): ReadonlySet<string> {
		if (!datasetName) return EMPTY_NAMES;
		const cached = this.protectedNames.get(datasetName);
		if (cached) return cached;

		const names = new Set<string>();
		for (const change of this.changes) {
			if (change.kind === "deleted") continue;
			if (change.mapping?.datasetName !== datasetName) continue;
			const slash = change.vaultPath.lastIndexOf("/");
			names.add(
				slash < 0 ? change.vaultPath : change.vaultPath.slice(slash + 1)
			);
		}
		this.protectedNames.set(datasetName, names);
		return names;
	}

	private async clearDuplicateDocuments(
		datasetId: string,
		name: string,
		datasetName: string | undefined
	): Promise<void> {
		try {
			const dupes = await this.index.duplicateIds(
				datasetId,
				name,
				this.protectedNamesFor(datasetName)
			);
			if (dupes.length > 0) {
				await this.client.deleteDocuments(datasetId, dupes);
				this.index.forget(datasetId, new Set(dupes));
			}
		} catch (e) {
			console.warn(
				`RAGFlow Sync: could not clear duplicates of ${name} before ` +
					`upload: ${(e as Error).message}`
			);
		}
	}

	private async datasetIdFor(change: FileChange): Promise<string> {
		if (!change.mapping) {
			throw new Error("Cannot place a file without an owning mapping.");
		}
		return this.client.ensureDatasetId(change.mapping.datasetName);
	}

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

		let transformed = this.settings.internalizeLinks
			? internalizeMarkdown(body, this.vault.relatedLinks(path))
			: body;
		if (this.settings.normalizeTables) {
			transformed = normalizeTables(transformed);
		}
		return {
			uploadBytes: new TextEncoder().encode(transformed).buffer,
			meta,
		};
	}

}
