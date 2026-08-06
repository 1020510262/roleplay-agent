/**
 * Minimal single-user auth: one shared APP_TOKEN gates the whole app.
 * Successful login sets an HttpOnly session cookie; every other route
 * (pages and API) requires it. Token comparison is timing-safe.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

const COOKIE_NAME = "rpsid";
const sessions = new Map<string, number>(); // sid -> created ms
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export function tokenValid(provided: unknown): boolean {
	if (typeof provided !== "string" || provided.length === 0) return false;
	const expected = config.app.token;
	if (provided.length !== expected.length) return false;
	try {
		return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
	} catch {
		return false;
	}
}

function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const k = part.slice(0, idx).trim();
		const v = part.slice(idx + 1).trim();
		if (k) out[k] = decodeURIComponent(v);
	}
	return out;
}

export function issueSession(res: Response): void {
	pruneExpired();
	const sid = randomBytes(32).toString("hex");
	sessions.set(sid, Date.now());
	res.setHeader(
		"Set-Cookie",
		`${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
	);
}

export function destroySession(req: Request, res: Response): void {
	const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
	if (sid) sessions.delete(sid);
	res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function pruneExpired(): void {
	const now = Date.now();
	for (const [sid, created] of sessions) {
		if (now - created > SESSION_TTL_MS) sessions.delete(sid);
	}
}

export function isAuthenticated(req: Request): boolean {
	const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
	if (!sid) return false;
	const created = sessions.get(sid);
	if (!created) return false;
	if (Date.now() - created > SESSION_TTL_MS) {
		sessions.delete(sid);
		return false;
	}
	return true;
}

/** Gate for API routes: 401 JSON. */
export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
	if (isAuthenticated(req)) return next();
	res.status(401).json({ error: "unauthorized" });
}

/** Gate for pages: redirect to the login page. */
export function requirePageAuth(req: Request, res: Response, next: NextFunction): void {
	if (isAuthenticated(req)) return next();
	res.redirect("/");
}
