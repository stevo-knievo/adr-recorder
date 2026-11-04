import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Document, parseDocument } from "yaml";
import {
	type Config,
	type ConfigEnv,
	decideEnablement,
	type Enablement,
	loadConfig,
	missingSettings,
	REPO_CONFIG_FILE,
} from "./config.ts";
import { findGitRoot, hasAdrFolder, type Layout, resolveLayout } from "./layout.ts";
import { type BacklogEntry, type Note, noteId, readBacklog, writeNote } from "./notes.ts";
import { openNotes } from "./review.ts";

/** A repo as the recorder sees it: config, layout. Every adapter starts here. */
export interface Project {
	root: string;
	config: Config;
	configErrors: string[];
	layout: Layout;
}

export function loadProject(cwd: string, env: ConfigEnv): Project {
	const root = findGitRoot(cwd) ?? cwd;
	const loaded = loadConfig(env, root);
	return {
		root,
		config: loaded.config,
		configErrors: loaded.errors,
		layout: resolveLayout(root, loaded.config.repo),
	};
}

export function projectEnablement(
	p: Project,
	opts: { override?: boolean; reviewChild?: boolean } = {},
): Enablement {
	return decideEnablement({
		cwd: p.root,
		config: p.config,
		hasAdrFolder: hasAdrFolder(p.layout),
		sessionOverride: opts.override,
		reviewChild: opts.reviewChild,
	});
}

/** Notes written from one session, across all backlog folders of the repo. */
export function sessionNotes(p: Project, harness: string, sessionId: string): BacklogEntry[] {
	const prefix = noteId(harness, sessionId, "");
	return p.layout.folders
		.flatMap((f) => readBacklog(p.root, f.backlog))
		.filter((n) => n.id.startsWith(prefix));
}

export function statusReport(
	p: Project,
	en: Enablement,
	session: { harness: string; id: string },
	opts: { needEndpoint: boolean },
): string {
	const notes = sessionNotes(p, session.harness, session.id);
	const missing = missingSettings(p.config, opts);
	return [
		`ADR recorder: ${en.enabled ? "on" : "off"} (${en.reason})`,
		`adr_dir: ${p.layout.adrDir} (${p.layout.source}), backlog ${p.layout.backlogDir}`,
		`notes this session: ${notes.length}, open in repo: ${openNotes(p.layout).length}`,
		`models: classifier=${p.config.classifier_model ?? "-"} reviewer=${p.config.reviewer_model ?? "-"}`,
		`auto_review: ${p.config.auto_review}`,
		...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
		...p.configErrors.map((e) => `config error: ${e}`),
	].join("\n");
}

/** Set adr_dir in the repo's .adr-recorder.yaml, keeping its comments. */
export function setRepoAdrDir(root: string, dir: string): void {
	const file = join(root, REPO_CONFIG_FILE);
	const doc = existsSync(file) ? parseDocument(readFileSync(file, "utf8")) : undefined;
	if (doc?.contents) {
		doc.set("adr_dir", dir);
		writeFileSync(file, doc.toString());
	} else writeFileSync(file, new Document({ adr_dir: dir }).toString());
}

/** A decision the human states by hand (`/adr note`). No model call. */
export function writeManualNote(
	p: Project,
	input: {
		harness: string;
		sessionId: string;
		sessionFile: string;
		anchor: string;
		text: string;
		now?: Date;
	},
): string | undefined {
	const now = input.now ?? new Date();
	const note: Note = {
		id: noteId(input.harness, input.sessionId, `manual-${now.getTime().toString(36)}`),
		captured: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
		harness: input.harness,
		session: input.sessionId,
		session_file: input.sessionFile,
		anchor: input.anchor,
		adr_dir: p.layout.adrDir,
		proposed_target: "adr",
		confidence: "high",
		decided_by: "human",
		signals: ["manual"],
		related: [],
		status: "open",
		decision: input.text,
		why: "Recorded by hand.",
		alternatives: [],
		quote: input.text,
	};
	return writeNote(p.root, p.layout.backlogDir, note, { date: now })?.file;
}
