import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RagflowSyncPlugin from "./main";
import { FolderInputSuggest } from "./folderSuggest";
import { RagflowSyncSettings } from "./types";

/** Strip leading/trailing slashes; "" means root/whole-vault. */
function normalizeFolder(value: string): string {
	return value.trim().replace(/^\/+|\/+$/g, "");
}

export const DEFAULT_SETTINGS: RagflowSyncSettings = {
	ragflowBaseUrl: "http://127.0.0.1:9380",
	apiKey: "",
	datasetMappings: [],
	extensions: ["md", "pdf", "docx"],
	excludeGlobs: [".trash", ".obsidian"],
	internalizeLinks: false,
	normalizeTables: true,
	state: { files: {} },
};

export class RagflowSyncSettingTab extends PluginSettingTab {
	plugin: RagflowSyncPlugin;
	/** RAGFlow dataset names fetched for autocomplete; empty until loaded. */
	private ragflowDatasets: string[] = [];

	constructor(app: App, plugin: RagflowSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Vault folders (plus "" for whole-vault) as picker candidates. */
	private vaultFolders(): string[] {
		const paths = this.app.vault
			.getAllFolders(false)
			.map((f) => f.path)
			.sort((a, b) => a.localeCompare(b));
		return ["", ...paths];
	}

	/** Lazily fetch RAGFlow datasets for autocomplete; silent if not connected. */
	private async loadRagflowDatasets(): Promise<void> {
		const { ragflowBaseUrl, apiKey } = this.plugin.settings;
		if (!ragflowBaseUrl || !apiKey) return;
		try {
			this.ragflowDatasets = await this.plugin.client.listAllDatasetNames();
		} catch (_e) {
			// No connection / bad key: leave suggestions empty, manual typing works.
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// Populate RAGFlow dataset suggestions in the background; the pickers read
		// this.ragflowDatasets fresh on each keystroke, so no re-render is needed.
		void this.loadRagflowDatasets();

		containerEl.createEl("h2", { text: "RAGFlow connection" });

		new Setting(containerEl)
			.setName("RAGFlow base URL")
			.setDesc("e.g. http://127.0.0.1:9380 (no trailing /api/v1).")
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:9380")
					.setValue(this.plugin.settings.ragflowBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.ragflowBaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("RAGFlow API key (Bearer). Same key works for the Dataset API.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("ragflow-xxxxxxxx")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify the base URL and API key by listing RAGFlow datasets.")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText("Testing...");
					try {
						await this.plugin.client.listDatasets();
						new Notice("RAGFlow connection OK.");
					} catch (e) {
						new Notice(`Connection failed: ${(e as Error).message}`);
					} finally {
						btn.setDisabled(false);
						btn.setButtonText("Test");
					}
				})
			);

		containerEl.createEl("h2", { text: "Sync scope" });

		new Setting(containerEl)
			.setName("File extensions")
			.setDesc("Comma-separated, without dots. e.g. md,pdf,docx,pptx,txt")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.extensions.join(","))
					.onChange(async (value) => {
						this.plugin.settings.extensions = value
							.split(",")
							.map((s) => s.trim().replace(/^\./, "").toLowerCase())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Exclude paths")
			.setDesc("Comma-separated path fragments; any vault path containing one is skipped.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.excludeGlobs.join(","))
					.onChange(async (value) => {
						this.plugin.settings.excludeGlobs = value
							.split(",")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h2", { text: "Link internalization" });

		new Setting(containerEl)
			.setName("Internalize Obsidian links")
			.setDesc(
				"When syncing Markdown, rewrite [[wikilinks]] and ![[embeds]] to plain text/standard Markdown and append a \"Related notes\" section listing outgoing links and backlinks. Your vault files are never modified."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.internalizeLinks)
					.onChange(async (value) => {
						this.plugin.settings.internalizeLinks = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Normalize tables for RAGFlow")
			.setDesc(
				"When syncing Markdown, rewrite tables to clean border-style Markdown — escaping stray pipes (e.g. from [[Note|alias]] links), padding columns, and adding surrounding blank lines — so RAGFlow detects and aligns them instead of mis-splitting columns. Your vault files are never modified."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.normalizeTables)
					.onChange(async (value) => {
						this.plugin.settings.normalizeTables = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h2", { text: "Dataset mappings" });
		containerEl.createEl("p", {
			text: "Map a vault folder to a target RAGFlow dataset (knowledge base). Every in-scope file under the folder is uploaded directly into that dataset; the note's YAML frontmatter is stripped from the upload and set as the document's RAGFlow metadata instead. Click a field to pick from existing datasets (they load after a successful Test connection); you can also type a new dataset name and it will be created on sync. The \"Companion meta\" dropdown optionally pairs the mapping with a source folder of metadata notes — a metadata-less file (e.g. a PDF) then inherits the frontmatter of a note in that folder whose frontmatter links to it, e.g. a note with file: \"[[report.pdf]]\".",
			cls: "setting-item-description",
		});

		const listEl = containerEl.createDiv();
		this.renderMappings(listEl);

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("Add mapping")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.datasetMappings.push({
						vaultPath: "",
						datasetName: "",
					});
					await this.plugin.saveSettings();
					this.renderMappings(listEl);
				})
		);
	}

	private renderMappings(listEl: HTMLElement): void {
		listEl.empty();
		const mappings = this.plugin.settings.datasetMappings;
		if (mappings.length === 0) {
			listEl.createEl("p", {
				text: "No mappings yet.",
				cls: "setting-item-description",
			});
			return;
		}
		mappings.forEach((mapping, index) => {
			const row = listEl.createDiv({ cls: "ragflow-mapping-row" });

			const vaultInput = row.createEl("input", { type: "text" });
			vaultInput.placeholder = "Vault folder (e.g. Notes/Research)";
			vaultInput.value = mapping.vaultPath;
			const setVaultPath = async (value: string) => {
				mapping.vaultPath = normalizeFolder(value);
				await this.plugin.saveSettings();
			};
			vaultInput.addEventListener("change", () => setVaultPath(vaultInput.value));
			new FolderInputSuggest(
				this.app,
				vaultInput,
				() => this.vaultFolders(),
				(value) => void setVaultPath(value)
			);

			const arrow = row.createSpan({ text: "→" });
			arrow.style.flex = "0 0 auto";

			const ragInput = row.createEl("input", { type: "text" });
			ragInput.placeholder = "RAGFlow dataset (e.g. ObsidianVault)";
			ragInput.value = mapping.datasetName;
			const setDataset = async (value: string) => {
				mapping.datasetName = value.trim();
				await this.plugin.saveSettings();
			};
			ragInput.addEventListener("change", () => setDataset(ragInput.value));
			new FolderInputSuggest(
				this.app,
				ragInput,
				() => this.ragflowDatasets,
				(value) => void setDataset(value)
			);

			// Companion-metadata source folder: pairs this mapping with a folder of
			// metadata notes. "" (the first option) leaves companion metadata off.
			const metaSelect = row.createEl("select", {
				cls: "ragflow-mapping-meta-select",
			});
			metaSelect.title =
				"Companion meta source: a metadata-less file here inherits the frontmatter of a note in this folder whose frontmatter links to the file.";
			metaSelect.createEl("option", {
				text: "Companion meta: off",
				value: "",
			});
			for (const folder of this.vaultFolders()) {
				if (folder === "") continue;
				metaSelect.createEl("option", { text: folder, value: folder });
			}
			metaSelect.value = mapping.companionSourceFolder ?? "";
			metaSelect.addEventListener("change", async () => {
				mapping.companionSourceFolder = metaSelect.value || undefined;
				await this.plugin.saveSettings();
			});

			const removeBtn = row.createEl("button", { text: "✕" });
			removeBtn.style.flex = "0 0 auto";
			removeBtn.addEventListener("click", async () => {
				this.plugin.settings.datasetMappings.splice(index, 1);
				await this.plugin.saveSettings();
				this.renderMappings(listEl);
			});
		});
	}
}
