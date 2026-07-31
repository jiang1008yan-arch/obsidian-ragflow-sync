# RAGFlow Sync for Obsidian

Sync selected Obsidian vault folders directly into RAGFlow **datasets**
(knowledge bases). The plugin scans for differences before syncing, so you can
see which files are new, modified, deleted, or already up to date.

When a Markdown note is synced, its YAML frontmatter is stripped from the
uploaded document and set as the document's RAGFlow **metadata** instead — so
your tags, titles, and other properties become queryable metadata in RAGFlow
rather than noise in the document body. Your vault note is never modified.

## Features

- Upload Markdown, PDF, Word, PowerPoint, Excel, text, and image files straight
  into RAGFlow datasets (no File Management folder hops).
- Map one or more Obsidian folders to target RAGFlow datasets.
- Strip each note's frontmatter on upload and set it as document metadata via
  the RAGFlow metadata API; the original note stays unchanged.
- Scan differences before uploading or deleting anything, shown as an
  expandable vault-folder tree.
- Sync all changes, or tick specific files and folders and sync only those.
- Ignore specific files so they are never uploaded and never deleted — frozen,
  not removed from scope.
- Optionally auto-parse uploaded documents in RAGFlow with each dataset's own
  chunking method, right after the upload finishes.
- Track local file hashes to avoid re-uploading unchanged content.
- Optionally internalize Obsidian double links: rewrite `[[wikilinks]]` and
  `![[embeds]]` to plain text/standard Markdown and append a related-notes
  section (outgoing links and backlinks) so the link graph survives in RAGFlow.
- Optionally normalize Markdown tables on upload — escaping stray pipes (e.g.
  from `[[Note|alias]]` links), padding columns, and adding blank lines — so
  RAGFlow detects and aligns them instead of mis-splitting columns.

## Requirements

- Obsidian desktop app 1.4.0 or newer.
- A running RAGFlow instance.
- A RAGFlow API key that can access the Dataset API.

This plugin is desktop-only because it uses Obsidian desktop APIs for local file
access and network requests.

## Install (No Build Required)

Obsidian only needs three files in the plugin folder: `manifest.json`,
`main.js`, and `styles.css`. A prebuilt `main.js` is committed in this
repository, so you do not need Node.js or a build step.

1. Create the plugin folder in your vault:

   ```text
   <your-vault>/.obsidian/plugins/obsidian-ragflow-sync/
   ```

2. Copy these three files from this repository into that folder:

   - `manifest.json`
   - `main.js`
   - `styles.css`

3. Restart Obsidian (or reload it).

4. Open `Settings -> Community plugins`, turn off Safe mode if needed, then
   enable `RAGFlow Sync`.

> If Obsidian shows "Failed to load plugin", the most common cause is a
> missing `main.js` in the plugin folder — make sure all three files above
> are present and that the folder name matches the `id` in `manifest.json`.

## Install From Source

1. Open your vault's plugin folder:

   ```text
   <your-vault>/.obsidian/plugins/
   ```

2. Clone this repository into that folder:

   ```bash
   git clone https://github.com/jiang1008yan-arch/obsidian-ragflow-sync.git
   ```

3. Install dependencies and build the plugin:

   ```bash
   cd obsidian-ragflow-sync
   npm install
   npm run build
   ```

4. Restart Obsidian.

5. In Obsidian, open `Settings -> Community plugins`.

6. Turn off Safe mode if needed, then enable `RAGFlow Sync`.

## Configure The Plugin

Open `Settings -> RAGFlow Sync`.

### RAGFlow Connection

- `RAGFlow base URL`: the base address of your RAGFlow server, for example:

  ```text
  http://127.0.0.1:9380
  ```

  Do not add `/api/v1`; the plugin adds that automatically.

- `API key`: your RAGFlow API key. The plugin sends it as a Bearer token.

Click `Test` to verify that Obsidian can connect to RAGFlow and list its
datasets.

### Sync Scope

- `File extensions`: comma-separated extensions without dots.

  Default:

  ```text
  md,pdf,docx
  ```

  Example with more file types:

  ```text
  md,pdf,docx,pptx,txt,png,jpg
  ```

- `Exclude paths`: comma-separated path fragments. Any vault path containing one
  of these fragments is skipped.

  Default:

  ```text
  .trash,.obsidian
  ```

### Link Internalization

RAGFlow does not understand Obsidian's `[[wikilink]]` syntax, so by default the
links upload as raw `[[...]]` text. Turn on `Internalize Obsidian links` to make
synced Markdown self-describing:

