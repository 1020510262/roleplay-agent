import { randomUUID } from "node:crypto";
import { query } from "./pool.js";

export interface SessionRow {
	id: string;
	persona_id: string;
	title: string | null;
	pi_session_file: string | null;
	turn_count: number;
	created_at: Date;
	updated_at: Date;
}

export interface MessageRow {
	id: number;
	session_id: string;
	turn: number;
	role: "user" | "assistant" | "tool" | "system";
	content: string;
	meta: Record<string, unknown> | null;
	created_at: Date;
}

export async function createSession(personaId: string, piSessionFile?: string, title?: string): Promise<SessionRow> {
	const id = randomUUID();
	const res = await query<SessionRow>(
		`INSERT INTO sessions (id, persona_id, title, pi_session_file)
		 VALUES ($1, $2, $3, $4) RETURNING *`,
		[id, personaId, title ?? null, piSessionFile ?? null],
	);
	return res.rows[0];
}

export async function getSession(id: string): Promise<SessionRow | undefined> {
	const res = await query<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [id]);
	return res.rows[0];
}

export async function listSessions(limit = 30): Promise<SessionRow[]> {
	const res = await query<SessionRow>(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT $1`, [limit]);
	return res.rows;
}

/** Delete a session (messages & scene_state cascade). */
export async function deleteSessionRow(id: string): Promise<void> {
	await query(`DELETE FROM sessions WHERE id = $1`, [id]);
}

export async function bumpSession(id: string, piSessionFile?: string): Promise<void> {
	if (piSessionFile) {
		await query(
			`UPDATE sessions SET updated_at = now(), pi_session_file = COALESCE($2, pi_session_file) WHERE id = $1`,
			[id, piSessionFile],
		);
	} else {
		await query(`UPDATE sessions SET updated_at = now() WHERE id = $1`, [id]);
	}
}

export async function incrementTurn(id: string): Promise<number> {
	const res = await query<{ turn_count: number }>(
		`UPDATE sessions SET turn_count = turn_count + 1, updated_at = now() WHERE id = $1 RETURNING turn_count`,
		[id],
	);
	return res.rows[0]?.turn_count ?? 0;
}

export async function insertMessage(
	sessionId: string,
	turn: number,
	role: MessageRow["role"],
	content: string,
	meta?: Record<string, unknown>,
): Promise<void> {
	await query(
		`INSERT INTO messages (session_id, turn, role, content, meta) VALUES ($1, $2, $3, $4, $5)`,
		[sessionId, turn, role, content, meta ? JSON.stringify(meta) : null],
	);
}

/** Raw recent dialogue — used to seed retrieval and for the UI transcript. */
export async function recentMessages(sessionId: string, limit = 40): Promise<MessageRow[]> {
	const res = await query<MessageRow>(
		`SELECT * FROM (SELECT * FROM messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id ASC`,
		[sessionId, limit],
	);
	return res.rows;
}

export async function allMessages(sessionId: string): Promise<MessageRow[]> {
	const res = await query<MessageRow>(`SELECT * FROM messages WHERE session_id = $1 ORDER BY id ASC`, [sessionId]);
	return res.rows;
}
