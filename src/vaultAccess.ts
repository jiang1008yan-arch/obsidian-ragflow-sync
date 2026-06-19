import { App, parseYaml, TFile } from "obsidian";
import { splitFrontmatter } from "./frontmatter";
import { noteTitle } from "./internalize";
import type { RelatedLinks, VaultEntry } from "./types";

export interface VaultFile {
	path: string;
	name: string;
	basename: string;
	extension: string;
	stat: {
		size: number;
		mtime: number;
	};
}

export interface VaultAccess {
	listSnapshot(): VaultEntry[];
	folderExists(path: string): boolean;
	getFile(path: string): VaultFile | undefined;
	readBinary(path: string): Promise<ArrayBuffer>;
	markdownFilesUnder(folder: string): VaultFile[];
	frontmatter(file: VaultFile): Promise<Record<string, unknown> | undefined>;
	resolveLink(linkpath: string, sourcePath: string): VaultFile | undefined;
	relatedLinks(path: string): RelatedLinks;
}

export class ObsidianVaultAccess implements VaultAccess {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	listSnapshot(): VaultEntry[] {
		return this.app.vault.getFiles().map((f) => ({
			path: f.path,
			size: f.stat.size,
			mtime: f.stat.mtime,
		}));
	}

	folderExists(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(path) !== null;
	}

	getFile(path: string): VaultFile | undefined {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : undefined;
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		return this.app.vault.adapter.readBinary(path);
	}

	markdownFilesUnder(folder: string): VaultFile[] {
		const prefix = `${folder}/`;
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path === folder || f.path.startsWith(prefix));
	}

	async frontmatter(file: VaultFile): Promise<Record<string, unknown> | undefined> {
		const note = this.getFile(file.path);
		if (!note) return undefined;
		const cached = this.app.metadataCache.getFileCache(note as TFile)?.frontmatter;
		if (cached) return cached;
		try {
			const text = await this.app.vault.cachedRead(note as TFile);
			const { yaml } = splitFrontmatter(text);
			if (yaml === null) return undefined;
			const parsed = parseYaml(yaml);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			return undefined;
		} catch (_e) {
			return undefined;
		}
	}

	resolveLink(linkpath: string, sourcePath: string): VaultFile | undefined {
		return (
			this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) ??
			undefined
		);
	}

	relatedLinks(path: string): RelatedLinks {
		const resolved = this.app.metadataCache.resolvedLinks ?? {};
		const isNote = (p: string) => p.toLowerCase().endsWith(".md");

		const outgoing = Object.keys(resolved[path] ?? {})
			.filter((target) => target !== path && isNote(target))
			.map(noteTitle);

		const incoming: string[] = [];
		for (const [source, targets] of Object.entries(resolved)) {
			if (source !== path && isNote(source) && targets[path]) {
				incoming.push(noteTitle(source));
			}
		}
		return { outgoing, incoming };
	}
}
