import { describe, expect, it } from "vitest";
import { statusText } from "../../src/core/status.ts";

describe("statusText", () => {
	it("is empty when off", () => {
		expect(statusText(false, 3)).toBeUndefined();
	});
	it("shows the dot when on", () => {
		expect(statusText(true)).toBe("ADR rec ●");
	});
	it("adds the note count", () => {
		expect(statusText(true, 3)).toBe("ADR rec ● 3");
	});
});
