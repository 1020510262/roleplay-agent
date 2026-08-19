import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export type CompatibleApi = "openai-completions";

export interface ModelProfileInput {
	name: string;
	baseUrl: string;
	apiKey: string;
	modelId: string;
	api: CompatibleApi;
	contextWindow: number;
	maxTokens: number;
}

export interface ModelProfile extends ModelProfileInput {
	id: string;
	providerId: string;
	builtIn: boolean;
}

export interface PublicModelProfile {
	id: string;
	name: string;
	baseUrl: string;
	modelId: string;
	api: CompatibleApi;
	contextWindow: number;
	maxTokens: number;
	builtIn: boolean;
	hasApiKey: boolean;
}

interface StoredSettings {
	version: 1;
	activeId: string;
	models: ModelProfile[];
}

const BUILTIN_ID = "builtin-default";

function cleanString(value: unknown, label: string, max: number): string {
	if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
	const clean = value.trim();
	if (!clean) throw new Error(`${label} 不能为空`);
	if (clean.length > max) throw new Error(`${label} 不能超过 ${max} 个字符`);
	if(/[\u0000-\u001f\u007f]/.test(clean)) throw new Error(`${label} 包含非法控制字符`);
	return clean;
}

function cleanInteger(value: unknown, label: string, min: number, max: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(n) || n < min || n > max) {
		throw new Error(`${label} 必须是 ${min}～${max} 的整数`);
	}
	return n;
}

function normalizeBaseUrl(value: unknown): string {
	const raw = cleanString(value, "API URL", 500).replace(/\/+$/, "");
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("API URL 格式无效");
	}
	const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
		throw new Error("API URL 必须使用 HTTPS（本机回环测试可使用 HTTP）");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("API URL 不能包含账号、查询参数或锚点");
	}
	return parsed.toString().replace(/\/$/, "");
}

export function validateModelProfileInput(value: unknown): ModelProfileInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型配置格式无效");
	const raw = value as Record<string, unknown>;
	const api = cleanString(raw.api ?? "openai-completions", "API 类型", 64);
	if (api !== "openai-completions") throw new Error("目前仅支持 openai-completions（OpenAI 兼容 Chat Completions）");
	const contextWindow = cleanInteger(raw.contextWindow, "上下文长度", 1024, 10_000_000);
	const maxTokens = cleanInteger(raw.maxTokens ?? Math.min(8192, contextWindow), "最大输出长度", 1, contextWindow);
	return {
		name: cleanString(raw.name, "显示名称", 80),
		baseUrl: normalizeBaseUrl(raw.baseUrl),
		apiKey: cleanString(raw.apiKey, "API Key", 1000),
		modelId: cleanString(raw.modelId, "模型 ID", 200),
		api: "openai-completions",
		contextWindow,
		maxTokens,
	};
}

function profileId(input: Pick<ModelProfileInput, "baseUrl" | "modelId">): string {
	return `custom-${createHash("sha256").update(`${input.baseUrl}\0${input.modelId}`).digest("hex").slice(0, 16)}`;
}

function publicProfile(profile: ModelProfile): PublicModelProfile {
	const { apiKey, providerId: _providerId, ...rest } = profile;
	return { ...rest, hasApiKey: apiKey.length > 0 };
}

function builtInProfile(): ModelProfile {
	let configured: { baseUrl?: string; api?: string; models?: Array<{ id?: string; name?: string; contextWindow?: number; maxTokens?: number }> } = {};
	try {
		const catalog = JSON.parse(fs.readFileSync(config.paths.modelsJson, "utf8")) as {
			providers?: Record<string, typeof configured>;
		};
		configured = catalog.providers?.[config.model.provider] ?? {};
	} catch {
		/* Config validation below will produce a useful error if it is used. */
	}
	const model = configured.models?.find((m) => m.id === config.model.id);
	return {
		id: BUILTIN_ID,
		providerId: config.model.provider,
		name: model?.name ?? config.model.id,
		baseUrl: configured.baseUrl ?? "",
		apiKey: config.model.apiKey,
		modelId: config.model.id,
		api: configured.api === "openai-completions" ? configured.api : "openai-completions",
		contextWindow: model?.contextWindow ?? 1_000_000,
		maxTokens: model?.maxTokens ?? 8192,
		builtIn: true,
	};
}

