import { isDuplicateName, RagflowClient } from "./ragflowClient";

/**
 * A per-dataset name -> document-ids index, listed once and kept current for
 * the rest of a Sync apply run.
 *
 * Replacing by name needs to know which existing documents collide with the
 * file about to be uploaded. Asking the server that per file costs a paginated
 * search each time — thousands of requests over a large sync, and a full
 * listing of the same dataset had usually just been fetched anyway. One listing
 * per dataset answers every collision question instead, so the index is updated
 * in place as documents are uploaded and deleted rather than re-fetched.
 */
export class DocumentIndex {
	private client: RagflowClient;
	/** datasetId -> (document name -> ids). Absent until that dataset is listed. */
	private byDataset = new Map<string, Map<string, string[]>>();

	constructor(client: RagflowClient) {
		this.client = client;
	}

	private async names(datasetId: string): Promise<Map<string, string[]>> {
		const cached = this.byDataset.get(datasetId);
		if (cached) return cached;

		const index = new Map<string, string[]>();
		for (const doc of await this.client.listDocuments(datasetId)) {
			if (!doc.id) continue;
			const ids = index.get(doc.name);
			if (ids) ids.push(doc.id);
			else index.set(doc.name, [doc.id]);
		}
		this.byDataset.set(datasetId, index);
		return index;
	}

	/**
	 * Ids to remove before uploading `name`: the name itself plus RAGFlow's
	 * "name(n).ext" variants of it.
	 *
	 * `protectedNames` are the filenames the vault actually holds for this
	 * dataset. A variant that is itself a real file — `report(2024).md` next to
	 * `report.md` — is a different document, not a duplicate, and deleting it
	 * would silently destroy it. Only the exact name being uploaded is removed
	 * despite being protected, since that is the one being replaced.
	 */
	async duplicateIds(
		datasetId: string,
		name: string,
		protectedNames: ReadonlySet<string>
	): Promise<string[]> {
		const index = await this.names(datasetId);
		const ids: string[] = [];
		for (const [candidate, candidateIds] of index) {
			if (!isDuplicateName(candidate, name)) continue;
			if (candidate !== name && protectedNames.has(candidate)) continue;
			ids.push(...candidateIds);
		}
		return ids;
	}

	/** Note a freshly uploaded document so later collisions see it. */
	record(datasetId: string, name: string, id: string): void {
		const index = this.byDataset.get(datasetId);
		if (!index) return; // Not listed yet; the eventual listing will include it.
		const ids = index.get(name);
		if (ids) ids.push(id);
		else index.set(name, [id]);
	}

	/** Drop deleted documents so they are not offered for deletion twice. */
	forget(datasetId: string, deleted: ReadonlySet<string>): void {
		const index = this.byDataset.get(datasetId);
		if (!index) return;
		for (const [name, ids] of index) {
			const kept = ids.filter((id) => !deleted.has(id));
			if (kept.length === 0) index.delete(name);
			else if (kept.length !== ids.length) index.set(name, kept);
		}
	}
}
