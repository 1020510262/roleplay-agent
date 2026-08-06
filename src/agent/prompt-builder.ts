/**
 * Per-turn dynamic prompt assembly.
 *
 * The system prompt = immutable core persona (set once at session creation)
 * + this dynamic block, re-built for EVERY user turn and appended by the
 * before_agent_start extension hook. Nothing mutable ever touches the core.
 *
 * Layer 1 (core persona)   -> persona.ts / persona-io.ts
 * Layer 2 (long-term mem)  -> injected here as retrieved snippets (stage 3)
 * Layer 3 (scene state)    -> injected here, updated every turn
 * Correction notice        -> stage 4 persona-consistency checks
 */
import type { SceneState } from "./scene.js";
import { renderSceneBlock } from "./scene.js";

export interface MemorySnippet {
	summary: string;
	kind: string;
	when: string; // human-readable relative label, e.g. "3 天前"
}

export interface WorldbookSnippet {
	title: string;
	content: string;
}

export interface TurnContext {
	personaName: string;
	scene: SceneState;
	memories: MemorySnippet[];
	worldbook: WorldbookSnippet[];
	correctionNotice?: string;
}

export function renderDynamicBlock(ctx: TurnContext): string {
	const parts: string[] = [];

	parts.push(`【当前场景状态】\n${renderSceneBlock(ctx.scene)}`);

	if (ctx.memories.length > 0) {
		const lines = ctx.memories.map((m, i) => `${i + 1}. [${m.when}${m.kind ? `·${m.kind}` : ""}] ${m.summary}`);
		parts.push(`【相关长期记忆（与此前剧情有关，供你自然参考，不要生硬复述）】\n${lines.join("\n")}`);
	}

	if (ctx.worldbook.length > 0) {
		const lines = ctx.worldbook.map((w) => `- ${w.title}：${w.content}`);
		parts.push(`【相关世界观设定】\n${lines.join("\n")}`);
	}

	if (ctx.correctionNotice && ctx.correctionNotice.trim()) {
		parts.push(`【人设校正提醒（内部）】\n近几轮你的表现偏离了人设：${ctx.correctionNotice}\n请立刻回到「${ctx.personaName}」的性格与语言风格。`);
	}

	parts.push(`记住：你是「${ctx.personaName}」。保持上述语言风格与行为边界，用第一人称自然回应玩家。`);

	return parts.join("\n\n");
}
