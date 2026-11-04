import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Config,
	decideEnablement,
	expandHome,
	loadConfig,
	missingSettings,
	userConfigPath,
} from "../../src/core/config.ts";
import { tempRepo } from "../helpers.ts";

function setup(user?: string, repo?: string) {
	const home = tempRepo();
	const root = tempRepo();
	if (user !== undefined) {
		mkdirSync(join(home, ".config", "adr-recorder"), { recursive: true });
		writeFileSync(join(home, ".config", "adr-recorder", "adr-recorder.yaml"), user);
	}
	if (repo !== undefined) writeFileSync(join(root, ".adr-recorder.yaml"), repo);
	return loadConfig({ home, env: {} }, root);
}

const USER = `classifier_model: example/cheap
reviewer_model: example/strong
model_endpoint:
  base_url: https://example.test/v1/
  api_key_env: TEST_KEY
enabled_paths: ["~/code/work/**"]
review_command: "my-agent --model {model} {prompt}"
auto_review: ask
`;

describe("loadConfig", () => {
	it("reads the user file", () => {
		const { config, errors, sources } = setup(USER);
		expect(errors).toEqual([]);
		expect(sources).toHaveLength(1);
		expect(config).toMatchObject({
			classifier_model: "example/cheap",
			reviewer_model: "example/strong",
			model_endpoint: { base_url: "https://example.test/v1", api_key_env: "TEST_KEY" },
			review_command: "my-agent --model {model} {prompt}",
			auto_review: "ask",
		});
		expect(config.enabled_paths[0]).toMatch(/\/code\/work\/\*\*$/);
		expect(config.enabled_paths[0]).not.toContain("~");
	});

	it("repo file overrides models, layout and auto_review, never endpoint or review_command", () => {
		const { config, errors } = setup(
			USER,
			"classifier_model: other/model\nauto_review: off\nadr_dir: doc/adr\nignore: [examples/**, 3]\nmodel_endpoint:\n  base_url: https://evil.test\n  api_key_env: X\nreview_command: rm -rf /\n",
		);
		expect(config.classifier_model).toBe("other/model");
		expect(config.reviewer_model).toBe("example/strong");
		expect(config.auto_review).toBe("off");
		expect(config.repo.adr_dir).toBe("doc/adr");
		expect(config.repo.ignore).toEqual(["examples/**"]);
		expect(config.model_endpoint?.base_url).toBe("https://example.test/v1");
		expect(config.review_command).toBe("my-agent --model {model} {prompt}");
		expect(errors.join("\n")).toMatch(/only read from/);
	});

	it("reports broken YAML and incomplete endpoints instead of throwing", () => {
		expect(setup("classifier_model: [unclosed\n").errors[0]).toMatch(/adr-recorder\.yaml/);
		expect(setup("model_endpoint:\n  base_url: https://x\n").errors[0]).toMatch(/api_key_env/);
	});

	it("no files: models are missing, auto_review defaults to on", () => {
		const { config } = setup();
		expect(missingSettings(config, { needEndpoint: true })).toEqual([
			"classifier_model",
			"reviewer_model",
			"model_endpoint",
		]);
		expect(missingSettings(config, { needEndpoint: false })).toEqual([
			"classifier_model",
			"reviewer_model",
		]);
		expect(config.auto_review).toBe("on");
	});

	it("userConfigPath honours ADR_RECORDER_CONFIG and XDG_CONFIG_HOME", () => {
		expect(userConfigPath({ home: "/h", env: {} })).toBe(
			"/h/.config/adr-recorder/adr-recorder.yaml",
		);
		expect(userConfigPath({ home: "/h", env: { XDG_CONFIG_HOME: "/x" } })).toBe(
			"/x/adr-recorder/adr-recorder.yaml",
		);
		expect(userConfigPath({ home: "/h", env: { ADR_RECORDER_CONFIG: "/c.yaml" } })).toBe("/c.yaml");
	});

	it("expandHome", () => {
		expect(expandHome("~/a", "/h")).toBe("/h/a");
		expect(expandHome("$HOME/a", "/h")).toBe("/h/a");
		expect(expandHome("/abs", "/h")).toBe("/abs");
	});
});

describe("decideEnablement", () => {
	const config: Config = {
		enabled_paths: ["/h/code/work/**"],
		disabled_paths: ["/h/code/work/scratch/**"],
		auto_review: "on",
		repo: {},
	};
	const run = (cwd: string, extra: Partial<Parameters<typeof decideEnablement>[0]> = {}) =>
		decideEnablement({ cwd, config, hasAdrFolder: false, ...extra }).enabled;

	it("an ADR folder turns it on", () =>
		expect(run("/elsewhere", { hasAdrFolder: true })).toBe(true));
	it("enabled_paths glob, including the base folder", () => {
		expect(run("/h/code/work/app")).toBe(true);
		expect(run("/h/code/work")).toBe(true);
		expect(run("/h/code/other")).toBe(false);
	});
	it("disabled_paths wins over enabled_paths and an ADR folder", () => {
		expect(run("/h/code/work/scratch/x")).toBe(false);
		expect(run("/h/code/work/scratch/x", { hasAdrFolder: true })).toBe(false);
	});
	it("/adr on and /adr off win over globs", () => {
		expect(run("/h/code/other", { sessionOverride: true })).toBe(true);
		expect(run("/h/code/work/app", { sessionOverride: false })).toBe(false);
	});
	it("the review agent never records", () => {
		expect(run("/h/code/work/app", { reviewChild: true, sessionOverride: true })).toBe(false);
	});
});
