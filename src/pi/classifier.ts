import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildClassifierPrompt, type Classifier, parseClassifications } from "../core/detect.ts";

/** "provider/model" -> parts. A bare id searches every provider. */
export function splitModelSpec(spec: string): { provider?: string; id: string } {
	const i = spec.indexOf("/");
	return i < 0 ? { id: spec } : { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}

/** Classifier that goes through pi's own providers and auth. */
export function createPiClassifier(ctx: ExtensionContext, spec: string): Classifier {
	const { provider, id } = splitModelSpec(spec);
	const registry = ctx.modelRegistry;
	const model = provider
		? registry.find(provider, id)
		: registry.getAvailable().find((m) => m.id === id);
	if (!model)
		throw new Error(`classifier_model ${spec} is not a model pi knows (see pi --list-models)`);
	return {
		async classify(input, signal) {
			const prompt = buildClassifierPrompt(input);
			const reply = await registry.complete(
				model,
				{
					systemPrompt: prompt.system,
					messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }],
				},
				{ signal: signal ?? AbortSignal.timeout(60_000) },
			);
			if (reply.stopReason === "error" || reply.stopReason === "aborted") {
				throw new Error(reply.errorMessage ?? `classifier ${reply.stopReason}`);
			}
			const text = reply.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text: string }).text)
				.join("");
			return parseClassifications(text, input.exchange.user);
		},
	};
}
