/**
 * Defense-in-depth validation for everything that flows INTO the database
 * via tools or background extraction. TypeBox schemas on the tools give the
 * first gate (shape); this module is the second gate (lengths, whitelists,
 * value ranges, content sanitation) applied right before any write.
 *
 * Nothing here ever builds SQL by string concatenation — repos use
 * parameterized queries only.
 */

export class ValidationReject extends Error {}

export const LIMITS = {
	summaryMax: 600,
	tagMax: 24,
	tagCountMax: 8,
	entityMax: 32,
	entityCountMax: 8,
	locationMax: 64,
	moodMax: 64,
	timeLabelMax: 64,
	eventMax: 300,
	noteMax: 300,
	relationshipNoteMax: 200,
} as const;

const KINDS = new Set(["event", "relationship", "foreshadow", "fact"]);

/** Reject control characters and other junk; normalize whitespace edges. */
export function cleanText(s: string): string {
	// Strip all C0/C1 control chars except \n and \t; remove BOM/zero-width chars.
	const out = s
		.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
		.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "")
		.trim();
	return out;
}

export function requireString(v: unknown, field: string, max: number, opts: { min?: number } = {}): string {
	if (typeof v !== "string") throw new ValidationReject(`${field} must be a string`);
	const s = cleanText(v);
	if (s.length > max) throw new ValidationReject(`${field} exceeds ${max} characters`);
	if (opts.min !== undefined && s.length < opts.min) throw new ValidationReject(`${field} too short`);
	return s;
}

export function optionalString(v: unknown, field: string, max: number): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string") throw new ValidationReject(`${field} must be a string`);
	const s = cleanText(v);
	if (s.length === 0) return undefined;
	if (s.length > max) throw new ValidationReject(`${field} exceeds ${max} characters`);
	return s;
}

/** Entity/tag identifiers: short, no separators that could confuse retrieval. */
export function requireIdentifierList(v: unknown, field: string, maxItems: number, maxLen: number): string[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v)) throw new ValidationReject(`${field} must be an array`);
	if (v.length > maxItems) throw new ValidationReject(`${field} has more than ${maxItems} items`);
	const out: string[] = [];
	for (const item of v) {
		if (typeof item !== "string") throw new ValidationReject(`${field} items must be strings`);
		const s = cleanText(item).replace(/[,，;；|]/g, " ").trim();
		if (s.length === 0) continue;
		if (s.length > maxLen) throw new ValidationReject(`${field} item exceeds ${maxLen} characters`);
		if (!out.includes(s)) out.push(s);
	}
	return out;
}

export function requireImportance(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationReject("importance must be a number");
	const n = Math.round(v);
	if (n < 1 || n > 5) throw new ValidationReject("importance must be between 1 and 5");
	return n;
}

export function requireKind(v: unknown): string {
	if (typeof v !== "string" || !KINDS.has(v)) {
		throw new ValidationReject(`kind must be one of ${[...KINDS].join(", ")}`);
	}
	return v;
}

export function requireRelationshipScore(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationReject("relationship_score must be a number");
	const n = Math.round(v);
	if (n < 0 || n > 100) throw new ValidationReject("relationship_score must be between 0 and 100");
	return n;
}

/** Clamp helper for partial scene updates coming from the model. */
export function clampRelationshipScore(v: number): number {
	return Math.max(0, Math.min(100, Math.round(v)));
}
