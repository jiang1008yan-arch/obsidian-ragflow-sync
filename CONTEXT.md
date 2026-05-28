# RAGFlow Sync

An Obsidian plugin that one-way syncs vault files into RAGFlow File Management, preserving folder structure, with a diff-preview step before any upload or deletion.

## Language

**Folder mapping**:
A user-configured pair linking a vault folder to a target folder inside RAGFlow File Management.
_Avoid_: route, binding.

**In-scope**:
Property of a vault file that is under a live folder mapping's prefix, matches an allowed extension, and is not excluded — the set the plugin manages.
_Avoid_: included, tracked.

**Vault snapshot**:
An unfiltered point-in-time list of every vault file with its path, size, and mtime — the input the Diff consumes.
_Avoid_: file list, scan.

**Synced state**:
The last-known mapping of vault paths to RAGFlow file records (file id, parent folder id, content hash, size, mtime), persisted between runs.
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

**Placement**:
The RAGFlow folder path (as segments) a vault file maps to — its folder mapping's base folder followed by the file's sub-folders relative to the mapping.
_Avoid_: destination, target path.

## Relationships

- A **Folder mapping** defines part of what counts as **In-scope**.
- The **Diff** consumes a **Vault snapshot** and the **Synced state** and emits **Change kind**s.
- The **Deletion rule** is evaluated by the **Diff** against the in-scope subset of the **Vault snapshot**.
- A **Touch refresh** updates the **Synced state** without producing a visible **Change kind** (it stays "unchanged").
- A **Folder mapping** plus a file's sub-path determines its **Placement**.

## Example dialogue

> **Dev:** "If I delete a folder mapping, do its files become 'unchanged' or 'deleted'?"
> **Maintainer:** "Deleted. The **Deletion rule** is one line — not in the in-scope snapshot means deleted, and a removed mapping takes its files out of scope. That's the full-unmirror behavior."
> **Dev:** "And if I just touch a file without editing it?"
> **Maintainer:** "Stats drift, so it lands in the hash pass. Hash matches, so it's 'unchanged' for the panel, but we write a **Touch refresh** so the next **Diff** skips re-hashing it."

## Flagged ambiguities

- "state" was overloaded: the persisted **Synced state** vs. a file's **Change kind**. Resolved — distinct concepts; never call a change kind a "state".
