import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createOpenAIClassifier, endpointModelId } from "./core/classifier-openai.ts";
import {
	decideEnablement,
	loadConfig,
	missingSettings,
	stateDir,
	userConfigPath,
} from "./core/config.ts";
import type { Classifier } from "./core/detect.ts";
import {
	getHarness,
	listHarnesses,
	PLANNED_HARNESSES,
	type SessionSource,
} from "./core/harness/index.ts";
import { listLaunchers, pickLauncher, type System } from "./core/launch/index.ts";
import { nodeSystem } from "./core/launch/system.ts";
import { findGitRoot, hasAdrFolder, resolveLayout } from "./core/layout.ts";
import { startReview } from "./core/review-start.ts";
import { type ExchangeResult, scanSession } from "./core/scan.ts";

const USAGE = `Usage: adr-recorder <command> [options]

Commands:
  scan       Find decisions in past sessions and write backlog notes
  review     Open a reviewer for the open backlog notes
  status     Show the resolved layout, config and enablement for a project
  launchers  List review launchers and which one this terminal would use
  version    Print the version

scan options:
  --harness <name|all>   Session source (default: pi; see README for the list)
  --path <dir>           Project folder (default: current folder)
  --since <YYYY-MM-DD>   Only sessions started on or after this date
  --session <file>       Scan one session file instead of searching
  --sessions-dir <dir>   Override the harness's sessions folder
  --dry-run              Classify, but don't write notes
  --verbose              Show every exchange, not only hits

review options:
  --path <dir>           Project folder (default: current folder)
  --launcher <name>      Override review_launcher (auto, headless, rex, ...)
  --harness <name>       Agent that reviews (default: review_harness, else pi)
  --dry-run              Print the plan, open nothing
`;

export interface CliIO {
	out: (s: string) => void;
	err: (s: string) => void;
	env: Record<string, string | undefined>;
	home: string;
	cwd: string;
	/** Tests inject a fake classifier. */
	classifier?: Classifier;
	/** Tests inject a fake system for launchers. */
	sys?: System;
}

const defaultIO = (): CliIO => ({
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(s),
	env: process.env,
	home: homedir(),
	cwd: process.cwd(),
});

export async function main(argv: string[], io: CliIO = defaultIO()): Promise<number> {
	const [command, ...rest] = argv;
	try {
		switch (command) {
			case "version":
			case "--version": {
				const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
				io.out(`${pkg.version}\n`);
				return 0;
			}
			case "scan":
				return await scan(rest, io);
			case "status":
				return status(rest, io);
			case "review":
				return await review(rest, io);
			case "launchers":
				return launchers(io);
			case undefined:
			case "help":
			case "--help":
			case "-h":
				io.out(USAGE);
				return 0;
			default:
				io.err(`Unknown command: ${command}\n${USAGE}`);
				return 2;
		}
	} catch (e) {
		io.err(`${(e as Error).message}\n`);
		return 1;
	}
}

function projectRoot(path: string | undefined, io: CliIO): string {
	const p = resolve(io.cwd, path ?? ".");
	return findGitRoot(p) ?? p;
}

function status(argv: string[], io: CliIO): number {
	const { values } = parseArgs({ args: argv, options: { path: { type: "string" } } });
	const root = projectRoot(values.path, io);
	const loaded = loadConfig({ home: io.home, env: io.env }, root);
	const layout = resolveLayout(root, loaded.config.repo);
	const en = decideEnablement({
		cwd: root,
		config: loaded.config,
		hasAdrFolder: hasAdrFolder(layout),
	});
	const missing = missingSettings(loaded.config, { needEndpoint: true });
	const lines = [
		`project:   ${root}`,
		`enabled:   ${en.enabled ? "yes" : "no"} (${en.reason})`,
		`adr_dir:   ${layout.adrDir} (${layout.source})`,
		`backlog:   ${layout.backlogDir}`,
		...layout.folders.slice(1).map((f) => `nested:    ${f.dir}`),
		`numbering: ${layout.numbering}`,
		`template:  ${layout.template ?? "(none)"}${layout.templateKind ? ` (${layout.templateKind})` : ""}`,
		`statuses:  ${layout.statuses.join(", ")}`,
		`config:    ${loaded.sources.join(", ") || `(none, expected ${userConfigPath({ home: io.home, env: io.env })})`}`,
		`models:    classifier=${loaded.config.classifier_model ?? "-"} reviewer=${loaded.config.reviewer_model ?? "-"}`,
		`review:    ${loaded.config.auto_review}, launcher ${launcherLine(loaded.config.review_launcher, io, loaded.config.review_command)}`,
	];
	if (missing.length) lines.push(`missing:   ${missing.join(", ")} (see README, "Configuration")`);
	for (const e of loaded.errors) lines.push(`error:     ${e}`);
	io.out(`${lines.join("\n")}\n`);
	return 0;
}

function buildClassifier(io: CliIO, root: string): Classifier {
	if (io.classifier) return io.classifier;
	const loaded = loadConfig({ home: io.home, env: io.env }, root);
	for (const e of loaded.errors) io.err(`config: ${e}\n`);
	const missing = missingSettings(loaded.config, { needEndpoint: true });
	if (missing.length) {
		throw new Error(
			`Missing required config: ${missing.join(", ")}. Add them to ${userConfigPath({ home: io.home, env: io.env })} (see README, "Configuration").`,
		);
	}
	const ep = loaded.config.model_endpoint;
	const model = loaded.config.classifier_model;
	if (!ep || !model) throw new Error("unreachable: config checked above");
	const apiKey = io.env[ep.api_key_env];
	if (!apiKey)
		throw new Error(
			`Environment variable ${ep.api_key_env} is not set (model_endpoint.api_key_env).`,
		);
	return createOpenAIClassifier({ baseUrl: ep.base_url, apiKey, model: endpointModelId(model) });
}

