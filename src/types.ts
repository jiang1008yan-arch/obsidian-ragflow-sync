export interface FolderMapping {
	/** Vault folder path (relative to vault root, no leading slash). */
	vaultPath: string;
	/** Target folder path inside RAGFlow File Management (under root). */
	ragflowBaseFolder: string;
}

export interface RagflowSyncSettings {
	ragflowBaseUrl: string;
	apiKey: string;
	folderMappings: FolderMapping[];
	/** Allowed file extensions without dot, lowercase. */
	extensions: string[];
	/** Glob-ish path fragments to exclude (substring match on vault path). */
	excludeGlobs: string[];
	/** Persisted local sync state. */
	state: SyncState;
}

export interface SyncedFileRecord {
	fileId: string;
	parentFolderId: string;
	hash: string;
	size: number;
	mtime: number;
	lastSyncedAt: number;
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
	mapping?: FolderMapping;
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
	missingMappings: FolderMapping[];
}

/** An unfiltered point-in-time entry from the vault snapshot. */
export interface VaultEntry {
	path: string;
	size: number;
	mtime: number;
}

/** Everything the Diff needs to decide what is in-scope and who owns it. */
export interface ScopeConfig {
	mappings: FolderMapping[];
	/** Lowercase extensions without dots. */
	extensions: string[];
	excludeGlobs: string[];
}

/** A synced file that must be hashed to decide modified-vs-unchanged. */
export interface PendingHash {
	entry: VaultEntry;
	record: SyncedFileRecord;
	mapping: FolderMapping;
}

/** Phase-1 (stat-only) classification of a snapshot against synced state. */
export interface StatClassification {
	news: { entry: VaultEntry; mapping: FolderMapping }[];
	unchanged: { entry: VaultEntry; record: SyncedFileRecord; mapping: FolderMapping }[];
	needHash: PendingHash[];
	deletions: { vaultPath: string; record: SyncedFileRecord; mapping?: FolderMapping }[];
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

/** A node returned by the RAGFlow File API list endpoint. */
export interface RagflowFileNode {
	id: string;
	name: string;
	type: string; // "folder" | "pdf" | "doc" | "visual" | ...
	size?: number;
	create_time?: number;
	update_time?: number;
	parent_id?: string;
}