function readSettings(): StoredSettings {
	try {
		const parsed = JSON.parse(fs.readFileSync(config.paths.modelSettingsJson, "utf8")) as StoredSettings;
		if (parsed.version !== 1 || !Array.isArray(parsed.models) || typeof parsed.activeId !== "string") throw new Error("格式错误");
		return parsed;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error("[models] 无法读取模型设置，回退到内置模型:", (err as Error).message);
		}
		return { version: 1, activeId: BUILTIN_ID, models: [] };
	}
}

let settings = readSettings();

function writeSettings(next: StoredSettings): void {
	fs.mkdirSync(path.dirname(config.paths.modelSettingsJson), { recursive: true });
	const tmp = `${config.paths.modelSettingsJson}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(tmp, config.paths.modelSettingsJson);
	fs.chmodSync(config.paths.modelSettingsJson, 0o600);
	settings = next;
}

export function listModelProfiles(): { activeId: string; models: PublicModelProfile[] } {
	const models = [builtInProfile(), ...settings.models];
	const activeId = models.some((m) => m.id === settings.activeId) ? settings.activeId : BUILTIN_ID;
	return { activeId, models: models.map(publicProfile) };
}

export function getActiveModelProfile(): ModelProfile {
	if (settings.activeId === BUILTIN_ID) return builtInProfile();
	return settings.models.find((m) => m.id === settings.activeId) ?? builtInProfile();
}

export function getModelProfile(id: string): ModelProfile {
	if (id === BUILTIN_ID) return builtInProfile();
	const found = settings.models.find((m) => m.id === id);
	if (!found) throw new Error("模型不存在");
	return found;
}

export function saveModelProfile(value: unknown): PublicModelProfile {
	const input = validateModelProfileInput(value);
	const id = profileId(input);
	const profile: ModelProfile = { ...input, id, providerId: id, builtIn: false };
	const models = [...settings.models];
	const idx = models.findIndex((m) => m.id === id);
	if (idx === -1) models.push(profile);
	else models[idx] = profile;
	writeSettings({ ...settings, models });
	return publicProfile(profile);
}

export function setActiveModelProfile(id: string): PublicModelProfile {
	const profile = getModelProfile(cleanString(id, "模型 ID", 100));
	writeSettings({ ...settings, activeId: profile.id });
	return publicProfile(profile);
}

function safeRemoteMessage(body: unknown, secret: string): string {
	if (!body || typeof body !== "object") return "";
	const obj = body as { error?: unknown; message?: unknown };
	const candidate = typeof obj.error === "object" && obj.error
		? (obj.error as { message?: unknown }).message
		: obj.error ?? obj.message;
	return typeof candidate === "string"
		? candidate.replaceAll(secret, "[REDACTED]").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240)
		: "";
}

export class ModelConnectionError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = "ModelConnectionError";
	}
}

export async function testModelConnection(value: unknown, timeoutMs = 20_000): Promise<{ latencyMs: number }> {
	const input = validateModelProfileInput(value);
	const started = Date.now();
	let response: Response;
	try {
		response = await fetch(`${input.baseUrl}/chat/completions`, {
			method: "POST",
			redirect: "error",
			headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: input.modelId,
				messages: [{ role: "user", content: "Reply with OK." }],
				max_tokens: 8,
				stream: false,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		const message = (err as Error).name === "TimeoutError" ? "连接模型超时" : `无法连接模型服务：${(err as Error).message}`;
		throw new ModelConnectionError(message);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	if (!response.ok) {
		const detail = safeRemoteMessage(body, input.apiKey);
		throw new ModelConnectionError(`模型服务返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`, response.status);
	}
	const choices = (body as { choices?: unknown } | undefined)?.choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		throw new ModelConnectionError("模型服务已响应，但返回内容不是兼容的 Chat Completions 格式");
	}
	return { latencyMs: Date.now() - started };
}
