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
- Scan differences before uploading or deleting anything.
- Sync all changes, or sync one change group at a time.
- Track local file hashes to avoid re-uploading unchanged content.
- Optionally internalize Obsidian double links: rewrite `[[wikilinks]]` and
  `![[embeds]]` to plain text/standard Markdown and append a related-notes
  section (outgoing links and backlinks) so the link graph survives in RAGFlow.

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

## Use The Plugin

There are three ways to open or run sync actions:

- Click the `RAGFlow Sync` ribbon icon.
- Run `RAGFlow Sync: Open sync panel` from the command palette.
- Run `RAGFlow Sync: Scan for differences` or `RAGFlow Sync: Sync all changes`
  from the command palette.

### Recommended Workflow

1. Open the `RAGFlow Sync` panel.

2. Click `Scan diff`.

3. Review the result groups:

   - `New`: files that exist locally but have not been uploaded yet.
   - `Modified`: files whose content changed since the last successful sync.
   - `Deleted`: files that were synced before but no longer exist locally.
   - `Up to date`: files that match the last synced state.

4. Click `Sync all` to apply all changes, or click `Sync these` on one group.

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
(for example you deleted documents on the RAGFlow side), use `Force re-sync all`
in the panel, or run `RAGFlow Sync: Force re-sync all` from the command palette.
This re-uploads every in-scope file regardless of the diff result.

## How Sync Works

- New files are uploaded as documents into the mapped RAGFlow dataset. For
  Markdown, frontmatter is stripped and set as the document's metadata.
- Modified files are replaced by deleting the old document and uploading the new
  version (RAGFlow has no in-place replace), then re-applying metadata.
- Deleted local files remove the previously synced document from its dataset.
- Unchanged files are skipped — unless the plugin's processing version moved on
  since they were synced, in which case they re-upload once (see above).

Uploaded documents are not parsed/chunked automatically — trigger parsing in the
RAGFlow UI (or via its API) when you are ready.

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
  different datasets if that matters to you.
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
