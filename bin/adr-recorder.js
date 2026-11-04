#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const RUNTIME_DEPS = ["jiti", "yaml"];
const require = createRequire(import.meta.url);
const missing = RUNTIME_DEPS.filter((name) => {
	try {
		require.resolve(name);
		return false;
	} catch {
		return true;
	}
});
if (missing.length) {
	// Some agents (Codex) copy a plugin from git without installing its
	// packages. Install the runtime ones once, next to package.json.
	const root = fileURLToPath(new URL("..", import.meta.url));
	process.stderr.write(`adr-recorder: installing ${missing.join(", ")} in ${root}\n`);
	execFileSync(
		"npm",
		["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
		{ cwd: root, stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 },
	);
}

// Node can't strip types under node_modules, so load the TypeScript CLI through jiti.
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../src/cli.ts");
process.exitCode = await main(process.argv.slice(2));
