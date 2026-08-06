/**
 * Create the roleplay database schema. Requires pg_trgm for fuzzy text
 * search, which needs superuser — the script tries as the app user first,
 * then falls back to `su postgres` for the extension.
 *
 *   node scripts/init-db.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Load .env manually (no dotenv needed here).
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const pool = new pg.Pool({
	host: process.env.PGHOST,
	port: Number(process.env.PGPORT ?? 5432),
	database: process.env.PGDATABASE,
	user: process.env.PGUSER,
	password: process.env.PGPASSWORD,
});

const schema = fs.readFileSync(path.join(ROOT, "sql", "schema.sql"), "utf8");

try {
	await pool.query(schema);
	console.log("[init-db] schema applied");
} catch (err) {
	console.error("[init-db] schema failed:", err.message);
	process.exit(1);
}

// pg_trgm needs superuser.
try {
	await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
	console.log("[init-db] pg_trgm extension ok");
} catch {
	console.log("[init-db] pg_trgm needs superuser — trying via unix socket as postgres");
	try {
		execFileSync("su", ["postgres", "-c", `psql -d ${process.env.PGDATABASE} -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"`], {
			stdio: "inherit",
		});
	} catch (err2) {
		console.warn("[init-db] WARNING: could not create pg_trgm; ILIKE searches will still work without trigram index:", err2.message);
	}
}

// trigram indexes (only when extension exists)
const hasTrgm = (await pool.query("SELECT 1 FROM pg_extension WHERE extname='pg_trgm'")).rowCount > 0;
if (hasTrgm) {
	await pool.query("CREATE INDEX IF NOT EXISTS idx_memory_summary_trgm ON memory_summaries USING GIN (summary gin_trgm_ops)");
	await pool.query("CREATE INDEX IF NOT EXISTS idx_worldbook_content_trgm ON worldbook USING GIN (content gin_trgm_ops)");
	console.log("[init-db] trigram indexes ok");
}

const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1");
console.log("[init-db] tables:", tables.rows.map((r) => r.tablename).join(", "));
await pool.end();
