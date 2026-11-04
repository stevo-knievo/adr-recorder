import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createOpenAIClassifier, endpointModelId } from "./core/classifier-openai.ts";
import { decideEnablement, loadConfig, missingSettings, userConfigPath } from "./core/config.ts";
import type { Classifier } from "./core/detect.ts";
import { findGitRoot, hasAdrFolder, resolveLayout } from "./core/layout.ts";
import {
	type ExchangeResult,
	findPiSessions,
	loadPiSession,
	piSessionsDir,
	scanSession,
} from "./core/scan.ts";

const USAGE = `Usage: adr-recorder <command> [options]

Commands:
  scan      Find decisions in past sessions and write backlog notes
  status    Show the resolved layout, config and enablement for a project
  version   Print the version

scan options:
  --harness <pi|claude-code|codex|all>  Session source (default: pi)
  --path <dir>                          Project folder (default: current folder)
  --since <YYYY-MM-DD>                  Only sessions started on or after this date
  --session <file>                      Scan one session file instead of searching
  --sessions-dir <dir>                  Override the pi sessions folder
  --dry-run                             Classify, but don't write notes
  --verbose                             Show every exchange, not only hits
`;

export interface CliIO {
	out: (s: string) => void;
	err: (s: string) => void;
	env: Record<string, string | undefined>;
	home: string;
	cwd: string;
	/** Tests inject a fake classifier. */
	classifier?: Classifier;
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
	const harness = values.harness ?? "pi";
	if (harness === "claude-code" || harness === "codex") {
		io.err(`--harness ${harness} is not supported yet.\n`);
		return 2;
	}
	if (harness !== "pi" && harness !== "all") {
		io.err(`Unknown harness: ${harness}\n`);
		return 2;
	}
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

	const files = values.session
		? [resolve(io.cwd, values.session)]
		: findPiSessions(values["sessions-dir"] ?? piSessionsDir(io.env, io.home), root, since).map(
				(s) => s.file,
			);
	if (!files.length) {
		io.out(`No pi sessions found for ${root}\n`);
		return 0;
	}
	io.out(
		`${values["dry-run"] ? "Dry run: " : ""}${files.length} session(s), backlog ${layout.backlogDir}\n`,
	);

	const totals: Record<string, number> = {};
	for (const file of files) {
		const session = loadPiSession(file);
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
