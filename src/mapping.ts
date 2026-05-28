import { FolderMapping, ScopeConfig } from "./types";

/**
 * Pure reasoning about folder mappings: what a vault path's extension is, which
 * mapping owns it, whether it is in-scope, and where it lands in RAGFlow. No IO,
 * no Obsidian. Consumed by the Diff (scope/ownership) and the SyncEngine
 * (placement).
 */

export function extensionOf(path: string): string {
	const dot = path.lastIndexOf(".");
	const slash = path.lastIndexOf("/");
	if (dot <= slash + 1) return "";
	return path.slice(dot + 1).toLowerCase();
}

export function prefixOf(mapping: FolderMapping): string {
	return mapping.vaultPath ? `${mapping.vaultPath}/` : "";
}

function splitPath(path: string): string[] {
	return path.split("/").filter((p) => p.length > 0);
}

/** The first mapping whose prefix owns this vault path, if any. */
export function owningMapping(
	vaultPath: string,
	scope: ScopeConfig
): FolderMapping | undefined {
	return scope.mappings.find((m) => {
		const prefix = prefixOf(m);
		return prefix === "" ? true : vaultPath.startsWith(prefix);
	});
}

/** A vault file is in-scope if owned by a mapping, allowed by extension, and not excluded. */
export function isInScope(
	vaultPath: string,
	scope: ScopeConfig
): FolderMapping | undefined {
	if (!scope.extensions.includes(extensionOf(vaultPath))) return undefined;
	if (scope.excludeGlobs.some((g) => g.length > 0 && vaultPath.includes(g))) {
		return undefined;
	}
	return owningMapping(vaultPath, scope);
}

/**
 * The RAGFlow folder path (as segments) a vault file maps to: the mapping's
 * base folder, followed by the file's sub-folders relative to the mapping.
 */
export function placement(mapping: FolderMapping, vaultPath: string): string[] {
	const prefix = prefixOf(mapping);
	const relative = vaultPath.slice(prefix.length);
	const dirs = relative.split("/");
	dirs.pop(); // drop the file name
	return [
		...splitPath(mapping.ragflowBaseFolder),
		...dirs.filter((p) => p.length > 0),
	];
}
