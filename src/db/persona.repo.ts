import type { PersonaDoc } from "../agent/persona.js";
import { query } from "./pool.js";

export async function upsertPersona(doc: PersonaDoc, corePrompt: string): Promise<void> {
	await query(
		`INSERT INTO persona (id, version, display_name, doc, core_prompt)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (id) DO UPDATE
		 SET version = EXCLUDED.version, display_name = EXCLUDED.display_name,
		     doc = EXCLUDED.doc, core_prompt = EXCLUDED.core_prompt, updated_at = now()`,
		[doc.id, doc.version, doc.name, JSON.stringify(doc), corePrompt],
	);
}

export async function getPersonaRow(id: string): Promise<{ id: string; doc: PersonaDoc; core_prompt: string } | undefined> {
	const res = await query<{ id: string; doc: PersonaDoc; core_prompt: string }>(
		`SELECT id, doc, core_prompt FROM persona WHERE id = $1`,
		[id],
	);
	return res.rows[0];
}
