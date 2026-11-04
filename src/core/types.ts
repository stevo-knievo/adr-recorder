export const HARNESSES = ["pi", "claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Routing table targets, see docs/how-to-document.md. */
export const TARGETS = [
	"adr",
	"rfc",
	"spec",
	"runbook",
	"standard",
	"agents",
	"decision_log",
	"readme",
	"glossary",
	"tooling",
	"discard",
] as const;
export type Target = (typeof TARGETS)[number];

/** Targets that live in a file or folder the layout resolves. */
export type DocTarget = Exclude<Target, "adr" | "tooling" | "discard">;

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const NOTE_STATUSES = ["open", "promoted", "moved", "merged", "discarded"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export type DecidedBy = "human" | "agent";

export interface ToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** One normalized message from any harness. */
export interface Turn {
	role: "user" | "assistant";
	text: string;
	toolCalls: ToolCall[];
	ts: string;
	anchor: string;
}

export interface Session {
	harness: Harness;
	id: string;
	file: string;
	cwd: string;
	started: string;
	turns: Turn[];
}

/** One user message plus everything the agent did until the next user message. */
export interface Exchange {
	anchor: string;
	ts: string;
	user: string;
	assistant: string;
	/** Final assistant text of the previous exchange (for "yes" / "do 2" replies). */
	previousAssistant: string;
	toolCalls: ToolCall[];
}
