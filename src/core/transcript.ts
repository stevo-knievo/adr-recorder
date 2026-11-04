import type { Exchange, Turn } from "./types.ts";

export function toExchanges(turns: Turn[]): Exchange[] {
	const out: Exchange[] = [];
	let cur: Exchange | undefined;
	let lastText = "";
	let prevFinal = "";
	for (const t of turns) {
		if (t.role === "user") {
			if (cur) {
				out.push(cur);
				prevFinal = lastText;
			}
			lastText = "";
			cur = {
				anchor: t.anchor,
				ts: t.ts,
				user: t.text,
				assistant: "",
				previousAssistant: prevFinal,
				toolCalls: [],
			};
			continue;
		}
		if (!cur) continue; // assistant text before any user message
		if (t.text) {
			cur.assistant = cur.assistant ? `${cur.assistant}\n\n${t.text}` : t.text;
			lastText = t.text;
		}
		cur.toolCalls.push(...t.toolCalls);
	}
	if (cur) out.push(cur);
	return out;
}
