import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statusText } from "../core/status.ts";

const STATUS_KEY = "adr-recorder";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, statusText(true));
	});
}
