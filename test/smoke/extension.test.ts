import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const EXT = new URL("../../src/pi/index.ts", import.meta.url).pathname;
const skip = process.env.SKIP_PI_TESTS === "1";

// Loads the extension in a real pi without a model call. pi reports load
// failures on stderr ("Failed to load extension") and still exits 0.
describe.skipIf(skip)("pi extension", () => {
	it("loads without errors", () => {
		const r = spawnSync("pi", ["-e", EXT, "--list-models", "nomatch-xyz"], { encoding: "utf8" });
		expect(r.error).toBeUndefined();
		expect(`${r.stdout}${r.stderr}`).not.toMatch(/Failed to load extension/);
	});

	it("the check catches a broken extension", () => {
		const r = spawnSync(
			"pi",
			["-e", new URL("./fixtures/broken-ext.ts", import.meta.url).pathname, "--list-models", "x"],
			{ encoding: "utf8" },
		);
		expect(r.stderr).toMatch(/Failed to load extension/);
	});
});
