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

/** The first mapping whose prefix owns this vault path, if any. */
export function owningMapping(
	vaultPath: string,
	scope: ScopeConfig
): DatasetMapping | undefined {
	return scope.mappings.find((m) => {
		const prefix = prefixOf(m);
		return prefix === "" ? true : vaultPath.startsWith(prefix);
	});
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
