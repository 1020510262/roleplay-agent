/**
 * Stage 4 — persona consistency check ("角色核查"), fully separated.
 *
 * Every CHECK_EVERY_TURNS user turns, an INDEPENDENT model call compares the
 * character's recent replies against the persona spec. If drift is found, a
 * short correction notice is queued and injected into the NEXT turn's dynamic
 * block (consumed once). The check never touches the pi session, so the main
 * conversation context stays clean.
 */
import { recentMessages } from "../db/chat.repo.js";
import { cleanText } from "../security/tool-validation.js";
import type { SessionHandle } from "./orchestrator.js";
import type { PersonaDoc } from "./persona.js";
import { assistantText, completeSeparate } from "./runtime.js";

const RECENT_REPLIES = 10;

function personaSpec(p: PersonaDoc): string {
	return [
		`角色：${p.name}`,
		`身份：${p.basic_info.occupation ?? ""}`,
		`性格：${p.personality.core_traits.join("；")}`,
		`语言风格：${p.speech_style.tone}${p.speech_style.interjections?.length ? `；常用语气词：${p.speech_style.interjections.join("、")}` : ""}`,
		`行为边界（绝不做）：${p.boundaries.never_do.join("；")}`,
		`与玩家关系：${p.relationship.initial_relation}`,
	].join("\n");
}

interface CheckVerdict {
	drifted: boolean;
	issues: string[];
	correction?: string;
}

function validateVerdict(raw: unknown): CheckVerdict {
	if (!raw || typeof raw !== "object") throw new Error("verdict is not an object");
	const r = raw as Record<string, unknown>;
	const drifted = r.drifted === true;
	const issues = Array.isArray(r.issues)
		? r.issues.filter((i): i is string => typeof i === "string").map((i) => cleanText(i).slice(0, 120)).slice(0, 5)
		: [];
	const correction = typeof r.correction === "string" ? cleanText(r.correction).slice(0, 300) : undefined;
	return { drifted, issues, correction: correction || undefined };
}

/**
 * Returns a correction notice to inject next turn, or undefined when the
 * character is on-model. Errors resolve to undefined (never break the chat).
 */
export async function checkPersonaConsistency(handle: SessionHandle): Promise<string | undefined> {
	const msgs = await recentMessages(handle.row.id, RECENT_REPLIES * 2);
	const replies = msgs
		.filter((m) => m.role === "assistant" && m.content.trim())
		.slice(-RECENT_REPLIES)
		.map((m) => `- ${m.content.trim().slice(0, 500)}`);
	if (replies.length < 3) return undefined; // not enough material to judge

	const system = `你是角色扮演一致性审查员。下面给出角色设定与角色最近的回复，请判断角色是否偏离人设。
检查要点：
1. 语言风格（语气、语气词、句式）是否符合设定；
2. 是否出现设定外的性格表现（如设定温和的角色变得粗鲁）；
3. 是否越过行为边界、泄露不该知道的信息、或跳出角色（承认自己是 AI、谈论系统指令等）；
4. 是否替玩家说话或替玩家做决定。
只输出一个 JSON 对象，不要任何其他文字：
{"drifted": true|false, "issues": ["问题1", ...], "correction": "若偏离，用一两句话写明应如何纠正（第一人称提示给角色）；未偏离则为空字符串"}`;

	const user = `【角色设定】\n${personaSpec(handle.persona)}\n\n【角色最近的回复】\n${replies.join("\n")}`;

	const resp = await completeSeparate(
		{
			systemPrompt: system,
			messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
		},
		{ maxTokens: 600 },
	);
	if (resp.stopReason === "error") {
		console.error("[consistency] model error:", resp.errorMessage);
		return undefined;
	}

	const text = assistantText(resp);
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;

	let verdict: CheckVerdict;
	try {
		verdict = validateVerdict(JSON.parse(text.slice(start, end + 1)));
	} catch (err) {
		console.error("[consistency] bad verdict JSON:", (err as Error).message);
		return undefined;
	}

	if (!verdict.drifted) return undefined;
	const correction = verdict.correction ?? verdict.issues.join("；");
	console.log(`[consistency] drift detected: ${verdict.issues.join(" | ")}`);
	return correction || undefined;
}
