import pg from "pg";
import { config } from "../config.js";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
	if (!pool) {
		pool = new pg.Pool({
			host: config.db.host,
			port: config.db.port,
			database: config.db.database,
			user: config.db.user,
			password: config.db.password,
			max: 8,
			idleTimeoutMillis: 30_000,
		});
		pool.on("error", (err) => {
			console.error("[db] pool error:", err.message);
		});
	}
	return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
	text: string,
	params?: unknown[],
): Promise<pg.QueryResult<T>> {
	return getPool().query<T>(text, params);
}
