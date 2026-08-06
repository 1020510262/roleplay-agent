/**
 * Separated memory extraction ("分离式").
 *
 * Both extractors run as INDEPENDENT model calls through modelRuntime —
 * they never enter the main conversation context, so they cannot pollute
 * the roleplay thread.
 *
 *   extractTurn            — after each turn, distill the last exchange
 *   extractBeforeCompaction— before pi drops old context, salvage it
 */
import { applyScenePatch } from "../db/scene.repo.js";
import { insertMemory } from "../db/memory.repo.js";
import { assistantText, completeSeparate } from "./runtime.js";
import {
	LIMITS,
	optionalString,
	requireIdentifierList,
	requireImportance,
	requireKind,
	requireString,
	ValidationReject,
} from "../security/tool-validation.js";
import { config } from "../config.js";

interface ExtractedMemory {
	summary: string;
	kind: string;
	entities: string[];
	tags: string[];
	importance: number;
}

interface ExtractionResult {
	memories: ExtractedMemory[];
	scene_update?: {
		location?: string;
		time_label?: string;
		mood?: string;
		ongoing_events?: string;
		relationship_delta?: number;
		relationship_note?: string;
	};
}

/** Lenient JSON extraction: strips code fences, finds first {...} block. */
function parseJsonLoose(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced ? fenced[1] : text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("no JSON object in model output");
	return JSON.parse(candidate.slice(start, end + 1));
}

function validateExtraction(raw: unknown): ExtractionResult {
	if (!raw || typeof raw !== "object") throw new ValidationReject("extraction is not an object");
	const r = raw as Record<string, unknown>;
	const list = Array.isArray(r.memories) ? r.memories : [];
	if (list.length > 6) throw new ValidationReject("too many memories");
	const memories: ExtractedMemory[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const m = item as Record<string, unknown>;
		memories.push({
			summary: requireString(m.summary, "summary", LIMITS.summaryMax, { min: 6 }),
			kind: requireKind(m.kind ?? "event"),
			entities: requireIdentifierList(m.entities, "entities", LIMITS.entityCountMax, LIMITS.entityMax),
			tags: requireIdentifierList(m.tags, "tags", LIMITS.tagCountMax, LIMITS.tagMax),
			importance: m.importance === undefined ? 2 : requireImportance(m.importance),
		});
	}

	let scene_update: ExtractionResult["scene_update"];
	if (r.scene_update && typeof r.scene_update === "object") {
		const s = r.scene_update as Record<string, unknown>;
		const delta = typeof s.relationship_delta === "number" && Number.isFinite(s.relationship_delta)
			? Math.max(-5, Math.min(5, Math.round(s.relationship_delta)))
			: undefined;
		scene_update = {
			location: optionalString(s.location, "location", LIMITS.locationMax),
			time_label: optionalString(s.time_label, "time_label", LIMITS.timeLabelMax),
			mood: optionalString(s.mood, "mood", LIMITS.moodMax),
			ongoing_events: optionalString(s.ongoing_events, "ongoing_events", LIMITS.eventMax),
			relationship_delta: delta,
			relationship_note: optionalString(s.relationship_note, "relationship_note", LIMITS.relationshipNoteMax),
		};
		if (Object.values(scene_update).every((v) => v === undefined)) scene_update = undefined;
	}
	return { memories, scene_update };
}

const EXTRACT_SYSTEM = `你是剧情记忆抽取器。从给定的角色扮演对话片段中抽取值得长期记住的信息。
只输出一个 JSON 对象，不要输出任何其他文字，不要用 markdown 代码块。格式：
{"memories":[{"summary":"一条自包含的中文陈述句","kind":"event|relationship|foreshadow|fact","entities":["人名或物名"],"tags":["主题"],"importance":1到5}],
 "scene_update":{"location":"...","time_label":"...","mood":"...","ongoing_events":"...","relationship_delta":-5到5的整数,"relationship_note":"..."} 或 null}
规则：
- 只记录有长期剧情价值的内容（承诺、秘密、伏笔、关系变化、关键事实）；没有就输出 {"memories":[],"scene_update":null}。
- summary 写客观事实，不要复制对话原文，不要出现"玩家说我"之外的引导词。
- scene_update 只在场景/时间/情绪/关系确实变化时给出，且只包含变化的字段。`;

async function runExtraction(conversationText: string, source: "turn" | "compaction", sessionId: string, signal?: AbortSignal): Promise<void> {
	const resp = await completeSeparate(
		{
			systemPrompt: EXTRACT_SYSTEM,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: `<对话片段>\n${conversationText}\n</对话片段>` }],
					timestamp: Date.now(),
				},
			],
		},
		{ maxTokens: 1200, signal },
	);
	if (resp.stopReason === "error") {
		console.error(`[extract:${source}] model error:`, resp.errorMessage);
		return;
	}
	const text = assistantText(resp);
	if (!text) return;

	let parsed: ExtractionResult;
	try {
		parsed = validateExtraction(parseJsonLoose(text));
	} catch (err) {
		console.error(`[extract:${source}] rejected model output:`, (err as Error).message);
		return;
	}

	for (const m of parsed.memories) {
		try {
			await insertMemory({ sessionId, ...m, source });
		} catch (err) {
			console.error(`[extract:${source}] insert failed:`, (err as Error).message);
		}
	}
	if (parsed.scene_update) {
		try {
			await applyScenePatch(sessionId, parsed.scene_update);
		} catch (err) {
			console.error(`[extract:${source}] scene patch failed:`, (err as Error).message);
		}
	}
}

/**
 * Serialize pi AgentMessages into readable conversation text for the
 * extraction prompt. Only text content; tool internals are skipped.
 * Defensive on purpose: AgentMessage is a union that includes non-chat rows.
 */
function serializeMessages(messages: unknown[]): string {
	const lines: string[] = [];
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const m = raw as { role?: unknown; content?: unknown };
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text = typeof m.content === "string" ? m.content : extractTextBlocks(m.content);
		if (!text.trim()) continue;
		lines.push(`${m.role === "user" ? "玩家" : "角色"}: ${text.trim()}`);
	}
	return lines.join("\n");
}

function extractTextBlocks(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
		.map((b) => b.text)
		.join("\n");
}

/** Turn-end extraction for the latest exchange. Fire-and-forget upstream. */
export async function extractTurn(sessionId: string, userText: string, replyText: string, signal?: AbortSignal): Promise<void> {
	if (!config.app.extractEveryTurn) return;
	const snippet = `玩家: ${userText}\n角色: ${replyText}`.slice(0, 6000);
	await runExtraction(snippet, "turn", sessionId, signal);
}

/** Pre-compaction salvage: pi is about to drop these messages. */
export async function extractBeforeCompaction(sessionId: string, doomedMessages: unknown[], signal?: AbortSignal): Promise<void> {
	const text = serializeMessages(doomedMessages);
	if (!text.trim()) return;
	// Bounded input for the utility model.
	await runExtraction(text.slice(0, 60000), "compaction", sessionId, signal);
}

// re-export for tests
export { assistantText };
