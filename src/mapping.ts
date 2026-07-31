import { DatasetMapping, ScopeConfig } from "./types";

/**
 * Pure reasoning about dataset mappings: what a vault path's extension is, which
 * mapping owns it, and whether it is in-scope. No IO, no Obsidian. Consumed by
 * the Diff (scope/ownership) and the SyncEngine (dataset resolution). Datasets
 * are flat, so a vault file's sub-folders are not mirrored — only ownership and
 * scope matter here.
 */

export function extensionOf(path: string): string {
	const dot = path.lastIndexOf(".");
	const slash = path.lastIndexOf("/");
	if (dot <= slash + 1) return "";
	return path.slice(dot + 1).toLowerCase();
}

export function prefixOf(mapping: DatasetMapping): string {
	return mapping.vaultPath ? `${mapping.vaultPath}/` : "";
}

/**
 * The mapping that owns this vault path: the one with the **longest** matching
 * folder prefix, so a nested mapping wins over the broader one containing it.
 *
 * Order in the settings list deliberately does not decide. Picking the first
 * match instead would mean `Notes -> main` silently swallows every file under a
 * later `Notes/Research -> research`, with nothing in the UI to explain why the
 * more specific mapping never took effect. Whole-vault mappings (empty
 * vaultPath) are the shortest prefix of all, so they only catch what no real
 * folder mapping claims. Ties are impossible: two mappings with the same
 * vaultPath have the same prefix length, and the first of those still wins.
 */
export function owningMapping(
	vaultPath: string,
	scope: ScopeConfig
): DatasetMapping | undefined {
	let best: DatasetMapping | undefined;
	let bestLength = -1;
	for (const mapping of scope.mappings) {
		const prefix = prefixOf(mapping);
		if (prefix !== "" && !vaultPath.startsWith(prefix)) continue;
		if (prefix.length > bestLength) {
			best = mapping;
			bestLength = prefix.length;
		}
	}
	return best;
}

/** A vault file is in-scope if owned by a mapping, allowed by extension, and not excluded. */
export function isInScope(
	vaultPath: string,
	scope: ScopeConfig
): DatasetMapping | undefined {
	if (!scope.extensions.includes(extensionOf(vaultPath))) return undefined;
	if (scope.excludeGlobs.some((g) => g.length > 0 && vaultPath.includes(g))) {
		return undefined;
	}
	return owningMapping(vaultPath, scope);
}