- `[[Note]]` becomes its note title; `[[Note|alias]]` becomes the alias.
- `[[Note#Heading]]` becomes `Note > Heading`.
- `![[image.png]]` becomes a standard Markdown image; non-image embeds collapse
  to the note title.
- A `## Related notes` section is appended listing the note's outgoing
  `**Links:**` and incoming `**Backlinks:**` (other notes that link to it).

Your vault files are never modified — the rewrite happens only on the copy sent
to RAGFlow. Backlinks are resolved from Obsidian's link graph at sync time.

Note: change detection hashes the original file, so editing a note re-syncs it,
but a change to a *different* note's backlinks does not by itself mark this note
as modified. Re-sync that note (or sync all) to refresh its related section.

### Table Normalization

RAGFlow's Markdown chunker is fragile with pipe (`|`) tables: an unescaped pipe
— notably from an Obsidian `[[Note|alias]]` link inside a cell — shifts every
column, and tables without clean delimiter rows or surrounding blank lines get
sliced into the surrounding prose. With `Normalize tables for RAGFlow` on (the
default), each table is rewritten to clean border-style Markdown before upload:

- Cells are parsed with awareness of `[[ ]]`, inline `` `code` `` spans, and
  `\|` escapes, then re-emitted with any interior `|` escaped as `\|` so it can
  never split a column.
- Rows are padded/truncated to the header width, and a blank line is ensured
  before and after the table.
- Borderless tables are converted to border style; column alignment markers
  (`:---`, `---:`, `:---:`) are preserved.

This stays as Markdown — which RAGFlow's parser converts to a table itself and
renders as one chunk across all versions, rather than the raw HTML that older
RAGFlow builds display as literal tags. Tables inside fenced code blocks are
left untouched, and your vault files are never modified.

### Dataset Mappings

Dataset mappings decide what gets synced and which RAGFlow dataset it lands in.

Each mapping has two fields:

- `Vault folder`: a folder path inside your Obsidian vault.
- `RAGFlow dataset`: the name of the destination RAGFlow dataset (knowledge
  base).

Both fields autocomplete: click one to pick from existing entries. Vault folders
come from your vault; RAGFlow datasets are fetched after a successful
`Test connection` (open settings again if you just connected). You can still
type a dataset name that does not exist yet — it is created on the next sync.

Example:

```text
Vault folder:    Notes/Research
RAGFlow dataset: Research
```

With this mapping, every in-scope file under `Notes/Research` (including its
subfolders) is uploaded as a document into the `Research` dataset. Datasets are
flat, so subfolders are not mirrored — all matching notes become documents in
the same dataset. The plugin creates the dataset automatically if it does not
exist yet.

### Frontmatter As Metadata

For Markdown notes, the leading YAML frontmatter block is parsed and removed
before upload, then written to the document's RAGFlow metadata via the
update-document API once the upload completes. For example, a note starting
with:

```yaml
---
title: LLM Notes
tags: [ai, research]
status: draft
---
```

uploads with that block removed from the body, and the document gets RAGFlow
metadata `{ "title": "LLM Notes", "tags": ["ai", "research"], "status":
"draft" }`. The note in your vault is left exactly as-is. Editing the
frontmatter changes the file's content hash, so the note re-syncs and its
metadata is refreshed on the next sync.

Wikilinks inside frontmatter values are always cleaned to plain text before
they become metadata, so RAGFlow never stores raw `[[...]]` syntax. A
frontmatter value of `project: "[[Project A]]"` is sent as `"Project A"`, an
alias like `"[[B|the B note]]"` becomes `"the B note"`, and lists or nested
mappings are cleaned recursively. This applies unconditionally and is
independent of the body link-internalization option below.

#### Companion Metadata For Attachments

Attachments such as PDFs have no frontmatter of their own, so by default they
upload without any metadata. Each dataset mapping has a **Companion meta**
dropdown that closes that gap: pick a vault folder of "metadata notes", and a
metadata-less file under the mapping inherits the frontmatter of a note in that
folder **whose frontmatter links to it**.

Pairing is by the explicit `[[...]]` link, not by filename — so the note name
need not match the attachment, which matters when names differ or a note is
referenced from many places. The link is read straight from the frontmatter text
and matched against the attachment by resolved path, file name, and
extension-less base, so it resolves whether the link carries the extension
(`[[report.pdf]]`) or not (`[[report]]`). For example, with a mapping's Companion
meta folder set to `Index`, a note `Index/anything.md` containing:

