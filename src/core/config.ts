import { existsSync, readFileSync } from "node:fs";
import { join, matchesGlob, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { DocTarget } from "./types.ts";

export const REPO_CONFIG_FILE = ".adr-recorder.yaml";

export interface RepoConfig {
	adr_dir?: string;
	backlog_dir?: string;
	numbering?: "sequential" | "date";
	template?: string;
	targets?: Partial<Record<DocTarget, string>>;
	/** Globs (repo-relative) the nested ADR folder search skips. */
	ignore?: string[];
}

export interface ModelEndpoint {
	/** OpenAI-compatible base URL; the CLI posts to <base_url>/chat/completions. */
	base_url: string;
	/** Name of the env var holding the API key. The key itself never goes in a file. */
	api_key_env: string;
}

export type AutoReview = "on" | "ask" | "off";

export interface Config {
	classifier_model?: string;
	reviewer_model?: string;
	model_endpoint?: ModelEndpoint;
	enabled_paths: string[];
	disabled_paths: string[];
	auto_review: AutoReview;
	/** Command template for the review hand-off. User config only. */
	review_command?: string;
	repo: RepoConfig;
}

export interface LoadedConfig {
	config: Config;
	/** Files that were read, in merge order. */
	sources: string[];
	errors: string[];
}

export interface ConfigEnv {
	home: string;
	env: Record<string, string | undefined>;
}

export function userConfigPath({ home, env }: ConfigEnv): string {
	if (env.ADR_RECORDER_CONFIG) return env.ADR_RECORDER_CONFIG;
	const base = env.XDG_CONFIG_HOME || join(home, ".config");
	return join(base, "adr-recorder", "adr-recorder.yaml");
}

export function expandHome(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return p.replace(/^\$HOME(?=\/|$)/, home);
}

function readYaml(file: string, errors: string[]): Record<string, unknown> | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const v = parseYaml(readFileSync(file, "utf8"));
		if (v == null) return {};
		if (typeof v !== "object" || Array.isArray(v)) {
			errors.push(`${file}: expected a mapping`);
			return undefined;
		}
		return v as Record<string, unknown>;
	} catch (e) {
		errors.push(`${file}: ${(e as Error).message}`);
		return undefined;
	}
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strList = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

function repoPart(y: Record<string, unknown>): RepoConfig {
	const out: RepoConfig = {};
	const adr = str(y.adr_dir);
	if (adr) out.adr_dir = adr;
	const backlog = str(y.backlog_dir);
	if (backlog) out.backlog_dir = backlog;
	if (y.numbering === "sequential" || y.numbering === "date") out.numbering = y.numbering;
	const tpl = str(y.template);
	if (tpl) out.template = tpl;
	if (Array.isArray(y.ignore))
		out.ignore = y.ignore.filter((v): v is string => typeof v === "string");
	if (y.targets && typeof y.targets === "object") {
		const t: Partial<Record<DocTarget, string>> = {};
		for (const [k, v] of Object.entries(y.targets as Record<string, unknown>)) {
			const s = str(v);
			if (s) t[k as DocTarget] = s;
		}
		out.targets = t;
	}
	return out;
}

/**
 * Merge user config and repo config. The repo file may set models and layout.
 * Settings that run commands or decide where transcripts go
 * (model_endpoint, review_command, enabled/disabled paths) come from the user
 * file only, so a cloned repo can't redirect them.
 */
export function loadConfig(envIn: ConfigEnv, repoRoot?: string): LoadedConfig {
	const errors: string[] = [];
	const sources: string[] = [];
	const userFile = userConfigPath(envIn);
	const user = readYaml(userFile, errors);
	if (user) sources.push(userFile);
	let repo: Record<string, unknown> | undefined;
	if (repoRoot) {
		const repoFile = join(repoRoot, REPO_CONFIG_FILE);
		repo = readYaml(repoFile, errors);
		if (repo) sources.push(repoFile);
	}
	const u = user ?? {};
	const r = repo ?? {};

	let endpoint: ModelEndpoint | undefined;
	const ep = u.model_endpoint as Record<string, unknown> | undefined;
	if (ep && typeof ep === "object") {
		const base = str(ep.base_url);
		const key = str(ep.api_key_env);
		if (base && key) endpoint = { base_url: base.replace(/\/+$/, ""), api_key_env: key };
		else errors.push(`${userFile}: model_endpoint needs base_url and api_key_env`);
	}
	if (repo?.model_endpoint || repo?.review_command) {
		errors.push(
			`${REPO_CONFIG_FILE}: model_endpoint and review_command are only read from ${userFile}`,
		);
	}

	const autoRaw = str(r.auto_review) ?? str(u.auto_review) ?? "on";
	const auto_review: AutoReview = autoRaw === "ask" || autoRaw === "off" ? autoRaw : "on";

	const config: Config = {
		classifier_model: str(r.classifier_model) ?? str(u.classifier_model),
		reviewer_model: str(r.reviewer_model) ?? str(u.reviewer_model),
		model_endpoint: endpoint,
		enabled_paths: strList(u.enabled_paths).map((p) => expandHome(p, envIn.home)),
		disabled_paths: strList(u.disabled_paths).map((p) => expandHome(p, envIn.home)),
		auto_review,
		review_command: str(u.review_command),
		repo: { ...repoPart(u), ...repoPart(r) },
	};
	return { config, sources, errors };
}

/** Models are required; there are no built-in defaults. */
export function missingSettings(config: Config, opts: { needEndpoint: boolean }): string[] {
	const missing: string[] = [];
	if (!config.classifier_model) missing.push("classifier_model");
	if (!config.reviewer_model) missing.push("reviewer_model");
	if (opts.needEndpoint && !config.model_endpoint) missing.push("model_endpoint");
	return missing;
}

function globMatch(path: string, pattern: string): boolean {
	const p = resolve(path);
	if (matchesGlob(p, pattern)) return true;
	// "~/code/x/**" should also match ~/code/x itself.
	if (pattern.endsWith("/**")) return p === resolve(pattern.slice(0, -3));
	return false;
}

export interface Enablement {
	enabled: boolean;
	reason: string;
}

export function decideEnablement(input: {
	cwd: string;
	config: Config;
	hasAdrFolder: boolean;
	/** /adr on (true) or /adr off (false) in this session. */
	sessionOverride?: boolean;
	/** Set for the review agent so it never records itself. */
	reviewChild?: boolean;
}): Enablement {
	if (input.reviewChild) return { enabled: false, reason: "review agent" };
	if (input.sessionOverride === false) return { enabled: false, reason: "/adr off" };
	if (input.sessionOverride === true) return { enabled: true, reason: "/adr on" };
	const disabled = input.config.disabled_paths.find((g) => globMatch(input.cwd, g));
	if (disabled) return { enabled: false, reason: `disabled_paths: ${disabled}` };
	if (input.hasAdrFolder) return { enabled: true, reason: "repo has an ADR folder" };
	const enabled = input.config.enabled_paths.find((g) => globMatch(input.cwd, g));
	if (enabled) return { enabled: true, reason: `enabled_paths: ${enabled}` };
	return { enabled: false, reason: "no ADR folder and no enabled_paths match" };
}