function short(s: string, n = 70): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function formatResult(r: ExchangeResult): string {
	const where = r.file ? ` -> ${r.file}` : r.duplicateOf ? ` (covered by ${r.duplicateOf})` : "";
	const what = r.summary ? `${r.target}/${r.confidence}: ${short(r.summary)}` : short(r.user);
	const err = r.error ? ` [${r.error}]` : "";
	return `  ${r.outcome.padEnd(12)} ${r.anchor}  ${what}${where}${err}`;
}

async function scan(argv: string[], io: CliIO): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			harness: { type: "string", default: "pi" },
			path: { type: "string" },
			since: { type: "string" },
			session: { type: "string" },
			"sessions-dir": { type: "string" },
			"dry-run": { type: "boolean", default: false },
			verbose: { type: "boolean", default: false },
		},
	});
	const sources = pickSources(values.harness ?? "pi", io);
	if (!sources) return 2;
	let since: Date | undefined;
	if (values.since) {
		since = new Date(values.since);
		if (Number.isNaN(since.getTime())) {
			io.err(`Bad --since date: ${values.since}\n`);
			return 2;
		}
	}
	const root = projectRoot(values.path, io);
	const loaded = loadConfig({ home: io.home, env: io.env }, root);
	const layout = resolveLayout(root, loaded.config.repo);
	const classifier = buildClassifier(io, root);

	const first = sources[0];
	const files: { file: string; source: SessionSource }[] =
		values.session && first
			? [{ file: resolve(io.cwd, values.session), source: first }]
			: sources.flatMap((src) =>
					src
						.findSessions(values["sessions-dir"] ?? src.sessionsDir(io.env, io.home), root, since)
						.map((s) => ({ file: s.file, source: src })),
				);
	if (!files.length) {
		io.out(`No ${sources.map((s) => s.name).join("/")} sessions found for ${root}\n`);
		return 0;
	}
	io.out(
		`${values["dry-run"] ? "Dry run: " : ""}${files.length} session(s), backlog ${layout.backlogDir}\n`,
	);

	const totals: Record<string, number> = {};
	for (const { file, source } of files) {
		const session = source.loadSession(file);
		const results = await scanSession(session, {
			layout,
			classifier,
			dryRun: values["dry-run"],
			home: io.home,
		});
		io.out(`${session.id}  ${session.started}  (${results.length} exchanges)\n`);
		for (const r of results) {
			totals[r.outcome] = (totals[r.outcome] ?? 0) + 1;
			if (values.verbose || r.outcome !== "no-trigger") io.out(`${formatResult(r)}\n`);
		}
	}
	const summary = Object.entries(totals)
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
	io.out(`Done: ${summary}\n`);
	return totals.error ? 1 : 0;
}

function pickSources(name: string, io: CliIO): SessionSource[] | undefined {
	if (name === "all") return listHarnesses().flatMap((h) => (h.sessions ? [h.sessions] : []));
	const h = getHarness(name);
	if (h?.sessions) return [h.sessions];
	if (PLANNED_HARNESSES.includes(name)) io.err(`--harness ${name} is not supported yet.\n`);
	else io.err(`Unknown harness: ${name}\n`);
	return undefined;
}

function launcherLine(name: string, io: CliIO, template?: string): string {
	try {
		const l = pickLauncher(name, io.env, template);
		return name === l.name ? name : `${name} -> ${l.name}`;
	} catch (e) {
		return `error: ${(e as Error).message}`;
	}
}

function launchers(io: CliIO): number {
	const auto = pickLauncher("auto", io.env).name;
	for (const l of listLaunchers()) {
		const mark = l.name === auto ? "*" : " ";
		io.out(`${mark} ${l.name.padEnd(9)} ${l.description}\n`);
	}
	io.out(
		`  command   review_command from the user config\n* = what review_launcher: auto picks here\n`,
	);
	return 0;
}

async function review(argv: string[], io: CliIO): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			path: { type: "string" },
			launcher: { type: "string" },
			harness: { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	const root = projectRoot(values.path, io);
	const loaded = loadConfig({ home: io.home, env: io.env }, root);
	for (const e of loaded.errors) io.err(`config: ${e}\n`);
	const config = values.harness
		? { ...loaded.config, review_harness: values.harness }
		: loaded.config;
	const started = await startReview({
		layout: resolveLayout(root, config.repo),
		config,
		sys: io.sys ?? nodeSystem(io.env),
		home: io.home,
		stateDir: stateDir({ home: io.home, env: io.env }),
		launcher: values.launcher,
		dryRun: values["dry-run"],
	});
	if (!started) {
		io.out("No open notes in the backlog.\n");
		return 0;
	}
	io.out(`${started.notes} open note(s); report ${started.reportPath}\n`);
	if (started.fallbackReason)
		io.err(`launcher failed (${started.fallbackReason}); running headless\n`);
	io.out(`launcher: ${started.launcher}, ${started.where}\n`);
	if (values["dry-run"]) {
		io.out(`command:  ${started.job.command}\nheadless: ${started.job.headlessCommand}\n`);
	}
	return 0;
}