```yaml
---
file: "[[report.pdf]]"
title: Quarterly Report
tags: [finance, 2025]
---
```

makes `report.pdf` upload with RAGFlow metadata `{ "file": "report.pdf",
"title": "Quarterly Report", "tags": ["finance", "2025"] }`. Leave the dropdown
on "Companion meta: off" to disable it for that mapping.

##### Split Documents Share One Note

RAGFlow's PaddleOCR pipeline caps OCR at roughly 200 pages and is slow on large
files, so an oversized PDF is best split into parts under ~100 pages. Name each
part `<stem>_p<start>-<end>` — for example, splitting `ADA-Standard_2010` gives
`ADA-Standard_2010_p1-90`, `ADA-Standard_2010_p91-180`, and
`ADA-Standard_2010_p181-255` (a lone-page `<stem>_p<n>` works too). A part with
no companion match of its own then falls back to its **stem**, so a single
metadata note linking to the whole document supplies every part with the same
properties:

```yaml
---
file: "[[ADA-Standard_2010]]"
title: ADA Accessibility Standard
year: 2010
---
```

All three parts upload with that identical metadata — no need to list each part.
You can still list parts explicitly (`file: ["[[..._p1-90]]", "[[..._p91-180]]"]`)
if you prefer; the stem fallback only kicks in when a part has no direct match.

This is deliberately separate from the always-on "a note's own frontmatter
becomes its own metadata" behavior above, so the two never mix:

- A file that already has its own metadata (a Markdown note with frontmatter)
  keeps the always-on behavior; the companion lookup is skipped for it.
- A file that no note in the source folder links to is uploaded without
  metadata — the dropdown simply does nothing for it.

The metadata notes are read only for their frontmatter links; they still upload
as their own documents in the usual way.

## Use The Plugin

There are three ways to open or run sync actions:

- Click the `RAGFlow Sync` ribbon icon.
- Run `RAGFlow Sync: Open sync panel` from the command palette.
- Run `RAGFlow Sync: Scan for differences`, `RAGFlow Sync: Sync all changes`, or
  `RAGFlow Sync: Reconcile with RAGFlow` from the command palette.

### Recommended Workflow

1. Open the `RAGFlow Sync` panel.

2. Click `Scan diff`.

3. Review the result. The diff is shown as your vault's folder tree: each folder
   can be expanded or collapsed, folders that contain changes are expanded for
   you, and each folder shows a short summary (e.g. `2 new, 1 modified`). Every
   file carries a badge:

   - `New`: files that exist locally but have not been uploaded yet.
   - `Modified`: files whose content changed since the last successful sync.
   - `Deleted`: files that were synced before but no longer exist locally.
   - `Up to date`: files that match the last synced state.
   - `Missing in RAGFlow`: files that look up to date locally but whose document
     is gone from the dataset. Only a `Reconcile` can find these (see below).

   Use `Expand all` / `Collapse all` to change how much of the tree is open.

4. Click `Sync all` to apply every change at once, or tick specific files and
   folders and click `Sync selected (N)` to act on just those (see below).

5. Wait for the final notice. The panel scans again after syncing so the latest
   state is visible.

### Re-syncing After A Plugin Update

The diff normally compares your notes' source content, so a note whose text has
not changed is left alone. But when a plugin update changes how documents are
*processed* on upload (for example, the metadata wikilink cleaning), the source
is identical yet the uploaded result should change. To handle this the plugin
tracks a processing version on every synced document: after an update that bumps
it, your already-synced notes show up as `Modified` on the next `Scan diff` and
re-upload once with the new processing — no manual action needed.

If you ever need to rebuild RAGFlow's copies without any change to trigger it
(for example you deleted some documents on the RAGFlow side, or a few were left
in a failed parsing state), use the checkboxes in the tree. Every row — folders
and files, including ones marked `Up to date` — has a checkbox; ticking a folder
selects every file beneath it, and a folder whose files are only partly selected
shows a dash. Tick what you want to rebuild, then click `Sync selected (N)`.
Selected `Up to date` files are re-uploaded as if modified; nothing else is
touched, so you rebuild only the documents you choose instead of re-uploading
the entire vault.

To rebuild *everything* regardless of the diff result, run
`RAGFlow Sync: Force re-sync all` from the command palette.

### When The Document Counts Do Not Match

`Scan diff` compares your vault against the plugin's **local** record of what it
uploaded. It never asks RAGFlow what is actually in the dataset. That keeps a
scan fast and offline, but it means drift on the RAGFlow side is invisible to
it — the dataset and your vault can hold different numbers of documents while
the scan cheerfully reports everything up to date. That happens when:

