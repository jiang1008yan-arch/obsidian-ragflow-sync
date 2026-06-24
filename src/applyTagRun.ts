import { RagflowClient } from "./ragflowClient";
import { noteTags } from "./noteTags";
import {
	buildCompanionIndex,
	lookupCompanion,
	type CompanionIndex,
} from "./companionMetadata";
import type { VaultAccess } from "./vaultAccess";
import type {
	DatasetMapping,
	RagflowSyncSettings,
	SyncedFileRecord,
} from "./types";

/**
 * One synced document to (re-)tag: its vault path, the synced record that points
 * at the RAGFlow document, and its owning mapping (only needed to find a
 * companion note's tags for a non-markdown document).
 */
export interface TagTarget {
	vaultPath: string;
	record: SyncedFileRecord;
	mapping?: DatasetMapping;
}

export interface TagApplyResult {
	/** Documents whose chunks were tagged (parsed and had ≥1 tag). */
	tagged: number;
	/** Chunk updates actually sent (an already-correct chunk is not counted). */
	chunksWritten: number;
	/** Documents skipped because parsing has not finished (no chunks yet). */
	skippedUnparsed: number;
	/** Documents skipped because the note carries no tags. */
	skippedNoTags: number;
	failed: number;
	errors: string[];
}

export interface TagApplyRunInput {
	vault: VaultAccess;
	client: RagflowClient;
	settings: RagflowSyncSettings;
	targets: TagTarget[];
	onProgress?: (done: number, total: number, label: string) => void;
}

/**
 * Apply each note's `tags` frontmatter to every chunk of its RAGFlow document as
 * important_keywords. A post-parse maintenance step, decoupled from sync: it does
 * not upload, parse, or block — a document that is not parsed yet is skipped and
 * reported. Tags replace a chunk's keywords wholesale, so all chunks of one note
 * carry exactly that note's tags; an already-correct chunk is left untouched to
 * keep re-runs cheap. Per-document failures are accumulated, not fatal.
 */
export async function applyTagRun(
	input: TagApplyRunInput
): Promise<TagApplyResult> {
	const { vault, client, settings, targets, onProgress } = input;
	const result: TagApplyResult = {
		tagged: 0,
		chunksWritten: 0,
		skippedUnparsed: 0,
		skippedNoTags: 0,
		failed: 0,
		errors: [],
	};

	const companionIndex = await buildCompanionIndex(settings, vault);
	let done = 0;
	for (const target of targets) {
		try {
			await tagOne(client, target, await resolveTags(vault, companionIndex, target), result);
		} catch (e) {
			result.failed += 1;
			result.errors.push(`${target.vaultPath}: ${(e as Error).message}`);
		}
		done += 1;
		onProgress?.(done, targets.length, target.vaultPath);
	}
	return result;
}

async function tagOne(
	client: RagflowClient,
	target: TagTarget,
	tags: string[],
	result: TagApplyResult
): Promise<void> {
	if (tags.length === 0) {
		result.skippedNoTags += 1;
		return;
	}
	const { datasetId, documentId } = target.record;
	const status = await client.getDocumentStatus(datasetId, documentId);
	if (!status || status.run !== "DONE" || status.chunkCount === 0) {
		result.skippedUnparsed += 1;
		return;
	}
	const chunks = await client.listChunks(datasetId, documentId);
	if (chunks.length === 0) {
		result.skippedUnparsed += 1;
		return;
	}
	for (const chunk of chunks) {
		if (sameKeywords(chunk.important_keywords, tags)) continue;
		await client.updateChunkKeywords(
			datasetId,
			documentId,
			chunk.id,
			tags,
			chunk.content
		);
		result.chunksWritten += 1;
	}
	result.tagged += 1;
}

/**
 * The tags for a target: a markdown note's own `tags` frontmatter, or — for a
 * non-markdown document — the `tags` of the companion note that links to it,
 * resolved through the same companion index the upload path uses.
 */
async function resolveTags(
	vault: VaultAccess,
	companionIndex: CompanionIndex,
	target: TagTarget
): Promise<string[]> {
	const file = vault.getFile(target.vaultPath);
	if (!file) return [];
	if (file.extension.toLowerCase() === "md") {
		const fm = await vault.frontmatter(file);
		return noteTags(fm?.["tags"]);
	}
	const sourceFolder = target.mapping?.companionSourceFolder;
	if (!sourceFolder) return [];
	const companion = lookupCompanion(companionIndex, sourceFolder, file);
	return companion ? noteTags(companion["tags"]) : [];
}

/** Order-insensitive equality of two keyword lists. */
function sameKeywords(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sa = [...a].sort();
	const sb = [...b].sort();
	return sa.every((v, i) => v === sb[i]);
}
