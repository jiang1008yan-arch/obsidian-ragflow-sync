export interface DatasetMapping {
	/** Vault folder path (relative to vault root, no leading slash). */
	vaultPath: string;
	/** Target RAGFlow dataset (knowledge base) name; created on sync if missing. */
	datasetName: string;
	/**
	 * Optional vault folder holding "metadata notes" for this mapping. A file
	 * under the mapping that has no metadata of its own (chiefly an attachment
	 * like a PDF) inherits the frontmatter of a note in this folder whose
	 * frontmatter links to it (e.g. a note with `file: "[[report.pdf]]"` supplies
	 * metadata for report.pdf), set as the document's RAGFlow metadata. Pairing is
	 * by the explicit frontmatter link, not by filename, so names need not match.
	 * A document split into page-range parts (`<stem>_p1-90`, `<stem>_p91-180`,
	 * …) needs only one note linking to the whole document (`[[<stem>]]`): each
	 * part falls back to its stem and inherits the same metadata.
	 * Empty/undefined disables companion metadata for the mapping.
	 */
	companionSourceFolder?: string;
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
	 * Vault paths the user has snoozed from the Scan diff list, each with a
	 * snapshot of the file taken when it was ignored. An ignored entry is still
	 * shown (with an "Ignored" badge) but excluded from "Sync all"; it re-surfaces
	 * as a normal change once the file drifts from its snapshot. See IgnoreSnapshot.
	 * Distinct from excludeGlobs (which removes a file from scope entirely).
	 */
	ignoredEntries: Record<string, IgnoreSnapshot>;
	/**
	 * When true, Markdown uploads have their [[wikilinks]]/![[embeds]] rewritten
	 * to plain text/standard Markdown and a "Related notes" section appended. The
	 * vault files themselves are never modified.
	 */
	internalizeLinks: boolean;
	/**
	 * When true, GFM ("|") tables in Markdown uploads are rewritten to clean
	 * border-style Markdown (interior pipes escaped, columns padded, blank lines
	 * ensured) so RAGFlow's chunker detects and aligns them instead of
	 * mis-splitting columns. The vault files themselves are never modified.
	 */
	normalizeTables: boolean;
	/**
	 * When true, every document uploaded during a sync is queued for parsing in
	 * RAGFlow right after the upload batch, using each dataset's own configured
	 * chunking method. When false, uploaded documents are left unparsed for the
	 * user to parse in RAGFlow manually.
	 */
	autoParse: boolean;
	/** Persisted local sync state. */
	state: SyncState;
}

/**
 * What an ignored ("snoozed") path looked like when the user ignored it. The
 * next Scan diff compares the file against this to decide whether it is still
 * the same — and so stays ignored — or has drifted and should re-surface as a
 * change.
 *
 * - `{ hash, size, mtime }` — the file was present when ignored; it stays
 *   ignored while its content hash still matches (size/mtime are the fast path).
 * - `{ deleted: true }` — the file was already gone when ignored; it stays
 *   ignored (shown as "Ignored", never deleted from RAGFlow) until a file
 *   reappears at the path.
 * - `{ pending: true }` — migrated from the legacy `ignoredPaths` list, which
 *   carried no snapshot; the engine fills in the real snapshot on the next scan.
 */
export type IgnoreSnapshot =
	| { hash: string; size: number; mtime: number }
	| { deleted: true }
	| { pending: true };

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
	/**
	 * Set when the document uploaded fine but the follow-up metadata call was
	 * rejected by RAGFlow. The next scan re-uploads the file to retry the
	 * metadata instead of treating it as unchanged; cleared on success.
	 */
	metaPending?: boolean;
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
	/**
	 * Set when this path is snoozed: still shown in Scan diff with an "Ignored"
	 * badge, but excluded from "Sync all". The underlying `kind` is preserved.
	 */
	ignored?: boolean;
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

/**
 * Result of applying the ignore snapshots to a freshly assembled change list.
 * The changes array is the same list with `ignored` flags set; the engine then
 * persists `staleIgnores` (drop them) and `captured` (write/refresh snapshots).
 */
export interface SnoozeResult {
	changes: FileChange[];
	/** Ignore entries to drop: the file changed or reappeared, so it re-surfaces. */
	staleIgnores: string[];
	/**
	 * Snapshots to write: a `pending` entry resolved to a real snapshot, or a
	 * still-ignored file whose stats drifted but content matched (stat refresh).
	 */
	captured: Record<string, IgnoreSnapshot>;
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
