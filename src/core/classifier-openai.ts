import {
	buildClassifierPrompt,
	type Classification,
	type Classifier,
	type ClassifierInput,
	parseClassifications,
} from "./detect.ts";

export interface OpenAIClassifierOptions {
	baseUrl: string;
	apiKey: string;
	/** Model id as the endpoint knows it. */
	model: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
}

/**
 * pi model specs look like "provider/model". An OpenAI-compatible endpoint
 * only wants the model part.
 */
export function endpointModelId(spec: string): string {
	const i = spec.indexOf("/");
	return i < 0 ? spec : spec.slice(i + 1);
}

/** Classifier for the CLI and hooks: any OpenAI-compatible /chat/completions endpoint. */
export function createOpenAIClassifier(opts: OpenAIClassifierOptions): Classifier {
	const doFetch = opts.fetch ?? fetch;
	return {
		async classify(input: ClassifierInput, signal?: AbortSignal): Promise<Classification[]> {
			const prompt = buildClassifierPrompt(input);
			const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
			const res = await doFetch(`${opts.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
				body: JSON.stringify({
					model: opts.model,
					temperature: 0,
					response_format: { type: "json_object" },
					messages: [
						{ role: "system", content: prompt.system },
						{ role: "user", content: prompt.user },
					],
				}),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			if (!res.ok) {
				const body = (await res.text()).slice(0, 300);
				throw new Error(`classifier HTTP ${res.status}: ${body}`);
			}
			const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
			const text = data.choices?.[0]?.message?.content;
			if (!text) throw new Error("classifier returned no content");
			return parseClassifications(text, input.exchange.user);
		},
	};
}
