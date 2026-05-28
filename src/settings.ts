import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RagflowSyncPlugin from "./main";
import { RagflowSyncSettings } from "./types";

export const DEFAULT_SETTINGS: RagflowSyncSettings = {
	ragflowBaseUrl: "http://127.0.0.1:9380",
	apiKey: "",
	folderMappings: [],
	extensions: ["md", "pdf", "docx"],
	excludeGlobs: [".trash", ".obsidian"],
	state: { files: {} },
};

export class RagflowSyncSettingTab extends PluginSettingTab {
	plugin: RagflowSyncPlugin;

	constructor(app: App, plugin: RagflowSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

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

		containerEl.createEl("h2", { text: "Folder mappings" });
		containerEl.createEl("p", {
			text: "Map a vault folder to a target folder inside RAGFlow File Management. Subfolders are mirrored recursively.",
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
			vaultInput.addEventListener("change", async () => {
				mapping.vaultPath = vaultInput.value.trim().replace(/^\/+|\/+$/g, "");
				await this.plugin.saveSettings();
			});

			const arrow = row.createSpan({ text: "→" });
			arrow.style.flex = "0 0 auto";

			const ragInput = row.createEl("input", { type: "text" });
			ragInput.placeholder = "RAGFlow folder (e.g. ObsidianVault/Research)";
			ragInput.value = mapping.ragflowBaseFolder;
			ragInput.addEventListener("change", async () => {
				mapping.ragflowBaseFolder = ragInput.value.trim().replace(/^\/+|\/+$/g, "");
				await this.plugin.saveSettings();
			});

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
