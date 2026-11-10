import { type Config, missingSettings } from "./config.ts";
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

/**
 * The classifier for adapters that can't use their host's model access (the
 * CLI, Claude Code hooks): `model_endpoint` plus `classifier_model`. Throws a
 * message meant for the human when something is missing.
 */
export function classifierFromConfig(
	config: Config,
	env: Record<string, string | undefined>,
	configPath: string,
): Classifier {
	const missing = missingSettings(config, { needEndpoint: true });
	if (missing.length) {
		throw new Error(
			`Missing required config: ${missing.join(", ")}. Add them to ${configPath} (see README, "Configuration").`,
		);
	}
	const ep = config.model_endpoint;
	const model = config.classifier_model;
	if (!ep || !model) throw new Error("unreachable: config checked above");
	const apiKey = env[ep.api_key_env];
	if (!apiKey)
		throw new Error(
			`Environment variable ${ep.api_key_env} is not set (model_endpoint.api_key_env).`,
		);
	const baseUrl = ep.base_url_env ? env[ep.base_url_env]?.trim() : ep.base_url;
	if (!baseUrl)
		throw new Error(
			`Environment variable ${ep.base_url_env} is not set (model_endpoint.base_url_env).`,
		);
	return createOpenAIClassifier({
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey,
		model: endpointModelId(model),
	});
}
