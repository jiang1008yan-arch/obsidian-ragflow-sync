# RAGFlow Sync

An Obsidian plugin that one-way syncs vault files into RAGFlow datasets (knowledge bases), with a diff-preview step before any upload or deletion. Markdown frontmatter is stripped from the uploaded document and set as the document's RAGFlow metadata; the vault note is never modified.

The panel has two tabs over a single scan. **Scan diff** is a vault-folder tree showing only files with a status — New / Modified / Deleted / Ignored — each as a right-side badge, with "Sync all" (applies every non-ignored change) and "Ignore selected". **Sync** is the same folder tree over every in-scope file (including up-to-date ones), with no badges, where "Sync selected" force-uploads any ticked file.

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
The category assigned to a vault path by the Diff: new, modified, deleted, or unchanged.
_Avoid_: status, state, action.

**Deletion rule**:
The single rule that any synced-state record whose path is not in the in-scope snapshot is a deletion — covering files that are gone, filtered out, or under a removed mapping (full unmirror).
_Avoid_: cleanup, prune.

**Touch refresh**:
An update to a synced-state record's size/mtime when its content hash is unchanged but its stats drifted, so the next Diff can take the fast path without re-hashing.
_Avoid_: bump, sync.

**Ignore (snooze)**:
A per-path snapshot (`ignoredEntries`) that hides a file's actionable status: the entry still shows in Scan diff with an "Ignored" badge but is excluded from "Sync all". It re-surfaces as a normal Change kind the moment the file drifts from its snapshot (content hash differs) or a deleted-then-ignored path reappears. A snapshot is `{hash,size,mtime}` for a present file, `{deleted:true}` for one gone when ignored, or `{pending:true}` for one migrated from the old freeze list (filled on the next scan). Manually uploading an ignored file clears its snapshot. Applied after the Diff (`markIgnored`), not inside classification.
_Avoid_: freeze, exclude, skip.

**Frontmatter metadata**:
The note's leading YAML block, parsed and removed from the uploaded document body, then set as the RAGFlow document's metadata (the Update-document `meta_fields`). The vault note keeps its frontmatter.
_Avoid_: properties, header.

## Relationships

- A **Dataset mapping** defines part of what counts as **In-scope** and names the destination dataset.
- The **Diff** consumes a **Vault snapshot** and the **Synced state** and emits **Change kind**s.
- The **Deletion rule** is evaluated by the **Diff** against the in-scope subset of the **Vault snapshot**.
- A **Touch refresh** updates the **Synced state** without producing a visible **Change kind** (it stays "unchanged").
- An **Ignore (snooze)** is applied to the **Change kind**s after the **Diff** runs: it sets an `ignored` flag rather than removing the entry, and the **Deletion rule** still produces the underlying `deleted` kind beneath it.
- A Markdown file's **Frontmatter metadata** is uploaded separately from its body, via the metadata API, after the document upload.

## Example dialogue

> **Dev:** "If I delete a dataset mapping, do its files become 'unchanged' or 'deleted'?"
> **Maintainer:** "Deleted. The **Deletion rule** is one line — not in the in-scope snapshot means deleted, and a removed mapping takes its files out of scope. That's the full-unmirror behavior."
> **Dev:** "And if I just touch a file without editing it?"
> **Maintainer:** "Stats drift, so it lands in the hash pass. Hash matches, so it's 'unchanged' for the panel, but we write a **Touch refresh** so the next **Diff** skips re-hashing it."
> **Dev:** "If I ignore a deleted entry, does it disappear?"
> **Maintainer:** "No — **Ignore (snooze)** relabels, it doesn't hide. It stays in Scan diff with an 'Ignored' badge and is left out of 'Sync all', so the RAGFlow document is kept. It only re-surfaces if a file reappears at that path."

## Flagged ambiguities

- "state" was overloaded: the persisted **Synced state** vs. a file's **Change kind**. Resolved — distinct concepts; never call a change kind a "state".
