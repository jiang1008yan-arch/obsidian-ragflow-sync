import { resolve } from "path";
import { defineConfig } from "vitest/config";

// The published "obsidian" package is types-only, so Vitest cannot resolve it
// when a module under test imports runtime symbols from it. Alias it to a small
// stub providing just those symbols. Production builds keep obsidian external
// via esbuild and are unaffected.
export default defineConfig({
	resolve: {
		alias: {
			obsidian: resolve(__dirname, "test/obsidian-stub.ts"),
		},
	},
});
