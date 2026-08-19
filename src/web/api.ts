/**
 * REST + SSE API. Streaming responses use Server-Sent Events over a POST
 * fetch stream (so the HttpOnly cookie travels — EventSource can't).
 */
import { Router, type Request, type Response } from "express";
import { orchestrator, type StreamEvent } from "../agent/orchestrator.js";
import { config } from "../config.js";
import { destroySession, issueSession, tokenValid } from "../security/auth.js";
import { InputRejected } from "../security/input-guard.js";
import {
	getModelProfile,
	listModelProfiles,
	ModelConnectionError,
	saveModelProfile,
	setActiveModelProfile,
	testModelConnection,
} from "../agent/model-settings.js";
import { resetModelRuntime } from "../agent/runtime.js";

/** Public routes (login only). */
export const publicApi = Router();
/** Everything here sits behind requireApiAuth. */
export const api = Router();

// ── auth ────────────────────────────────────────────────────────────────
publicApi.post("/login", (req: Request, res: Response) => {
	const token = (req.body ?? {}).token;
	if (!tokenValid(token)) {
		res.status(401).json({ error: "token invalid" });
		return;
	}
	issueSession(res);
	res.json({ ok: true });
});

api.post("/logout", (req: Request, res: Response) => {
	destroySession(req, res);
	res.json({ ok: true });
});

api.get("/me", (_req: Request, res: Response) => {
	const defaultPersona = orchestrator.resolveDefaultPersona();
	res.json({
		defaultPersona,
		displayName: orchestrator.getPersonaName(defaultPersona),
		personas: orchestrator.listPersonaSummaries(),
		checkEveryTurns: config.app.checkEveryTurns,
	});
});

// ── model settings ──────────────────────────────────────────────────────
api.get("/models", (_req: Request, res: Response) => {
	res.setHeader("Cache-Control", "no-store");
	res.json(listModelProfiles());
});

api.post("/models", async (req: Request, res: Response) => {
	try {
		const test = await testModelConnection(req.body);
		const model = saveModelProfile(req.body);
		res.status(201).json({ model, test });
	} catch (err) {
		const status = err instanceof ModelConnectionError ? 502 : 400;
		res.status(status).json({ error: (err as Error).message, modelConnectionFailed: err instanceof ModelConnectionError });
	}
});

api.put("/models/active", async (req: Request, res: Response) => {
	try {
		if (orchestrator.hasBusySessions()) {
			res.status(409).json({ error: "当前仍有对话正在生成，请等待完成后再切换模型" });
			return;
		}
		const id = typeof req.body?.id === "string" ? req.body.id : "";
		const profile = getModelProfile(id);
		const test = await testModelConnection(profile);
		if (orchestrator.hasBusySessions()) {
			res.status(409).json({ error: "测试期间有新对话开始，请等待完成后重试切换" });
			return;
		}
		await orchestrator.settle();
		orchestrator.disposeAll();
		const model = setActiveModelProfile(id);
		resetModelRuntime();
		res.json({ model, test });
	} catch (err) {
		const status = err instanceof ModelConnectionError ? 502 : 400;
		res.status(status).json({ error: (err as Error).message, modelConnectionFailed: err instanceof ModelConnectionError });
	}
});

// ── personas ─────────────────────────────────────────────────────────────
api.get("/personas", (_req: Request, res: Response) => {
	res.json({ personas: orchestrator.listPersonaSummaries() });
});

api.post("/personas", (req: Request, res: Response) => {
	try {
		const created = orchestrator.createPersona(req.body);
		res.status(201).json({ persona: created });
	} catch (err) {
		res.status(400).json({ error: (err as Error).message });
	}
});

// ── sessions ────────────────────────────────────────────────────────────
api.get("/sessions", async (_req: Request, res: Response) => {
	try {
		res.json({ sessions: await orchestrator.listSessionsLite() });
	} catch (err) {
		res.status(500).json({ error: (err as Error).message });
	}
});

api.post("/sessions", async (req: Request, res: Response) => {
	try {
		const personaId =
			typeof req.body?.personaId === "string" && req.body.personaId ? req.body.personaId : orchestrator.resolveDefaultPersona();
		// fail fast on unknown personas instead of creating a broken session
		orchestrator.getPersona(personaId);
		const row = await orchestrator.newSession(personaId);
		res.json({
			session: {
				id: row.id,
				title: row.title,
				persona_id: row.persona_id,
				persona_name: orchestrator.getPersonaName(row.persona_id),
				turn_count: row.turn_count,
			},
		});
	} catch (err) {
		res.status(400).json({ error: (err as Error).message });
	}
});

api.get("/sessions/:id", async (req: Request, res: Response) => {
	try {
		const scene = await orchestrator.getScene(req.params.id);
		if (!scene) {
			res.status(404).json({ error: "session not found" });
			return;
		}
		res.json({ scene });
	} catch (err) {
		res.status(500).json({ error: (err as Error).message });
	}
});

api.delete("/sessions/:id", async (req: Request, res: Response) => {
	try {
		await orchestrator.deleteSession(req.params.id);
		res.json({ ok: true });
	} catch (err) {
		res.status(400).json({ error: (err as Error).message });
	}
});

api.get("/sessions/:id/messages", async (req: Request, res: Response) => {
	try {
		const msgs = await orchestrator.getHistory(req.params.id);
		res.json({
			messages: msgs
				.filter((m) => m.role === "user" || m.role === "assistant")
				.map((m) => ({ role: m.role, content: m.content, turn: m.turn, at: m.created_at })),
		});
	} catch (err) {
		res.status(500).json({ error: (err as Error).message });
	}
});

// ── chat (SSE stream) ───────────────────────────────────────────────────
api.post("/sessions/:id/messages", async (req: Request, res: Response) => {
	const sessionId = req.params.id;
	const text = (req.body ?? {}).text;

	res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders?.();

	const send = (evt: StreamEvent) => {
		res.write(`data: ${JSON.stringify(evt)}\n\n`);
	};

	let unsubscribe: (() => void) | undefined;
	let aborted = false;
	req.on("close", () => {
		aborted = true;
		unsubscribe?.();
	});

	try {
		await orchestrator.open(sessionId);
		unsubscribe = orchestrator.subscribe(sessionId, send);

		const { reply, scene } = await orchestrator.chat(sessionId, text);
		if (!aborted) {
			send({ type: "done", reply, scene });
		}
	} catch (err) {
		let message = (err as Error).message ?? String(err);
		if (err instanceof InputRejected) {
			message = `输入被拒绝：${message}`;
		}
		if (!aborted) send({ type: "error", message });
	} finally {
		unsubscribe?.();
		res.end();
	}
});
