import { requestUrl, RequestUrlParam } from "obsidian";
import { buildMultipart } from "./multipart";
import {
	RagflowChunk,
	RagflowDataset,
	RagflowDocument,
	RagflowSyncSettings,
} from "./types";

/**
 * The raw chunk shape RAGFlow returns, normalized by normalizeChunk. Field names
 * have drifted across RAGFlow versions (`id`/`chunk_id`,
 * `content`/`content_with_weight`, `important_keywords`/`important_kwd`), so each
 * is accepted defensively.
 */
interface RawChunk {
	id?: string;
	chunk_id?: string;
	content?: string;
	content_with_weight?: string;
	important_keywords?: string[];
	important_kwd?: string[];
}

/** Map a version-variant raw chunk into the stable RagflowChunk shape. */
export function normalizeChunk(raw: RawChunk): RagflowChunk {
	return {
		id: raw.id ?? raw.chunk_id ?? "",
		content: raw.content ?? raw.content_with_weight ?? "",
		important_keywords: raw.important_keywords ?? raw.important_kwd ?? [],
	};
}

// RAGFlow's list endpoints cap page_size; 100 is safe across datasets/documents.
const PAGE_SIZE = 100;

/**
 * Whether `candidate` is `baseName` or a RAGFlow duplicate-suffixed variant of
 * it: `stem.ext`, `stem(1).ext`, `stem(2).ext`, … RAGFlow appends a "(n)" suffix
 * to a same-named upload instead of replacing it, so this finds the existing
 * copies to remove before a re-upload.
 *
 * The "(n)" group is purely numeric, so uploading `report.md` deliberately also
 * matches `report(2024).md` — an accepted trade-off for cleaning up the suffix
 * duplicates without a per-file allowlist.
 */
