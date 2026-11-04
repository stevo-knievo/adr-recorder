import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BIN = new URL("../../bin/adr-recorder.js", import.meta.url).pathname;

describe("cli shim", () => {
	it("prints the package version", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
		const out = execFileSync("node", [BIN, "version"], { encoding: "utf8" });
		expect(out.trim()).toBe(pkg.version);
	});
});
