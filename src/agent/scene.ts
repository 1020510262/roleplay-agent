/** Current scene state — the mutable third layer of the memory architecture. */

export interface SceneState {
	location: string;
	time_label: string;
	mood: string;
	ongoing_events: string;
	/** 0..100 affinity meter. */
	relationship_score: number;
	relationship_note: string;
	notes: string;
}

export const DEFAULT_SCENE: SceneState = {
	location: "拾光书屋",
	time_label: "傍晚",
	mood: "平静",
	ongoing_events: "",
	relationship_score: 20,
	relationship_note: "熟人，聊得来，还没交心",
	notes: "",
};

/** Render scene state into the per-turn dynamic prompt block. */
export function renderSceneBlock(scene: SceneState): string {
	const lines = [
		`地点：${scene.location}`,
		`时间：${scene.time_label}`,
		`情绪：${scene.mood}`,
		scene.ongoing_events ? `进行中事件：${scene.ongoing_events}` : null,
		`与玩家的关系：好感度 ${scene.relationship_score}/100${scene.relationship_note ? `（${scene.relationship_note}）` : ""}`,
		scene.notes ? `备注：${scene.notes}` : null,
	];
	return lines.filter(Boolean).join("\n");
}
