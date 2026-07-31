# RAGFlow Sync

An Obsidian plugin that one-way syncs vault files into RAGFlow datasets (knowledge bases), with a diff-preview step before any upload or deletion. Markdown frontmatter is stripped from the uploaded document and set as the document's RAGFlow metadata; the vault note is never modified.

The panel has two tabs over a single scan. **Scan diff** is a vault-folder tree showing only the three actionable states — New / Modified / Deleted — each as a right-side badge, with "Sync all" (applies every non-ignored change) and "Ignore selected". Up-to-date and ignored files are not listed. **Sync** is the same folder tree over every in-scope file (including up-to-date ones), with no badges, where "Sync selected" force-uploads any ticked file; it has no scan button and loads its list on first visit.

## Language

**Dataset mapping**:
A user-configured pair linking a vault folder to a target RAGFlow dataset (knowledge base), identified by name and created on sync if missing.
_Avoid_: route, binding, folder mapping.

**In-scope**:
Property of a vault file that is under a live dataset mapping's prefix, matches an allowed extension, and is not excluded — the set the plugin manages.
_Avoid_: included, tracked.

**Vault snapshot**:
An unfiltered point-in-time list of every vault file with its path, size, and mtime — the input the Diff consumes.
_Avoid_: file list, scan.

**Synced state**:
The last-known mapping of vault paths to RAGFlow document records (document id, dataset id, content hash, size, mtime), persisted between runs.
_Avoid_: cache, manifest, database.

**Diff**:
The pure classification of a vault snapshot against synced state into changes; runs in two phases — a stat-only pass, then a hash pass for the entries whose stats drifted.
_Avoid_: comparison, reconcile.

**Change kind**:
The category assigned to a vault path by the Diff: new, modified, deleted, or unchanged — plus `missing`, which only a **Remote reconcile** can produce.
_Avoid_: status, state, action.

**Remote reconcile**:
The comparison of what RAGFlow actually holds in each mapped dataset against the change list and the **Synced state**. Separate from the Diff and never run as part of a scan, because it costs a fully paginated document listing per dataset. It is the only read of RAGFlow's contents, and the only thing that can see remote-side drift.
_Avoid_: remote diff, verify, audit.

**Orphan**:
A RAGFlow document in a mapped dataset that no **Synced state** record points at and whose name matches no in-scope file routed to that dataset. Has no vault path, so it lives outside the change list and outside the folder tree. Deleted only by its own explicit action, never by "Sync all".
_Avoid_: stray, leftover, untracked document.

**Missing**:
The **Change kind** for a file that is unchanged locally but whose tracked document is absent from its dataset — deleted in the RAGFlow UI, stranded by a recreated dataset, or overwritten by a same-named upload. Applied as an upload with no prior document to delete.
_Avoid_: gone, lost, absent.

**Deletion rule**:
The single rule that any synced-state record whose path is not in the in-scope snapshot is a deletion — covering files that are gone, filtered out, or under a removed mapping (full unmirror).
_Avoid_: cleanup, prune.

**Touch refresh**:
An update to a synced-state record's size/mtime when its content hash is unchanged but its stats drifted, so the next Diff can take the fast path without re-hashing.
_Avoid_: bump, sync.

**Ignore (snooze)**:
A per-path snapshot (`ignoredEntries`) that hides a file from the Scan diff list: an ignored file is dropped from the New/Modified/Deleted view and excluded from "Sync all", but stays tracked. It re-surfaces as a normal Change kind the moment the file drifts from its snapshot (content hash differs) or a deleted-then-ignored path reappears. A snapshot is `{hash,size,mtime}` for a present file, `{deleted:true}` for one gone when ignored, or `{pending:true}` for one migrated from the old freeze list (filled on the next scan). Ignored files still appear (badge-free) in the Sync tab; manually uploading one there clears its snapshot. Applied after the Diff (`markIgnored`, which sets `ignored`), not inside classification.
_Avoid_: freeze, exclude, skip.

**Frontmatter metadata**:
The note's leading YAML block, parsed and removed from the uploaded document body, then set as the RAGFlow document's metadata (the Update-document `meta_fields`). The vault note keeps its frontmatter.
_Avoid_: properties, header.

**Sync apply run**:
One application of a set of non-unchanged **Change kind**s to RAGFlow and the **Synced state**. It owns the upload/delete lifecycle, replace-by-name behavior, **Frontmatter metadata** retry semantics, auto-parse queue, progress labels, periodic flushes, and per-file success/failure accounting.
_Avoid_: executor, runner, applicator.

