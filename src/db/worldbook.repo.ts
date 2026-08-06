import { query } from "./pool.js";

export interface WorldbookRow {
	id: number;
	entry_key: string;
	title: string;
	content: string;
	entities: string[];
	tags: string[];
}

export interface UpsertWorldbookInput {
	entryKey: string;
	title: string;
	content: string;
	entities: string[];
	tags: string[];
}

export async function upsertWorldbook(w: UpsertWorldbookInput): Promise<void> {
	await query(
		`INSERT INTO worldbook (entry_key, title, content, entities, tags)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (entry_key) DO UPDATE
		 SET title = EXCLUDED.title, content = EXCLUDED.content,
		     entities = EXCLUDED.entities, tags = EXCLUDED.tags, updated_at = now()`,
		[w.entryKey, w.title, w.content, w.entities, w.tags],
	);
}

export async function searchWorldbookCandidates(keywords: string[], limit = 20): Promise<WorldbookRow[]> {
	if (keywords.length === 0) return [];
	const likes = keywords.map((k) => `%${k}%`);
	const res = await query<WorldbookRow>(
		`SELECT * FROM worldbook
		 WHERE entities && $1::text[] OR tags && $1::text[]
		    OR title ILIKE ANY ($2::text[]) OR content ILIKE ANY ($2::text[])
		 LIMIT $3`,
		[keywords, likes, limit],
	);
	return res.rows;
}

export async function listWorldbook(): Promise<WorldbookRow[]> {
	const res = await query<WorldbookRow>(`SELECT * FROM worldbook ORDER BY id`);
	return res.rows;
}
