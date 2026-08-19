import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// We only use our own custom provider (Aliyun MaaS). PI_OFFLINE skips pi's
// built-in provider catalog/availability network sweeps, which are slow or
// unreachable from this machine.
process.env.PI_OFFLINE ??= "1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Project root (dist/.. when compiled). */
export const ROOT_DIR = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");

function required(name: string): string {
	const v = process.env[name];
	if (!v || v.trim() === "") throw new Error(`Missing required env var: ${name}`);
	return v.trim();
}

function optional(name: string, fallback: string): string {
	const v = process.env[name];
	return v && v.trim() !== "" ? v.trim() : fallback;
}

export const config = {
	model: {
		provider: optional("MODEL_PROVIDER", "aliyun-maas"),
		id: optional("MODEL_ID", "deepseek-v4-flash-0731"),
		apiKey: required("ALIYUN_MAAS_API_KEY"),
		/** Independent calls (extraction/check) reuse the same model by default. */
		utilityProvider: optional("UTILITY_MODEL_PROVIDER", optional("MODEL_PROVIDER", "aliyun-maas")),
		utilityId: optional("UTILITY_MODEL_ID", optional("MODEL_ID", "deepseek-v4-flash-0731")),
	},
	db: {
		host: optional("PGHOST", "127.0.0.1"),
		port: Number(optional("PGPORT", "5432")),
		database: optional("PGDATABASE", "roleplay"),
		user: optional("PGUSER", "roleplay"),
		password: required("PGPASSWORD"),
	},
	app: {
		token: required("APP_TOKEN"),
		port: Number(optional("PORT", "3000")),
		defaultPersona: optional("DEFAULT_PERSONA", "lin-wanqing"),
		/** Persona consistency check cadence (every N user turns). */
		checkEveryTurns: Number(optional("CHECK_EVERY_TURNS", "20")),
		/** Max accepted user input characters. */
		maxInputChars: Number(optional("MAX_INPUT_CHARS", "4000")),
		/** Number of retrieved memory snippets injected per turn. */
		memoryTopK: Number(optional("MEMORY_TOP_K", "5")),
		/** Extract key info after every turn (separate model call). */
		extractEveryTurn: optional("EXTRACT_EVERY_TURN", "true") === "true",
	},
	paths: {
		dataDir: DATA_DIR,
		personasDir: path.join(DATA_DIR, "personas"),
		sessionsDir: path.join(DATA_DIR, "sessions"),
		modelsJson: path.join(DATA_DIR, "models.json"),
		runtimeModelsJson: path.join(DATA_DIR, "models-runtime.json"),
		modelSettingsJson: path.join(DATA_DIR, "model-settings.json"),
		authJson: path.join(DATA_DIR, "auth.json"),
	},
} as const;
