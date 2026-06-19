import {
	frontmatterLinkTargets,
	normalizeMeta,
	splitPartStem,
} from "./frontmatter";
import type { RagflowSyncSettings } from "./types";
import type { VaultAccess, VaultFile } from "./vaultAccess";

export type CompanionIndex = Map<string, Map<string, Record<string, unknown>>>;

export async function buildCompanionIndex(
	settings: RagflowSyncSettings,
	vault: VaultAccess
): Promise<CompanionIndex> {
	const index: CompanionIndex = new Map();
	const folders = new Set(
		settings.datasetMappings
			.map((m) => m.companionSourceFolder)
			.filter((f): f is string => !!f && f.length > 0)
	);

	for (const folder of folders) {
		const map = new Map<string, Record<string, unknown>>();
		for (const note of vault.markdownFilesUnder(folder)) {
			const fm = await vault.frontmatter(note);
			if (!fm) continue;
			const targets = frontmatterLinkTargets(fm);
			if (targets.length === 0) continue;
			const meta = normalizeMeta(fm);
			for (const target of targets) {
				indexCompanionTarget(map, vault, note, target, meta);
			}
		}
		index.set(folder, map);
	}
	return index;
}

function indexCompanionTarget(
	map: Map<string, Record<string, unknown>>,
	vault: VaultAccess,
	note: VaultFile,
	linkpath: string,
	meta: Record<string, unknown>
): void {
	const dest = vault.resolveLink(linkpath, note.path);
	if (dest) map.set(dest.path, meta);

	const name = (linkpath.split("/").pop() ?? linkpath).trim();
	if (!name) return;
	map.set(`name:${name.toLowerCase()}`, meta);
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	map.set(`base:${base.toLowerCase()}`, meta);
}

export function lookupCompanion(
	companionIndex: CompanionIndex,
	sourceFolder: string,
	file: VaultFile
): Record<string, unknown> | undefined {
	const map = companionIndex.get(sourceFolder);
	if (!map) return undefined;
	const direct =
		map.get(file.path) ??
		map.get(`name:${file.name.toLowerCase()}`) ??
		map.get(`base:${file.basename.toLowerCase()}`);
	if (direct) return direct;
	const stem = splitPartStem(file.basename);
	return stem ? map.get(`base:${stem.toLowerCase()}`) : undefined;
}
