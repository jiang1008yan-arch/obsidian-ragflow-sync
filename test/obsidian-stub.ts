// Minimal runtime stand-in for the (types-only) obsidian package so Vitest can
// resolve modules that import runtime symbols from it. Only the symbols actually
// evaluated by the unit tests are provided; types still come from obsidian's
// .d.ts in node_modules.
export class TFile {}

export function parseYaml(): unknown {
	return {};
}

export function requestUrl(): never {
	throw new Error("requestUrl is not available in unit tests");
}
