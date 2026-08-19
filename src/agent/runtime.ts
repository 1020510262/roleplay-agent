import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getActiveModelProfile } from "./model-settings.js";

let runtimePromise: Promise<ModelRuntime> | undefined;

/** Shared runtime generated from the currently active built-in/custom profile. */
export async function getModelRuntime(): Promise<ModelRuntime> {
	if (!runtimePromise) {
		runtimePromise = (async () => {
			const active = getActiveModelProfile();
			fs.mkdirSync(path.dirname(config.paths.authJson), { recursive: true });
			const catalog = {
				providers: {
					[active.providerId]: {
						...(active.baseUrl ? { baseUrl: active.baseUrl } : {}),
						api: active.api,
						compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
						models: [{
							id: active.modelId,
							name: active.name,
							reasoning: false,
							input: ["text"],
							contextWindow: active.contextWindow,
							maxTokens: active.maxTokens,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						}],
					},
				},
			};
			fs.writeFileSync(config.paths.runtimeModelsJson, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
			const rt = await ModelRuntime.create({
				authPath: config.paths.authJson,
				modelsPath: config.paths.runtimeModelsJson,
			});
			await rt.setRuntimeApiKey(active.providerId, active.apiKey);
			return rt;
		})();
	}
	return runtimePromise;
}

/** Resolve the main conversation model. */
export async function getMainModel(): Promise<Model<Api>> {
	const rt = await getModelRuntime();
	const active = getActiveModelProfile();
	const model = rt.getModel(active.providerId, active.modelId);
	if (!model) {
		throw new Error(`Model not found: ${active.providerId}/${active.modelId}`);
	}
	return model as Model<Api>;
}

/** Resolve the utility model used for separated background calls. */
export async function getUtilityModel(): Promise<Model<Api>> {
	const rt = await getModelRuntime();
	const active = getActiveModelProfile();
	const model = rt.getModel(active.providerId, active.modelId);
	if (!model) {
		throw new Error(`Utility model not found: ${active.providerId}/${active.modelId}`);
	}
	return model as Model<Api>;
}

/** Drop the cached runtime after a model switch. Existing sessions must be disposed first. */
export function resetModelRuntime(): void {
	runtimePromise = undefined;
}

/**
 * Separated one-shot model call (memory extraction, persona checks).
 * Runs outside the pi agent session so it never touches the main
 * conversation context.
 */
export async function completeSeparate(
	context: { systemPrompt?: string; messages: Context["messages"] },
	options?: { maxTokens?: number; signal?: AbortSignal },
): Promise<AssistantMessage> {
	const rt = await getModelRuntime();
	const model = await getUtilityModel();
	return rt.complete(model, { systemPrompt: context.systemPrompt, messages: context.messages }, {
		maxTokens: options?.maxTokens ?? 1500,
		signal: options?.signal,
		sessionId: `rp-utility-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	});
}

/** Collect the text of an assistant message. */
export function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}
