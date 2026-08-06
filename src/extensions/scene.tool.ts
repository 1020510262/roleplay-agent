/**
 * update_scene_state — update the mutable scene layer (location, mood,
 * ongoing events, relationship meter). Partial updates; every field is
 * validated and clamped before it reaches the database.
 */
import { Type } from "typebox";
import type { SceneState } from "../agent/scene.js";
import { renderSceneBlock } from "../agent/scene.js";
import { applyScenePatch } from "../db/scene.repo.js";
import {
	LIMITS,
	optionalString,
	requireRelationshipScore,
	ValidationReject,
} from "../security/tool-validation.js";

export interface SceneToolDeps {
	sessionId: string;
	/** Notify the orchestrator (SSE push + in-memory cache). */
	onSceneUpdate?: (scene: SceneState) => void;
}

export function createUpdateSceneTool(deps: SceneToolDeps) {
	return {
		name: "update_scene_state",
		label: "更新场景状态",
		description:
			"更新当前场景的结构化状态：地点、时间、角色情绪、进行中事件、对玩家的好感度。" +
			"场景发生明显变化（换地点、时间推移、情绪转折、关系升温/降温）时调用。只提供发生变化的字段。",
		promptSnippet: "更新地点/时间/情绪/进行中事件/好感度等场景状态",
		promptGuidelines: [
			"Use update_scene_state when the location, time of day, emotional tone, or relationship standing visibly changes — not for small talk.",
			"update_scene_state 的 relationship_delta 用相对值（如 +2 / -1），单次幅度不要超过 5。",
		],
		parameters: Type.Object({
			location: Type.Optional(Type.String({ description: "新地点", maxLength: LIMITS.locationMax })),
			time_label: Type.Optional(Type.String({ description: "时间，如：深夜 / 次日清晨", maxLength: LIMITS.timeLabelMax })),
			mood: Type.Optional(Type.String({ description: "角色当前情绪，如：平静 / 担忧 / 雀跃", maxLength: LIMITS.moodMax })),
			ongoing_events: Type.Optional(Type.String({ description: "进行中的事件概述；无则写空字符串", maxLength: LIMITS.eventMax })),
			relationship_score: Type.Optional(Type.Number({ description: "好感度绝对值 0~100（与 delta 二选一）", minimum: 0, maximum: 100 })),
			relationship_delta: Type.Optional(Type.Number({ description: "好感度相对变化，如 +2 / -1（与绝对值二选一）", minimum: -10, maximum: 10 })),
			relationship_note: Type.Optional(Type.String({ description: "关系状态一句话备注", maxLength: LIMITS.relationshipNoteMax })),
			notes: Type.Optional(Type.String({ description: "其他场景备注", maxLength: LIMITS.noteMax })),
		}),
		async execute(
			_toolCallId: string,
			params: {
				location?: string;
				time_label?: string;
				mood?: string;
				ongoing_events?: string;
				relationship_score?: number;
				relationship_delta?: number;
				relationship_note?: string;
				notes?: string;
			},
		) {
			try {
				const patch = {
					location: optionalString(params.location, "location", LIMITS.locationMax),
					time_label: optionalString(params.time_label, "time_label", LIMITS.timeLabelMax),
					mood: optionalString(params.mood, "mood", LIMITS.moodMax),
					ongoing_events: params.ongoing_events === "" ? "" : optionalString(params.ongoing_events, "ongoing_events", LIMITS.eventMax),
					relationship_note: optionalString(params.relationship_note, "relationship_note", LIMITS.relationshipNoteMax),
					notes: optionalString(params.notes, "notes", LIMITS.noteMax),
				};
				if (params.relationship_score !== undefined) {
					(patch as Record<string, unknown>).relationship_score = requireRelationshipScore(params.relationship_score);
				}
				if (params.relationship_delta !== undefined) {
					if (typeof params.relationship_delta !== "number" || !Number.isFinite(params.relationship_delta)) {
						throw new ValidationReject("relationship_delta must be a number");
					}
					(patch as Record<string, unknown>).relationship_delta = Math.max(-10, Math.min(10, Math.round(params.relationship_delta)));
				}
				if (Object.values(patch).every((v) => v === undefined)) {
					throw new ValidationReject("至少提供一个要更新的字段");
				}

				const next = await applyScenePatch(deps.sessionId, patch);
				deps.onSceneUpdate?.(next);
				return {
					content: [{ type: "text" as const, text: `场景已更新：\n${renderSceneBlock(next)}` }],
					details: { scene: next },
				};
			} catch (err) {
				if (err instanceof ValidationReject) throw new Error(`参数校验失败：${err.message}`);
				throw err;
			}
		},
	};
}
