/** Status line text. Pure, so it can be tested without pi. */
export function statusText(active: boolean, notes = 0): string | undefined {
	if (!active) return undefined;
	return notes > 0 ? `ADR rec ● ${notes}` : "ADR rec ●";
}
