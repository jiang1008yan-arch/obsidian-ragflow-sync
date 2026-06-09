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

/**
 * Whether a vault path is selected by a list of companion-metadata entries: it
 * matches when the path equals an entry (a single file) or sits under one (a
 * folder). Empty entries are ignored so a stray blank row never selects the
 * whole vault. Pure.
 */
export function isCompanionPath(vaultPath: string, paths: string[]): boolean {
	return paths.some(
		(p) => p.length > 0 && (vaultPath === p || vaultPath.startsWith(`${p}/`))
	);
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
