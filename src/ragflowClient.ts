import { requestUrl, RequestUrlParam } from "obsidian";
import { buildMultipart } from "./multipart";
import { RagflowDataset, RagflowDocument, RagflowSyncSettings } from "./types";

// RAGFlow's list endpoints cap page_size; 100 is safe across datasets/documents.
const PAGE_SIZE = 100;

/**
 * Whether `candidate` is `baseName` or a RAGFlow duplicate-suffixed variant of
 * it: `stem.ext`, `stem(1).ext`, `stem(2).ext`, … RAGFlow appends a "(n)" suffix
 * to a same-named upload instead of replacing it, so this finds the existing
 * copies to remove before a re-upload.
 *
 * The "(n)" group is purely numeric, so `report(2024).md` also matches
 * `report.md` by this predicate alone. That is not enough to act on: DocumentIndex
 * checks candidates against the filenames the vault actually holds and refuses to
 * delete one that is a real file, so a legitimate `report(2024).md` survives while
 * a genuine `report(1).md` leftover does not.
 */
export function isDuplicateName(candidate: string, baseName: string): boolean {
	const dot = baseName.lastIndexOf(".");
	const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
	const ext = dot > 0 ? baseName.slice(dot) : "";
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${esc(stem)}(\\(\\d+\\))?${esc(ext)}$`).test(candidate);
}

/**
 * A RAGFlow API failure that carries the HTTP status. Callers need it to tell
 * "the thing you asked me to remove is already gone" (404) from a failure that
 * left the server unchanged — the two call for opposite local bookkeeping.
 */
export class RagflowError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "RagflowError";
		this.status = status;
	}
}

/** Whether an error means the target does not exist on the server. */
export function isNotFound(error: unknown): boolean {
	return error instanceof RagflowError && error.status === 404;
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
			throw new RagflowError(`RAGFlow error (${resp.status}): ${msg}`, resp.status);
		}
		if (payload && payload.code !== undefined && payload.code !== 0) {
			// RAGFlow also reports "not found" as a 200 with a non-zero code, so
			// recognise it here too rather than only on the HTTP status.
			const msg = payload.message ?? "unknown error";
			throw new RagflowError(
				`RAGFlow error: ${msg}`,
				/not\s*found|does\s*not\s*exist/i.test(msg) ? 404 : undefined
			);
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
	 * Resolve a dataset id by name *without* creating it. Returns undefined when
	 * no such dataset exists — the Remote reconcile needs to look at what RAGFlow
	 * actually holds, and must not conjure an empty dataset just by asking.
	 */
	async findDatasetId(name: string): Promise<string | undefined> {
		const trimmed = name.trim();
		if (!trimmed) return undefined;
		const cached = this.datasetIdByName.get(trimmed);
		if (cached) return cached;

		const found = (await this.listDatasets()).find((d) => d.name === trimmed);
		if (!found) return undefined;
		this.datasetIdByName.set(trimmed, found.id);
		return found.id;
	}

	/**
	 * Every document in a dataset, paginating fully. This is the only call that
	 * reads RAGFlow's actual contents wholesale; it backs the Remote reconcile,
	 * which is why it is deliberately not on the ordinary scan path (a dataset of
	 * N documents costs ceil(N/100) requests).
	 */
	async listDocuments(datasetId: string): Promise<RagflowDocument[]> {
		const all: RagflowDocument[] = [];
		let page = 1;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const data = await this.send<{ docs?: RagflowDocument[] }>({
				url: `${this.base()}/datasets/${datasetId}/documents${this.query({
					page,
					page_size: PAGE_SIZE,
				})}`,
				method: "GET",
				headers: this.headers(),
			});
			const docs = data?.docs ?? [];
			all.push(...docs);
			if (docs.length < PAGE_SIZE) break;
			page += 1;
		}
		return all;
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
