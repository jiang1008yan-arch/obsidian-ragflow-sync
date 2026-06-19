import { parseYaml } from "obsidian";
import { RagflowClient } from "./ragflowClient";
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

	constructor(input: SyncApplyRunInput) {
		this.vault = input.vault;
		this.client = input.client;
		this.store = input.store;
		this.settings = input.settings;
		this.changes = input.changes;
		this.onProgress = input.onProgress;
		this.processingVersion = input.processingVersion ?? PROCESSING_VERSION;
	}

	async apply(): Promise<ApplyResult> {
		const actionable = this.changes.filter((c) => c.kind !== "unchanged");
		let done = 0;
		const result: ApplyResult = { ok: 0, failed: 0, errors: [], parsed: 0 };
		const uploaded = new Map<string, string[]>();

		const companionIndex = await buildCompanionIndex(this.settings, this.vault);
		let sinceFlush = 0;
		try {
			for (const change of actionable) {
				try {
					if (change.kind === "new") {
						const up = await this.syncUpload(change, undefined, companionIndex);
						this.recordUpload(uploaded, up);
						if (up.error) throw up.error;
					} else if (change.kind === "modified") {
						const up = await this.syncUpload(
							change,
							change.record,
							companionIndex
						);
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
					await this.store.flush();
					sinceFlush = 0;
				}
				this.onProgress?.(done, actionable.length, change.vaultPath);
			}
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
				console.warn(
					`RAGFlow Sync: delete of ${change.vaultPath} failed ` +
						`(treating as already gone): ${(e as Error).message}`
				);
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

		await this.clearDuplicateDocuments(datasetId, file.name);

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

	private async clearDuplicateDocuments(
		datasetId: string,
		name: string
	): Promise<void> {
		try {
			const dupes = await this.client.findDuplicateDocumentIds(datasetId, name);
			if (dupes.length > 0) {
				await this.client.deleteDocuments(datasetId, dupes);
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
