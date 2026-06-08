export interface DatasetMapping {
	/** Vault folder path (relative to vault root, no leading slash). */
	vaultPath: string;
	/** Target RAGFlow dataset (knowledge base) name; created on sync if missing. */
	datasetName: string;
}

export interface RagflowSyncSettings {
	ragflowBaseUrl: string;
	apiKey: string;
	datasetMappings: DatasetMapping[];
	/** Allowed file extensions without dot, lowercase. */
	extensions: string[];
	/** Glob-ish path fragments to exclude (substring match on vault path). */
	excludeGlobs: string[];
	/**
	 * When true, Markdown uploads have their [[wikilinks]]/![[embeds]] rewritten
	 * to plain text/standard Markdown and a "Related notes" section appended. The
	 * vault files themselves are never modified.
	 */
	internalizeLinks: boolean;
	/** Persisted local sync state. */
	state: SyncState;
}

export interface SyncedFileRecord {
	/** RAGFlow document id within the owning dataset. */
	documentId: string;
	/** RAGFlow dataset (knowledge base) id the document lives in. */
	datasetId: string;
	hash: string;
	size: number;
	mtime: number;
	lastSyncedAt: number;
	/**
	 * Version of the plugin's upload transform that produced this document.
	 * When the current transform version is newer, the file is re-uploaded even
	 * if its source content is unchanged. Absent on records written before
	 * versioning existed, which forces a one-time re-sync.
	 */
	processingVersion?: number;
}

export interface SyncState {
	/** vault file path -> synced record */
	files: Record<string, SyncedFileRecord>;
}

export type ChangeKind = "new" | "modified" | "deleted" | "unchanged";

export interface FileChange {
	kind: ChangeKind;
	/** Vault path (for deleted, this is the path that no longer exists). */
	vaultPath: string;
	/** Owning mapping; absent for deletions whose mapping was removed. */
	mapping?: DatasetMapping;
	/** Existing record (present for modified/deleted/unchanged). */
	record?: SyncedFileRecord;
	/** Freshly computed content hash (present for modified/unchanged-by-hash). */
	hash?: string;
	size?: number;
	mtime?: number;
}

export interface DiffResult {
	changes: FileChange[];
	/** Mappings whose vaultPath does not exist in the vault. */
	missingMappings: DatasetMapping[];
}

/** An unfiltered point-in-time entry from the vault snapshot. */
export interface VaultEntry {
	path: string;
	size: number;
	mtime: number;
}

/** Everything the Diff needs to decide what is in-scope and who owns it. */
export interface ScopeConfig {
	mappings: DatasetMapping[];
	/** Lowercase extensions without dots. */
	extensions: string[];
	excludeGlobs: string[];
	/**
	 * Current upload-transform version. A synced record whose processingVersion
	 * differs is re-uploaded regardless of content. Omitted in pure-diff tests
	 * that don't exercise versioning.
	 */
	processingVersion?: number;
}

/** A synced file that must be hashed to decide modified-vs-unchanged. */
export interface PendingHash {
	entry: VaultEntry;
	record: SyncedFileRecord;
	mapping: DatasetMapping;
}

/** Phase-1 (stat-only) classification of a snapshot against synced state. */
export interface StatClassification {
	news: { entry: VaultEntry; mapping: DatasetMapping }[];
	unchanged: { entry: VaultEntry; record: SyncedFileRecord; mapping: DatasetMapping }[];
	needHash: PendingHash[];
	deletions: { vaultPath: string; record: SyncedFileRecord; mapping?: DatasetMapping }[];
	/** Synced files whose processingVersion is stale: re-upload regardless of content. */
	reprocess: { entry: VaultEntry; record: SyncedFileRecord; mapping: DatasetMapping }[];
}

/** A synced-state record whose stats drifted but whose content is unchanged. */
export interface TouchRefresh {
	vaultPath: string;
	record: SyncedFileRecord;
	size: number;
	mtime: number;
}

/** Phase-2 result: hash pass over the needHash set. */
export interface HashClassification {
	modified: FileChange[];
	unchanged: FileChange[];
	touches: TouchRefresh[];
}

/** Outgoing wikilink targets and incoming backlinks for a note, as titles. */
export interface RelatedLinks {
	/** Titles of notes this note links to. */
	outgoing: string[];
	/** Titles of notes that link to this note. */
	incoming: string[];
}

/** A dataset (knowledge base) as returned by the RAGFlow Dataset API. */
export interface RagflowDataset {
	id: string;
	name: string;
	document_count?: number;
	create_time?: number;
	update_time?: number;
}

/** A document inside a dataset as returned by the RAGFlow Document API. */
export interface RagflowDocument {
	id: string;
	name: string;
	dataset_id?: string;
	size?: number;
	type?: string;
	run?: string;
	create_time?: number;
	update_time?: number;
}