**Vault access**:
The narrow interface to Obsidian vault and metadata-cache behavior used by the sync code: listing a **Vault snapshot**, reading file bytes, finding markdown notes, reading frontmatter, resolving wikilinks, and collecting related notes.
_Avoid_: app wrapper, obsidian helper.

**Companion metadata**:
The lookup that lets a metadata-less file inherit normalized **Frontmatter metadata** from a note in a **Dataset mapping**'s companion source folder when that note links to the file.
_Avoid_: attachment metadata, sidecar metadata.

**Settings migration**:
The normalization of persisted plugin data into the current `RagflowSyncSettings` shape, including legacy mapping fields, legacy file-management records, old companion metadata fields, and old ignored paths.
_Avoid_: load cleanup, settings fixup.

**Panel state**:
The pure state rules behind the Scan diff / Sync panel tabs: which **Change kind**s are visible, which changes "Sync all" applies, and how selected or forced uploads are promoted.
_Avoid_: view state, UI helper.

## Relationships

- A **Dataset mapping** defines part of what counts as **In-scope** and names the destination dataset.
- The **Diff** consumes a **Vault snapshot** and the **Synced state** and emits **Change kind**s. It never reads RAGFlow, so remote-side drift is structurally invisible to it — that is the **Remote reconcile**'s job.
- A **Remote reconcile** runs after the Diff, over its change list: it promotes `unchanged` entries to **Missing** and emits **Orphan**s alongside the change list. It also drops the **Ignore (snooze)** of anything it marks Missing, since a vault-side snooze cannot speak for a document that is gone.
- The **Deletion rule** is evaluated by the **Diff** against the in-scope subset of the **Vault snapshot**.
- A **Touch refresh** updates the **Synced state** without producing a visible **Change kind** (it stays "unchanged").
- An **Ignore (snooze)** is applied to the **Change kind**s after the **Diff** runs: it sets an `ignored` flag that drops the entry from the Scan diff list, while the **Deletion rule** still produces the underlying `deleted` kind beneath it.
- A Markdown file's **Frontmatter metadata** is uploaded separately from its body, via the metadata API, after the document upload.
- An upload **replaces by name**: before uploading, the engine deletes the tracked document (by id) *and* every same-named document in the dataset — including RAGFlow's `name(n).ext` duplicates — because RAGFlow auto-suffixes a same-named upload instead of replacing it. This keeps one document per filename per dataset even when the local record was lost. Filenames must therefore be unique within a dataset.

- A **Sync apply run** consumes **Change kind**s produced by the **Diff** and mutates **Synced state** only after RAGFlow accepts the corresponding remote operation. If **Frontmatter metadata** fails after upload, the document remains in RAGFlow, is still queued for auto-parse, and the **Synced state** record is marked `metaPending` so the next **Diff** re-surfaces it.
- **Vault access** is the seam between Obsidian's runtime objects and the sync modules; tests can provide an in-memory adapter without knowing `app.vault` or `metadataCache`.
- **Companion metadata** is built once per **Sync apply run** from the configured companion source folders and then queried for metadata-less uploads.
- **Settings migration** runs after plugin data is loaded and before the plugin creates its RAGFlow client, **Synced state** store, and sync modules.
- **Panel state** is consumed by the panel view so tab visibility and forced-upload rules can be tested without DOM rendering.

## Example dialogue

> **Dev:** "If I delete a dataset mapping, do its files become 'unchanged' or 'deleted'?"
> **Maintainer:** "Deleted. The **Deletion rule** is one line — not in the in-scope snapshot means deleted, and a removed mapping takes its files out of scope. That's the full-unmirror behavior."
> **Dev:** "And if I just touch a file without editing it?"
> **Maintainer:** "Stats drift, so it lands in the hash pass. Hash matches, so it's 'unchanged' for the panel, but we write a **Touch refresh** so the next **Diff** skips re-hashing it."
> **Dev:** "If I ignore a deleted entry, does it disappear from Scan diff?"
> **Maintainer:** "Yes — **Ignore (snooze)** hides it from the New/Modified/Deleted list and leaves it out of 'Sync all', so the RAGFlow document is kept. It's still tracked, and only re-surfaces if a file reappears at that path. The file remains pickable (badge-free) in the Sync tab."
> **Dev:** "The dataset has more documents than the vault has files, but Scan diff shows nothing. Bug?"
> **Maintainer:** "No — by construction. The **Diff** only ever compares the **Vault snapshot** with the **Synced state**; a document we never recorded doesn't exist as far as it's concerned. Run a **Remote reconcile** and it comes back as an **Orphan**."

## Flagged ambiguities

- "state" was overloaded: the persisted **Synced state** vs. a file's **Change kind**. Resolved — distinct concepts; never call a change kind a "state".