export function isDuplicateName(candidate: string, baseName: string): boolean {
	const dot = baseName.lastIndexOf(".");
	const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
	const ext = dot > 0 ? baseName.slice(dot) : "";
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${esc(stem)}(\\(\\d+\\))?${esc(ext)}$`).test(candidate);
}

export class RagflowClient {
	private getSettings: () => RagflowSyncSettings;
	/** All datasets, listed once per client lifetime. */
	private datasetsCache: RagflowDataset[] | null = null;
	/** dataset name -> id, resolved/created within a sync run. */
	private datasetIdByName: Map<string, string> = new Map();

	constructor(getSettings: () => RagflowSyncSettings) {
		this.getSettings = getSettings;
	}

	/**
	 * Drop the cached dataset list and name->id map. The client lives for the
	 * whole plugin session, so this must be called when the connection settings
	 * (base URL / API key) change — otherwise a later list or a "Test connection"
	 * would answer from a cache built against the old server.
	 */
	invalidate(): void {
		this.datasetsCache = null;
		this.datasetIdByName.clear();
	}

	private base(): string {
		const url = this.getSettings().ragflowBaseUrl.replace(/\/+$/, "");
		return `${url}/api/v1`;
	}

	private headers(extra?: Record<string, string>): Record<string, string> {
		return {
			Authorization: `Bearer ${this.getSettings().apiKey}`,
			...extra,
		};
	}

	private async send<T = unknown>(param: RequestUrlParam): Promise<T> {
		const resp = await requestUrl({ ...param, throw: false });
		let payload: { code?: number; message?: string; data?: T } | undefined;
		try {
			payload = resp.json;
		} catch (_e) {
			payload = undefined;
		}
		if (resp.status < 200 || resp.status >= 300) {
			const msg = payload?.message ?? resp.text ?? `HTTP ${resp.status}`;
			throw new Error(`RAGFlow error (${resp.status}): ${msg}`);
		}
		if (payload && payload.code !== undefined && payload.code !== 0) {
			throw new Error(`RAGFlow error: ${payload.message ?? "unknown error"}`);
		}
		return (payload?.data ?? (payload as unknown)) as T;
	}

	private query(params: Record<string, string | number | boolean | undefined>): string {
		const parts: string[] = [];
		for (const [k, v] of Object.entries(params)) {
			if (v === undefined) continue;
			parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
		}
		return parts.length ? `?${parts.join("&")}` : "";
	}

	/**
	 * List every dataset, paginating fully. Memoized for the client's lifetime;
	 * invalidated by this client's own dataset creates. Also used by the settings
	 * tab to verify the connection (acts as a lightweight ping).
	 */
	async listDatasets(): Promise<RagflowDataset[]> {
		if (this.datasetsCache) return this.datasetsCache;

		const all: RagflowDataset[] = [];
		let page = 1;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const data = await this.send<RagflowDataset[]>({
				url: `${this.base()}/datasets${this.query({
					page,
					page_size: PAGE_SIZE,
				})}`,
				method: "GET",
				headers: this.headers(),
			});
			const items = data ?? [];
			all.push(...items);
			if (items.length < PAGE_SIZE) break;
			page += 1;
		}
		this.datasetsCache = all;
		return all;
	}

	/** Every dataset name, sorted, for the settings dataset picker. */
	async listAllDatasetNames(): Promise<string[]> {
		const datasets = await this.listDatasets();
		return datasets
			.map((d) => d.name)
			.sort((a, b) => a.localeCompare(b));
	}

	async createDataset(name: string): Promise<RagflowDataset> {
		const dataset = await this.send<RagflowDataset>({
			url: `${this.base()}/datasets`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ name }),
		});
		// Keep the cache coherent so a later lookup sees the new dataset.
		if (this.datasetsCache) this.datasetsCache.push(dataset);
		return dataset;
	}

	/**
	 * Resolve a dataset id by name, creating the dataset if it does not exist.
	 * Memoized per name within the client's lifetime.
	 */
	async ensureDatasetId(name: string): Promise<string> {
		const trimmed = name.trim();
		if (!trimmed) {
			throw new Error("Mapping is missing a target dataset name.");
		}
		const cached = this.datasetIdByName.get(trimmed);
		if (cached) return cached;

		const datasets = await this.listDatasets();
		const existing = datasets.find((d) => d.name === trimmed);
		if (existing) {
			this.datasetIdByName.set(trimmed, existing.id);
			return existing.id;
		}

		try {
			const created = await this.createDataset(trimmed);
			this.datasetIdByName.set(trimmed, created.id);
			return created.id;
		} catch (e) {
			// Self-heal a race/duplicate: the dataset may have appeared since we
			// listed. Re-list fresh and adopt it; only rethrow if truly absent.
			this.datasetsCache = null;
			const refreshed = await this.listDatasets();
			const found = refreshed.find((d) => d.name === trimmed);
			if (!found) throw e;
			this.datasetIdByName.set(trimmed, found.id);
			return found.id;
		}
	}

	/**
	 * Ids of documents in a dataset whose name collides with `name` — the name
	 * itself plus any RAGFlow "(n)" duplicate of it (see isDuplicateName). Used to
	 * clear existing copies before a re-upload so the new file replaces them
	 * instead of being auto-suffixed. Narrowed server-side by keyword on the stem,
	 * then matched exactly client-side; paginates fully.
	 */
	async findDuplicateDocumentIds(
		datasetId: string,
		name: string
	): Promise<string[]> {
		const dot = name.lastIndexOf(".");
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ids: string[] = [];
		let page = 1;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const data = await this.send<{ docs?: RagflowDocument[] }>({
				url: `${this.base()}/datasets/${datasetId}/documents${this.query({
					keywords: stem,
					page,
					page_size: PAGE_SIZE,
				})}`,
				method: "GET",
				headers: this.headers(),
			});
			const docs = data?.docs ?? [];
			for (const d of docs) {
				if (d.id && isDuplicateName(d.name, name)) ids.push(d.id);
			}
			if (docs.length < PAGE_SIZE) break;
			page += 1;
		}
		return ids;
	}

	/**
	 * Upload one document into a dataset. RAGFlow returns the created document(s);
	 * the first one's id is what we track and later attach metadata to.
	 */
	async uploadDocument(
		datasetId: string,
		fileName: string,
		bytes: ArrayBuffer,
		contentType?: string
	): Promise<RagflowDocument> {
		const { body, contentType: ct } = buildMultipart({}, [
			{ field: "file", filename: fileName, data: bytes, contentType },
		]);
		const data = await this.send<RagflowDocument | RagflowDocument[]>({
			url: `${this.base()}/datasets/${datasetId}/documents`,
			method: "POST",
			headers: this.headers({ "Content-Type": ct }),
			body,
		});
		const doc = Array.isArray(data) ? data[0] : data;
		if (!doc || !doc.id) {
			throw new Error(`Upload of "${fileName}" returned no document id.`);
		}
		return doc;
	}

	/**
	 * Set a document's metadata (the RAGFlow "meta_fields" on Update document).
	 * Replaces the document's metadata wholesale with the provided fields.
	 */
	async setDocumentMetadata(
		datasetId: string,
		documentId: string,
		meta: Record<string, unknown>
	): Promise<void> {
		await this.send({
			url: `${this.base()}/datasets/${datasetId}/documents/${documentId}`,
			method: "PUT",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ meta_fields: meta }),
		});
	}

	/**
	 * Start parsing the given documents in a dataset (RAGFlow "Parse documents":
	 * POST /datasets/{id}/chunks). RAGFlow uses the dataset's own configured
	 * chunking method; parsing then runs asynchronously on the server. Returns as
	 * soon as the job is accepted, not when parsing completes.
	 */
	async parseDocuments(datasetId: string, ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.send({
			url: `${this.base()}/datasets/${datasetId}/chunks`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ document_ids: ids }),
		});
	}

	/**
	 * Parse status and chunk count of a single document, read from the dataset's
	 * document list filtered by id. Returns undefined when the document is no
	 * longer in the dataset. Used by the tag-application run to decide whether a
	 * document is parsed (run === "DONE", chunk_count > 0) before tagging.
	 */
	async getDocumentStatus(
		datasetId: string,
		documentId: string
	): Promise<{ run?: string; chunkCount: number } | undefined> {
		const data = await this.send<{ docs?: RagflowDocument[] }>({
			url: `${this.base()}/datasets/${datasetId}/documents${this.query({
				id: documentId,
				page: 1,
				page_size: 1,
			})}`,
			method: "GET",
			headers: this.headers(),
		});
		const doc = data?.docs?.[0];
		if (!doc) return undefined;
		return { run: doc.run, chunkCount: doc.chunk_count ?? 0 };
	}

	/**
	 * Every chunk of a parsed document, paginating fully. Chunks only exist after
	 * parsing completes; an unparsed document returns an empty list. Normalized to
	 * RagflowChunk so callers see a stable shape across RAGFlow versions.
	 */
	async listChunks(
		datasetId: string,
		documentId: string
	): Promise<RagflowChunk[]> {
		const all: RagflowChunk[] = [];
		let page = 1;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const data = await this.send<{ chunks?: RawChunk[] }>({
				url: `${this.base()}/datasets/${datasetId}/documents/${documentId}/chunks${this.query(
					{ page, page_size: PAGE_SIZE }
				)}`,
				method: "GET",
				headers: this.headers(),
			});
			const chunks = data?.chunks ?? [];
			for (const c of chunks) all.push(normalizeChunk(c));
			if (chunks.length < PAGE_SIZE) break;
			page += 1;
		}
		return all;
	}

	/**
	 * Replace one chunk's important_keywords. The chunk's content is echoed back
	 * unchanged because RAGFlow's Update-chunk endpoint can require it alongside
	 * the keywords; sending the same content is a no-op for the body but keeps the
	 * call valid across versions.
	 */
	async updateChunkKeywords(
		datasetId: string,
		documentId: string,
		chunkId: string,
		keywords: string[],
		content: string
	): Promise<void> {
		await this.send({
			url: `${this.base()}/datasets/${datasetId}/documents/${documentId}/chunks/${chunkId}`,
			method: "PUT",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ content, important_keywords: keywords }),
		});
	}

	async deleteDocuments(datasetId: string, ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.send({
			url: `${this.base()}/datasets/${datasetId}/documents`,
			method: "DELETE",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ ids }),
		});
	}
}
