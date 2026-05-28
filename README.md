# RAGFlow Sync for Obsidian

Sync selected Obsidian vault folders to RAGFlow File Management while preserving
the folder structure. The plugin scans for differences before syncing, so you
can see which files are new, modified, deleted, or already up to date.

## Features

- Sync Markdown, PDF, Word, PowerPoint, Excel, text, and image files.
- Map one or more Obsidian folders to target folders in RAGFlow.
- Mirror subfolders recursively under each mapped folder.
- Scan differences before uploading or deleting anything.
- Sync all changes, or sync one change group at a time.
- Track local file hashes to avoid re-uploading unchanged content.

## Requirements

- Obsidian desktop app 1.4.0 or newer.
- A running RAGFlow instance.
- A RAGFlow API key that can access File Management.

This plugin is desktop-only because it uses Obsidian desktop APIs for local file
access and network requests.

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

Click `Test` to verify that Obsidian can connect to RAGFlow and list the root
File Management folder.

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

### Folder Mappings

Folder mappings decide what gets synced and where it appears in RAGFlow.

Each mapping has two fields:

- `Vault folder`: a folder path inside your Obsidian vault.
- `RAGFlow folder`: the destination folder path inside RAGFlow File Management.

Example:

```text
Vault folder: Notes/Research
RAGFlow folder: ObsidianVault/Research
```

With this mapping, a local file:

```text
Notes/Research/Papers/llm-notes.md
```

is synced to RAGFlow as:

```text
ObsidianVault/Research/Papers/llm-notes.md
```

The plugin creates missing RAGFlow folders automatically.

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

## How Sync Works

- New files are uploaded to the mapped RAGFlow folder.
- Modified files are replaced by deleting the old RAGFlow file and uploading the
  new version.
- Deleted local files remove the previously synced RAGFlow file.
- Unchanged files are skipped.

The plugin stores sync metadata in Obsidian plugin data. This state is used to
detect changes quickly and to know which remote RAGFlow file should be deleted
or replaced.

## Important Notes

- Sync is manual. The plugin does not currently auto-sync on file save.
- Only files under configured folder mappings are considered.
- If a mapped vault folder does not exist, the scan shows a notice and skips it.
- If you move or rename a local file, it may be detected as one deleted file and
  one new file.
- For modified files, RAGFlow replacement is implemented as delete then upload.
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
