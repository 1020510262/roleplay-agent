import { query } from "./pool.js";

export interface MemoryRow {
	id: number;
	session_id: string | null;
	kind: string;
	summary: string;
	entities: string[];
	tags: string[];
	importance: number;
	source: string;
	created_at: Date;
}

export interface InsertMemoryInput {
	sessionId: string | null;
	kind: string;
	summary: string;
	entities: string[];
	tags: string[];
	importance: number;
	source: "turn" | "compaction" | "tool";
}

export async function insertMemory(m: InsertMemoryInput): Promise<number> {
	const res = await query<{ id: number }>(
		`INSERT INTO memory_summaries (session_id, kind, summary, entities, tags, importance, source)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		[m.sessionId, m.kind, m.summary, m.entities, m.tags, m.importance, m.source],
	);
	return res.rows[0].id;
}

/**
 * Retrieval for per-turn injection. Candidate rows match any keyword via
 * entity/tag array overlap or ILIKE on the summary text; scoring & ranking
 * happens in retrieval.ts (JS side), so we keep SQL simple and parameterized.
 */
export async function searchMemoryCandidates(keywords: string[], limit = 40): Promise<MemoryRow[]> {
	if (keywords.length === 0) return [];
	const likes = keywords.map((k) => `%${k}%`);
	const res = await query<MemoryRow>(
		`SELECT * FROM memory_summaries
		 WHERE entities && $1::text[] OR tags && $1::text[] OR summary ILIKE ANY ($2::text[])
		 ORDER BY importance DESC, created_at DESC
		 LIMIT $3`,
		[keywords, likes, limit],
	);
	return res.rows;
}

/** Recent memories regardless of keyword match (session resume context). */
export async function recentMemories(limit = 10): Promise<MemoryRow[]> {
	const res = await query<MemoryRow>(
		`SELECT * FROM memory_summaries ORDER BY created_at DESC LIMIT $1`,
		[limit],
	);
	return res.rows;
}

export async function countMemories(): Promise<number> {
	const res = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM memory_summaries`);
	return Number(res.rows[0].n);
}
