import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

let runtimePromise: Promise<ModelRuntime> | undefined;

/**
 * Shared ModelRuntime instance. Loads our custom provider catalog from
 * data/models.json (Aliyun MaaS / DeepSeek). Auth comes from the
 * $ALIYUN_MAAS_API_KEY env interpolation in models.json; we also set it as a
 * runtime override so .env stays the single source of truth.
 */
export async function getModelRuntime(): Promise<ModelRuntime> {
	if (!runtimePromise) {
		runtimePromise = (async () => {
			fs.mkdirSync(path.dirname(config.paths.authJson), { recursive: true });
			const rt = await ModelRuntime.create({
				authPath: config.paths.authJson,
				modelsPath: config.paths.modelsJson,
			});
			await rt.setRuntimeApiKey(config.model.provider, config.model.apiKey);
			return rt;
		})();
	}
	return runtimePromise;
}

/** Resolve the main conversation model. */
export async function getMainModel(): Promise<Model<Api>> {
	const rt = await getModelRuntime();
	const model = rt.getModel(config.model.provider, config.model.id);
	if (!model) {
		throw new Error(`Model not found: ${config.model.provider}/${config.model.id}`);
	}
	return model as Model<Api>;
}

/** Resolve the utility model used for separated background calls. */
export async function getUtilityModel(): Promise<Model<Api>> {
	const rt = await getModelRuntime();
	const model = rt.getModel(config.model.utilityProvider, config.model.utilityId);
	if (!model) {
		throw new Error(`Utility model not found: ${config.model.utilityProvider}/${config.model.utilityId}`);
	}
	return model as Model<Api>;
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
