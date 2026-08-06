/**
 * Express entrypoint: static login page, authed chat page, authed API.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { orchestrator } from "../agent/orchestrator.js";
import { api, publicApi } from "./api.js";
import { isAuthenticated, requireApiAuth, requirePageAuth } from "../security/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "..", "src", "web", "public");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// tiny security headers
app.use((_req, res, next) => {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Referrer-Policy", "no-referrer");
	next();
});

// Static assets carry no secrets: stylesheet + favicon public, pages gated.
app.get("/style.css", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "style.css")));
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// login page is public; the chat page is gated.
app.get("/", (_req, res) => {
	if (isAuthenticated(_req)) {
		res.redirect("/chat.html");
		return;
	}
	res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});
app.get("/chat.html", requirePageAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "chat.html")));
app.get("/app.js", requirePageAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "app.js")));

app.use("/api", publicApi); // login (no auth required)
app.use("/api", requireApiAuth, api); // everything else is gated

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`\n[server] ${sig} — settling background jobs...`);
	try {
		await Promise.race([orchestrator.settle(), new Promise((r) => setTimeout(r, 20_000))]);
	} finally {
		orchestrator.disposeAll();
		process.exit(0);
	}
}

app.listen(config.app.port, () => {
	console.log(`[server] roleplay-agent on http://127.0.0.1:${config.app.port}`);
	console.log(`[server] persona: ${config.app.defaultPersona} | check every ${config.app.checkEveryTurns} turns`);
});