- documents were uploaded to the dataset by something other than this plugin
  (the RAGFlow UI, another vault, another machine);
- the plugin's local record was lost or reset (reinstall, deleted plugin data,
  a fresh vault), stranding every document it had uploaded;
- RAGFlow auto-suffixed a same-named upload into `name(1).ext` instead of
  replacing it, leaving the older copy behind;
- documents were deleted directly in the RAGFlow UI, or the whole dataset was
  deleted and recreated;
- a deletion was ignored — the local file is gone but its document is kept on
  purpose (that is what ignoring a `Deleted` entry means).

Click `Reconcile` to close that gap. It lists every document actually in each
mapped dataset and cross-references it with your vault, then reports:

- a `datasetname: 128 in RAGFlow / 120 tracked` line per dataset, so a mismatch
  is visible at a glance;
- an **In RAGFlow only (N)** section listing documents nothing in your vault
  accounts for. Tick the ones you want gone and click `Delete N from RAGFlow`.
  This is a separate button from `Sync all` on purpose: a dataset may
  legitimately hold documents that did not come from this vault, so the ordinary
  sync never touches them.
- files badged `Missing in RAGFlow`, whose document vanished remotely. They are
  ordinary changes from there on, so `Sync all` or `Sync selected (N)` re-uploads
  them. A file that was ignored re-surfaces if its document is missing — a
  snooze says "this file is fine as it is", which stops being true once its
  document is gone.

Reconcile reads every document in every mapped dataset, so it costs one request
per 100 documents and is not run as part of a normal scan. Run it when the
counts look wrong, after restoring plugin data, or after editing a dataset by
hand in RAGFlow. It is also available as
`RAGFlow Sync: Reconcile with RAGFlow` in the command palette. Note that syncing
re-scans the vault afterwards, which clears the reconcile result — run
`Reconcile` again if you want a fresh picture.

### Ignoring Files

To stop specific files from ever syncing without removing them from a mapping,
tick them in the tree and click `Ignore selected (N)`. Ignored files are
**frozen**: they are never uploaded, and any document already in RAGFlow for
them is left in place — the diff simply skips them. This is the key difference
from *Exclude paths* in settings: excluding a path takes a file out of scope, so
an already-synced document would be *deleted* on the next sync; ignoring keeps
the existing document untouched. Ignored files collect under a collapsible
`Ignored (N)` section at the bottom of the panel, where `Un-ignore` (or
`Un-ignore all`) returns them to normal diffing on the next scan.

## How Sync Works

- New files are uploaded as documents into the mapped RAGFlow dataset. For
  Markdown, frontmatter is stripped and set as the document's metadata.
- Modified files are replaced by deleting the old document and uploading the new
  version (RAGFlow has no in-place replace), then re-applying metadata.
- Deleted local files remove the previously synced document from its dataset.
- Unchanged files are skipped — unless the plugin's processing version moved on
  since they were synced, in which case they re-upload once (see above).
- The scan itself is entirely local: vault versus the plugin's own record. Use
  `Reconcile` to compare against what RAGFlow actually holds (see above).

With **Auto-parse after upload** enabled (the default, under *Parsing* in
settings), every document a sync uploads is queued for parsing in RAGFlow right
after the upload batch, using each dataset's own configured chunking method —
no need to start parsing by hand. Turn the toggle off to leave uploaded
documents unparsed and trigger parsing yourself in the RAGFlow UI (or via its
API) when you are ready.

The plugin stores sync metadata in Obsidian plugin data. This state is used to
detect changes quickly and to know which dataset document should be deleted or
replaced.

## Important Notes

- Sync is manual. The plugin does not currently auto-sync on file save.
- Only files under configured dataset mappings are considered.
- If a mapped vault folder does not exist, the scan shows a notice and skips it.
- If you move or rename a local file, it may be detected as one deleted file and
  one new file.
- For modified files, RAGFlow replacement is implemented as delete then upload.
- Because datasets are flat, two notes with the same filename mapped to the same
  dataset become same-named documents; give them distinct names or map them to
  different datasets if that matters to you. Since an upload replaces by name,
  such a pair overwrites each other and the dataset ends up holding fewer
  documents than the vault — a `Reconcile` will report the loser as
  `Missing in RAGFlow` every time.
- Keep your API key private. Do not commit Obsidian plugin data files containing
  local settings or secrets.

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Build:

```bash
npm run build
```

During development, run:

```bash
npm run dev
```

## License

MIT
