/**
 * Persona loading & validation.
 *
 * Personas live as structured YAML in data/personas/. We validate shape and
 * lengths on load — a malformed persona file must fail loudly at startup,
 * never leak half-built prompts.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { config } from "../config.js";
import type { PersonaDoc, PlayerDoc } from "./persona.js";

const MAX_FIELD = 500;
const MAX_LIST_ITEM = 300;
const MAX_LIST = 20;

export class PersonaValidationError extends Error {}

function str(v: unknown, field: string, opts: { required: true; max?: number }): string;
function str(v: unknown, field: string, opts?: { required?: false; max?: number }): string | undefined;
function str(v: unknown, field: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
	if (v === undefined || v === null) {
		if (opts.required) throw new PersonaValidationError(`persona: missing required field "${field}"`);
		return undefined;
	}
	if (typeof v === "number") v = String(v);
	if (typeof v !== "string") throw new PersonaValidationError(`persona: field "${field}" must be a string`);
	const s = v.trim();
	if (s.length === 0) {
		if (opts.required) throw new PersonaValidationError(`persona: field "${field}" is empty`);
		return undefined;
	}
	const max = opts.max ?? MAX_FIELD;
	if (s.length > max) throw new PersonaValidationError(`persona: field "${field}" exceeds ${max} chars`);
	return s;
}

function strList(v: unknown, field: string): string[] | undefined {
	if (v === undefined || v === null) return undefined;
	if (!Array.isArray(v)) throw new PersonaValidationError(`persona: field "${field}" must be a list`);
	if (v.length > MAX_LIST) throw new PersonaValidationError(`persona: field "${field}" has more than ${MAX_LIST} items`);
	const out: string[] = [];
	for (const item of v) {
		const s = str(item, `${field}[]`, { max: MAX_LIST_ITEM });
		if (s) out.push(s);
	}
	return out.length ? out : undefined;
}

/** Validate an untrusted parsed YAML object into a PersonaDoc. */
export function validatePersonaDoc(raw: unknown): PersonaDoc {
	if (!raw || typeof raw !== "object") throw new PersonaValidationError("persona: document is not an object");
	const r = raw as Record<string, unknown>;

	const section = (name: string): Record<string, unknown> => {
		const s = r[name];
		if (!s || typeof s !== "object" || Array.isArray(s)) {
			throw new PersonaValidationError(`persona: missing section "${name}"`);
		}
		return s as Record<string, unknown>;
	};

	const id = str(r.id, "id", { required: true, max: 64 });
	const name = str(r.name, "name", { required: true, max: 64 });
	if (!/^[a-z0-9_-]+$/i.test(id!)) throw new PersonaValidationError(`persona: invalid id "${id}"`);

	const basic = section("basic_info");
	const personality = section("personality");
	const speech = section("speech_style");
	const boundaries = section("boundaries");
	const relationship = section("relationship");
	const sceneDefaults = (r.scene_defaults ?? undefined) as Record<string, unknown> | undefined;
	const playerRaw = (r.player ?? undefined) as Record<string, unknown> | undefined;
	const worldRaw = (r.world ?? undefined) as Record<string, unknown> | undefined;

	const neverDo = strList(boundaries.never_do, "boundaries.never_do");
	if (!neverDo?.length) throw new PersonaValidationError("persona: boundaries.never_do must not be empty");
	const coreTraits = strList(personality.core_traits, "personality.core_traits");
	if (!coreTraits?.length) throw new PersonaValidationError("persona: personality.core_traits must not be empty");

	let player: PlayerDoc | undefined;
	if (playerRaw) {
		const p = {
			name: str(playerRaw.name, "player.name", { max: 32 }),
			gender: str(playerRaw.gender, "player.gender", { max: 16 }),
			age: str(playerRaw.age, "player.age", { max: 32 }),
			occupation: str(playerRaw.occupation, "player.occupation", { max: 120 }),
			appearance: str(playerRaw.appearance, "player.appearance", { max: 300 }),
			background: str(playerRaw.background, "player.background", { max: 1000 }),
			personality: strList(playerRaw.personality, "player.personality"),
		};
		if (Object.values(p).some((v) => v !== undefined && (!Array.isArray(v) || v.length > 0))) player = p;
	}

	const worldSetting = worldRaw ? str(worldRaw.setting, "world.setting", { max: 2000 }) : undefined;

	return {
		id: id!,
		name: name!,
		version: typeof r.version === "number" ? Math.floor(r.version) : 1,
		player,
		world: worldSetting ? { setting: worldSetting } : undefined,
		basic_info: {
			gender: str(basic.gender, "basic_info.gender", { max: 32 }),
			age: str(basic.age, "basic_info.age", { max: 32 }),
			occupation: str(basic.occupation, "basic_info.occupation"),
			appearance: str(basic.appearance, "basic_info.appearance"),
			background: str(basic.background, "basic_info.background", { max: 1000 }),
		},
		personality: {
			core_traits: coreTraits,
			values: str(personality.values, "personality.values"),
			inner_conflict: str(personality.inner_conflict, "personality.inner_conflict"),
		},
		speech_style: {
			tone: str(speech.tone, "speech_style.tone", { required: true }),
			vocabulary: strList(speech.vocabulary, "speech_style.vocabulary"),
			interjections: strList(speech.interjections, "speech_style.interjections"),
			sentence_patterns: strList(speech.sentence_patterns, "speech_style.sentence_patterns"),
			sample_lines: strList(speech.sample_lines, "speech_style.sample_lines"),
		},
		boundaries: {
			never_do: neverDo,
			topics_to_avoid: strList(boundaries.topics_to_avoid, "boundaries.topics_to_avoid"),
		},
		relationship: {
			initial_relation: str(relationship.initial_relation, "relationship.initial_relation", { required: true }),
			backstory: str(relationship.backstory, "relationship.backstory", { max: 1000 }),
		},
		scene_defaults: sceneDefaults
			? {
					location: str(sceneDefaults.location, "scene_defaults.location", { max: 64 }),
					time_label: str(sceneDefaults.time_label, "scene_defaults.time_label", { max: 64 }),
					mood: str(sceneDefaults.mood, "scene_defaults.mood", { max: 64 }),
				}
			: undefined,
	};
}

export function personaFilePath(id: string): string {
	// id is validated as [a-z0-9_-]+ before ever reaching the filesystem.
	if (!/^[a-z0-9_-]+$/i.test(id)) throw new PersonaValidationError(`persona: invalid id "${id}"`);
	return path.join(config.paths.personasDir, `${id}.yaml`);
}

/** Load and validate a persona from disk. */
export function loadPersona(id: string): PersonaDoc {
	const file = personaFilePath(id);
	if (!fs.existsSync(file)) throw new PersonaValidationError(`persona: file not found: ${file}`);
	const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
	return validatePersonaDoc(parsed);
}

/** Persist a validated persona to data/personas/<id>.yaml (idempotent). */
export function savePersonaToDisk(doc: PersonaDoc): void {
	const file = personaFilePath(doc.id);
	fs.writeFileSync(file, YAML.stringify(doc), "utf8");
}

/** List available persona ids. */
export function listPersonas(): string[] {
	if (!fs.existsSync(config.paths.personasDir)) return [];
	return fs
		.readdirSync(config.paths.personasDir)
		.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
		.map((f) => f.replace(/\.(yaml|yml)$/, ""));
}
