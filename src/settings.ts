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
	folderMappings: [],
	extensions: ["md", "pdf", "docx"],
	excludeGlobs: [".trash", ".obsidian"],
	internalizeLinks: false,
	state: { files: {} },
};

export class RagflowSyncSettingTab extends PluginSettingTab {
	plugin: RagflowSyncPlugin;
	/** RAGFlow folder paths fetched for autocomplete; empty until loaded. */
	private ragflowFolders: string[] = [];

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

	/** Lazily fetch RAGFlow folders for autocomplete; silent if not connected. */
	private async loadRagflowFolders(): Promise<void> {
		const { ragflowBaseUrl, apiKey } = this.plugin.settings;
		if (!ragflowBaseUrl || !apiKey) return;
		try {
			this.ragflowFolders = ["", ...(await this.plugin.client.listAllFolderPaths())];
		} catch (_e) {
			// No connection / bad key: leave suggestions empty, manual typing works.
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// Populate RAGFlow folder suggestions in the background; the pickers read
		// this.ragflowFolders fresh on each keystroke, so no re-render is needed.
		void this.loadRagflowFolders();

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
			.setDesc("RAGFlow API key (Bearer). Same key works for File Management.")
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
			.setDesc("Verify the base URL and API key by listing the RAGFlow root folder.")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText("Testing...");
					try {
						await this.plugin.client.getRoot();
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

		containerEl.createEl("h2", { text: "Folder mappings" });
		containerEl.createEl("p", {
			text: "Map a vault folder to a target folder inside RAGFlow File Management. Subfolders are mirrored recursively. Click a field to pick from existing folders (RAGFlow folders load after a successful Test connection); you can also type a new RAGFlow path and it will be created on sync.",
			cls: "setting-item-description",
		});

		const listEl = containerEl.createDiv();
		this.renderMappings(listEl);

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("Add mapping")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.folderMappings.push({
						vaultPath: "",
						ragflowBaseFolder: "",
					});
					await this.plugin.saveSettings();
					this.renderMappings(listEl);
				})
		);
	}

	private renderMappings(listEl: HTMLElement): void {
		listEl.empty();
		const mappings = this.plugin.settings.folderMappings;
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
			ragInput.placeholder = "RAGFlow folder (e.g. ObsidianVault/Research)";
			ragInput.value = mapping.ragflowBaseFolder;
			const setRagPath = async (value: string) => {
				mapping.ragflowBaseFolder = normalizeFolder(value);
				await this.plugin.saveSettings();
			};
			ragInput.addEventListener("change", () => setRagPath(ragInput.value));
			new FolderInputSuggest(
				this.app,
				ragInput,
				() => this.ragflowFolders,
				(value) => void setRagPath(value)
			);

			const removeBtn = row.createEl("button", { text: "✕" });
			removeBtn.style.flex = "0 0 auto";
			removeBtn.addEventListener("click", async () => {
				this.plugin.settings.folderMappings.splice(index, 1);
				await this.plugin.saveSettings();
				this.renderMappings(listEl);
			});
		});
	}
}
