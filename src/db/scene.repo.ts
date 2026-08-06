import type { SceneState } from "../agent/scene.js";
import { query } from "./pool.js";

/** Partial, pre-validated scene update — only provided keys are written. */
export type ScenePatch = Partial<Omit<SceneState, "relationship_score">> & {
	relationship_score?: number;
	/** Relative adjustment alternative: +2 / -1 style. If set, overrides absolute value. */
	relationship_delta?: number;
};

export async function loadScene(sessionId: string): Promise<SceneState | undefined> {
	const res = await query<SceneState & { session_id: string }>(
		`SELECT * FROM scene_state WHERE session_id = $1`,
		[sessionId],
	);
	return res.rows[0];
}

export async function initScene(sessionId: string, scene: SceneState): Promise<void> {
	await query(
		`INSERT INTO scene_state (session_id, location, time_label, mood, ongoing_events,
		                          relationship_score, relationship_note, notes)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (session_id) DO NOTHING`,
		[
			sessionId,
			scene.location,
			scene.time_label,
			scene.mood,
			scene.ongoing_events,
			scene.relationship_score,
			scene.relationship_note,
			scene.notes,
		],
	);
}

export async function applyScenePatch(sessionId: string, patch: ScenePatch): Promise<SceneState> {
	const current = (await loadScene(sessionId)) ?? undefined;
	const base: SceneState = current ?? {
		location: "",
		time_label: "",
		mood: "",
		ongoing_events: "",
		relationship_score: 20,
		relationship_note: "",
		notes: "",
	};

	const next: SceneState = {
		location: patch.location ?? base.location,
		time_label: patch.time_label ?? base.time_label,
		mood: patch.mood ?? base.mood,
		ongoing_events: patch.ongoing_events ?? base.ongoing_events,
		relationship_score:
			patch.relationship_delta !== undefined
				? Math.max(0, Math.min(100, base.relationship_score + patch.relationship_delta))
				: (patch.relationship_score ?? base.relationship_score),
		relationship_note: patch.relationship_note ?? base.relationship_note,
		notes: patch.notes ?? base.notes,
	};

	await query(
		`UPDATE scene_state
		 SET location = $2, time_label = $3, mood = $4, ongoing_events = $5,
		     relationship_score = $6, relationship_note = $7, notes = $8, updated_at = now()
		 WHERE session_id = $1`,
		[
			sessionId,
			next.location,
			next.time_label,
			next.mood,
			next.ongoing_events,
			next.relationship_score,
			next.relationship_note,
			next.notes,
		],
	);
	return next;
}
