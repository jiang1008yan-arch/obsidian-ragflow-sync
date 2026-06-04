import { requestUrl, RequestUrlParam } from "obsidian";
import { buildMultipart } from "./multipart";
import { RagflowFileNode, RagflowSyncSettings } from "./types";

// RAGFlow's File API caps page_size at 100; larger values are rejected.
const PAGE_SIZE = 100;

export class RagflowClient {
	private getSettings: () => RagflowSyncSettings;
	private rootId: string | null = null;
	/** parentId -> children listing, cached within a sync run. */
	private childrenCache: Map<string, RagflowFileNode[]> = new Map();

	constructor(getSettings: () => RagflowSyncSettings) {
		this.getSettings = getSettings;
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

	/** Resolve and cache the tenant root folder id. */
	async getRoot(): Promise<{ rootId: string; children: RagflowFileNode[] }> {
		const data = await this.send<{
			files: RagflowFileNode[];
			parent_folder: RagflowFileNode;
		}>({
			url: `${this.base()}/files${this.query({ page_size: PAGE_SIZE })}`,
			method: "GET",
			headers: this.headers(),
		});
		this.rootId = data.parent_folder?.id ?? null;
		if (!this.rootId) {
			throw new Error("Could not resolve RAGFlow root folder id.");
		}
		return { rootId: this.rootId, children: data.files ?? [] };
	}

	private async ensureRootId(): Promise<string> {
		if (this.rootId) return this.rootId;
		const { rootId } = await this.getRoot();
		return rootId;
	}

	/**
	 * List all children of a folder, paginating fully. parentId omitted => root.
	 * Memoized for the client's lifetime; invalidated by this client's own
	 * writes (createFolder/uploadFile/deleteFiles/move). Internal: callers use
	 * ensureFolderPath, which hides the cache entirely.
	 */
	private async listFolder(parentId?: string): Promise<RagflowFileNode[]> {
		const key = parentId ?? "__root__";
		const cached = this.childrenCache.get(key);
		if (cached) return cached;

		const all: RagflowFileNode[] = [];
		let page = 1;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const data = await this.send<{ total: number; files: RagflowFileNode[] }>({
				url: `${this.base()}/files${this.query({
					parent_id: parentId,
					page,
					page_size: PAGE_SIZE,
				})}`,
				method: "GET",
				headers: this.headers(),
			});
			const files = data.files ?? [];
			all.push(...files);
			if (files.length < PAGE_SIZE) break;
			page += 1;
		}
		this.childrenCache.set(key, all);
		return all;
	}

	async createFolder(name: string, parentId?: string): Promise<RagflowFileNode> {
		const node = await this.send<RagflowFileNode>({
			url: `${this.base()}/files`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ name, parent_id: parentId, type: "folder" }),
		});
		// Invalidate parent cache so the new folder is visible next listing.
		this.childrenCache.delete(parentId ?? "__root__");
		return node;
	}

	/**
	 * Ensure a nested folder path exists under root (or baseParentId), creating
	 * missing segments. Returns the id of the deepest folder.
	 */
	async ensureFolderPath(segments: string[], baseParentId?: string): Promise<string> {
		let parentId = baseParentId ?? (await this.ensureRootId());
		for (const segment of segments) {
			if (!segment) continue;
			const children = await this.listFolder(parentId);
			const existing = children.find(
				(c) => c.type === "folder" && c.name === segment
			);
			if (existing) {
				parentId = existing.id;
				continue;
			}
			try {
				const created = await this.createFolder(segment, parentId);
				parentId = created.id;
			} catch (e) {
				// Self-heal a stale "not found": the folder may already exist
				// (cache drift or a concurrent create). Re-list fresh and adopt
				// it; only rethrow if it genuinely isn't there.
				this.childrenCache.delete(parentId);
				const refreshed = await this.listFolder(parentId);
				const found = refreshed.find(
					(c) => c.type === "folder" && c.name === segment
				);
				if (!found) throw e;
				parentId = found.id;
			}
		}
		return parentId;
	}

	async uploadFile(
		parentId: string,
		fileName: string,
		bytes: ArrayBuffer,
		contentType?: string
	): Promise<RagflowFileNode> {
		const { body, contentType: ct } = buildMultipart(
			{ parent_id: parentId },
			[{ field: "file", filename: fileName, data: bytes, contentType }]
		);
		const data = await this.send<RagflowFileNode | RagflowFileNode[]>({
			url: `${this.base()}/files`,
			method: "POST",
			headers: this.headers({ "Content-Type": ct }),
			body,
		});
		this.childrenCache.delete(parentId);
		const node = Array.isArray(data) ? data[0] : data;
		if (!node || !node.id) {
			throw new Error(`Upload of "${fileName}" returned no file id.`);
		}
		return node;
	}

	async deleteFiles(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.send({
			url: `${this.base()}/files`,
			method: "DELETE",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ ids }),
		});
		this.childrenCache.clear();
	}

	async moveOrRename(
		srcFileIds: string[],
		destFolderId?: string,
		newName?: string
	): Promise<void> {
		await this.send({
			url: `${this.base()}/files/move`,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({
				src_file_ids: srcFileIds,
				dest_file_id: destFolderId,
				new_name: newName,
			}),
		});
		this.childrenCache.clear();
	}
}
