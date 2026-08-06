/**
 * Roleplay extension factory — registers the three story tools and the
 * pre-compaction memory-extraction hook on a pi ExtensionAPI.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SceneState } from "../agent/scene.js";
import { extractBeforeCompaction } from "../agent/extraction.js";
import { queryWorldbookTool } from "./worldbook.tool.js";
import { createSaveMemoryTool } from "./memory.tool.js";
import { createUpdateSceneTool } from "./scene.tool.js";

export interface RoleplayExtensionDeps {
	sessionId: string;
	onSceneUpdate?: (scene: SceneState) => void;
}

export function createRoleplayExtension(deps: RoleplayExtensionDeps): InlineExtension {
	return {
		name: "roleplay-tools",
		factory: (pi: ExtensionAPI) => {
			pi.registerTool(queryWorldbookTool);
			pi.registerTool(createSaveMemoryTool({ sessionId: deps.sessionId }));
			pi.registerTool(createUpdateSceneTool({ sessionId: deps.sessionId, onSceneUpdate: deps.onSceneUpdate }));

			/**
			 * Before pi compacts (summarizes & drops) old context, extract the
			 * soon-to-be-discarded content into long-term memory first.
			 * Returning undefined lets the default compaction proceed.
			 */
			pi.on("session_before_compact", async (event, ctx) => {
				try {
					const { messagesToSummarize, turnPrefixMessages } = event.preparation;
					const doomed = [...(turnPrefixMessages ?? []), ...(messagesToSummarize ?? [])];
					if (doomed.length > 0) {
						await extractBeforeCompaction(deps.sessionId, doomed, ctx.signal);
					}
				} catch (err) {
					console.error("[compaction-extract] failed (continuing with default compaction):", (err as Error).message);
				}
				return;
			});
		},
	};
}
