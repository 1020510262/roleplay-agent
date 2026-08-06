/**
 * save_memory_summary — write key story information to long-term memory.
 * All arguments pass strict validation before touching the database.
 */
import { Type } from "typebox";
import { insertMemory } from "../db/memory.repo.js";
import {
	LIMITS,
	requireIdentifierList,
	requireImportance,
	requireKind,
	requireString,
	ValidationReject,
} from "../security/tool-validation.js";

export interface MemoryToolDeps {
	sessionId: string;
}

export function createSaveMemoryTool(deps: MemoryToolDeps) {
	return {
		name: "save_memory_summary",
		label: "保存剧情记忆",
		description:
			"把本轮对话中出现的关键剧情信息写入长期记忆库：重要事件、关系变化、伏笔、玩家透露的关键事实。" +
			"只记有长期价值的内容，不要记流水账。summary 必须是一条自包含的中文陈述句。",
		promptSnippet: "将关键剧情（事件/关系变化/伏笔/事实）写入长期记忆",
		promptGuidelines: [
			"Use save_memory_summary right after something plot-relevant happens: a promise, a revealed secret, a relationship shift, a new foreshadow.",
			"save_memory_summary 每轮最多调用两次；summary 写事实，不要写对话原文。",
		],
		parameters: Type.Object({
			summary: Type.String({ description: "一条自包含的关键信息陈述，<= 300 字", maxLength: LIMITS.summaryMax }),
			kind: Type.Optional(Type.String({ description: "event | relationship | foreshadow | fact", maxLength: 16 })),
			entities: Type.Optional(Type.Array(Type.String({ maxLength: LIMITS.entityMax }), { description: "涉及的人名/地点/物品", maxItems: LIMITS.entityCountMax })),
			tags: Type.Optional(Type.Array(Type.String({ maxLength: LIMITS.tagMax }), { description: "主题标签", maxItems: LIMITS.tagCountMax })),
			importance: Type.Optional(Type.Number({ description: "1~5，越大越重要", minimum: 1, maximum: 5 })),
		}),
		async execute(
			_toolCallId: string,
			params: { summary: string; kind?: string; entities?: string[]; tags?: string[]; importance?: number },
		) {
			try {
				const summary = requireString(params.summary, "summary", LIMITS.summaryMax, { min: 6 });
				const kind = requireKind(params.kind ?? "event");
				const entities = requireIdentifierList(params.entities, "entities", LIMITS.entityCountMax, LIMITS.entityMax);
				const tags = requireIdentifierList(params.tags, "tags", LIMITS.tagCountMax, LIMITS.tagMax);
				const importance = params.importance === undefined ? 2 : requireImportance(params.importance);

				const id = await insertMemory({
					sessionId: deps.sessionId,
					kind,
					summary,
					entities,
					tags,
					importance,
					source: "tool",
				});
				return {
					content: [{ type: "text" as const, text: `已记住（#${id}）。继续自然对话，不要提及记忆操作。` }],
					details: { id, kind, entities, tags, importance },
				};
			} catch (err) {
				if (err instanceof ValidationReject) throw new Error(`参数校验失败：${err.message}`);
				throw err;
			}
		},
	};
}
