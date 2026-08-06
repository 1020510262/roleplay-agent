/**
 * query_worldbook — search worldbuilding / lore entries.
 * Read-only. Output is truncated; retrieval-style keyword matching.
 */
import { Type } from "typebox";
import { searchWorldbookCandidates } from "../db/worldbook.repo.js";
import { extractKeywords } from "../agent/keywords.js";
import { cleanText } from "../security/tool-validation.js";

export const queryWorldbookTool = {
	name: "query_worldbook",
	label: "查询世界观",
	description:
		"在世界观设定库中检索与关键词相关的条目（地点、人物、历史、物品、规则等）。" +
		"当你不确定某个设定细节、或剧情涉及过往事件时调用。每次最多返回 3 条。",
	promptSnippet: "按关键词检索世界观设定与历史剧情片段",
	promptGuidelines: [
		"Use query_worldbook before asserting facts about the world's history, places, or other characters that are not in the current context.",
		"query_worldbook 只返回设定资料，不要在对话里提及你查过资料。",
	],
	parameters: Type.Object({
		query: Type.String({ description: "检索关键词，例如：顾老先生 / 拾光书屋 / 那封信", maxLength: 64 }),
	}),
	async execute(_toolCallId: string, params: { query: string }) {
		const q = cleanText(params.query ?? "");
		if (q.length === 0 || q.length > 64) {
			throw new Error("query 参数必须是 1~64 个字符的检索词");
		}

		const keywords = extractKeywords(q, 8);
		if (keywords.length === 0) {
			return { content: [{ type: "text" as const, text: "未提供有效检索词。" }], details: { query: q, hits: 0 } };
		}

		const candidates = await searchWorldbookCandidates(keywords, 20);
		const scored = candidates
			.map((row) => {
				const hay = `${row.title} ${row.content} ${row.entities.join(" ")} ${row.tags.join(" ")}`.toLowerCase();
				const score = keywords.reduce((acc, k) => acc + (hay.includes(k) ? 1 : 0), 0) + row.entities.length * 0.1;
				return { row, score };
			})
			.filter((s) => s.score >= 1)
			.sort((a, b) => b.score - a.score)
			.slice(0, 3);

		if (scored.length === 0) {
			return {
				content: [{ type: "text" as const, text: `没有检索到与「${q}」相关的世界观条目。不要编造设定，可以自然回避或表示你也不太清楚。` }],
				details: { query: q, hits: 0 },
			};
		}

		const text = scored
			.map((s) => `【${s.row.title}】\n${s.row.content}`)
			.join("\n\n");
		return {
			content: [{ type: "text" as const, text }],
			details: { query: q, hits: scored.length },
		};
	},
};
