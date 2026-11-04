import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CORE = new URL("../../src/core/", import.meta.url).pathname;

function tsFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? tsFiles(join(dir, e.name))
			: e.name.endsWith(".ts")
				? [join(dir, e.name)]
				: [],
	);
}

describe("core boundary", () => {
	it("src/core never imports pi packages or adapters", () => {
		const offenders = tsFiles(CORE).filter((f) => {
			const src = readFileSync(f, "utf8");
			return (
				/from\s+["'](@earendil-works\/|@mariozechner\/|typebox)/.test(src) ||
				/from\s+["']\.\.\/(pi|claude-code|codex)\//.test(src)
			);
		});
		expect(offenders).toEqual([]);
	});
});
