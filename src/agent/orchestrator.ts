/**
 * Orchestrator — owns roleplay sessions and drives the single-turn pipeline:
 *
 *   user input (sanitized)
 *     -> retrieve relevant long-term memory / worldbook
 *     -> assemble dynamic block (scene + memories + correction)
 *     -> pi agent loop (tools may fire)
 *     -> log messages to DB
 *     -> separated background jobs: turn extraction, periodic persona check
 *     -> reply + fresh scene state
 *
 * One prompt runs at a time per session.
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import {
	bumpSession,
	createSession,
	deleteSessionRow,
	getSession,
	incrementTurn,
	insertMessage,
	listSessions,
	recentMessages,
	type SessionRow,
} from "../db/chat.repo.js";
import { upsertPersona } from "../db/persona.repo.js";
import { initScene, loadScene } from "../db/scene.repo.js";
import { guardUserInput } from "../security/input-guard.js";
import { createRoleplayExtension } from "../extensions/index.js";
import { extractTurn } from "./extraction.js";
import { listPersonas, loadPersona, savePersonaToDisk, validatePersonaDoc } from "./persona-io.js";
import { renderCorePrompt, type PersonaDoc } from "./persona.js";
import { renderDynamicBlock, type MemorySnippet, type WorldbookSnippet } from "./prompt-builder.js";
import { retrieveForTurn } from "./retrieval.js";
import { createRoleplaySession, type RoleplaySession } from "./session.js";
import { DEFAULT_SCENE, type SceneState } from "./scene.js";
import { checkPersonaConsistency } from "./consistency-check.js";

export interface StreamEvent {
	type: "delta" | "tool_start" | "tool_end" | "state" | "done" | "error";
	text?: string;
	name?: string;
	isError?: boolean;
	scene?: SceneState;
	reply?: string;
	message?: string;
}

interface TurnContext {
	memories: MemorySnippet[];
	worldbook: WorldbookSnippet[];
	correction?: string;
}

export interface SessionHandle {
	row: SessionRow;
	persona: PersonaDoc;
	rp: RoleplaySession;
	scene: SceneState;
	turnCtx: TurnContext;
	busy: boolean;
	lastAssistantTexts: string[];
	currentStreamingText: string;
	subscribers: Set<(evt: StreamEvent) => void>;
}

function messageText(message: { content?: unknown }): string {
	const c = message.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
		.map((b) => b.text)
		.join("\n");
}

class Orchestrator {
	private handles = new Map<string, SessionHandle>();
	private personas = new Map<string, PersonaDoc>();
	private pendingJobs = new Set<Promise<unknown>>();

	/** Wait for all fire-and-forget background jobs (extraction, checks). */
	async settle(): Promise<void> {
		while (this.pendingJobs.size > 0) {
			const jobs = [...this.pendingJobs];
			await Promise.allSettled(jobs);
		}
	}

	private trackJob(p: Promise<unknown>): void {
		this.pendingJobs.add(p);
		p.finally(() => this.pendingJobs.delete(p)).catch(() => {});
	}

	hasBusySessions(): boolean {
		return [...this.handles.values()].some((handle) => handle.busy);
	}

	getPersona(id: string): PersonaDoc {
		let p = this.personas.get(id);
		if (!p) {
			p = loadPersona(id);
			this.personas.set(id, p);
			// Mirror into DB (structured doc + rendered core prompt).
			upsertPersona(p, renderCorePrompt(p)).catch((err) => console.error("[persona] db mirror failed:", err.message));
		}
		return p;
	}

	getPersonaName(id: string): string {
		try {
			return this.getPersona(id).name;
		} catch {
			return id;
		}
	}

	/**
	 * The configured default persona, falling back to the first available one
	 * when the configured id has no persona file yet (e.g. user renamed it in
	 * .env before creating the character).
	 */
	resolveDefaultPersona(): string {
		try {
			this.getPersona(config.app.defaultPersona);
			return config.app.defaultPersona;
		} catch {
			const first = this.listPersonaSummaries()[0]?.id;
			if (!first) throw new Error(`no personas available — put a YAML in data/personas/ or create one from the UI`);
			console.warn(`[persona] DEFAULT_PERSONA="${config.app.defaultPersona}" not found; falling back to "${first}"`);
			return first;
		}
	}

	/** All personas available for new stories. */
	listPersonaSummaries(): Array<{ id: string; name: string }> {
		return listPersonas().map((id) => {
			try {
				return { id, name: this.getPersona(id).name };
			} catch {
				return { id, name: id };
			}
		});
	}

	/**
	 * Create a persona from user input. The id is generated server-side
	 * (ASCII-safe); the rest is validated against the PersonaDoc schema and
	 * persisted to data/personas/ + mirrored into the persona table.
	 */
	createPersona(input: unknown): { id: string; name: string } {
		const raw = { ...((input as Record<string, unknown>) ?? {}) };
		const id = `rp-${randomBytes(4).toString("hex")}`;
		raw.id = id;
		const doc = validatePersonaDoc(raw);
		savePersonaToDisk(doc);
		this.personas.set(id, doc);
		upsertPersona(doc, renderCorePrompt(doc)).catch((err) => console.error("[persona] db mirror failed:", err.message));
		return { id, name: doc.name };
	}

	async newSession(personaId: string, title?: string): Promise<SessionRow> {
		const persona = this.getPersona(personaId);
		const sid = randomUUID();
		const sessionDir = path.join(config.paths.sessionsDir, sid);
		fs.mkdirSync(sessionDir, { recursive: true });
		const row = await createSession(personaId, undefined, title ?? `${persona.name} · 新剧情`);
		const scene: SceneState = {
			...DEFAULT_SCENE,
			location: persona.scene_defaults?.location ?? DEFAULT_SCENE.location,
			time_label: persona.scene_defaults?.time_label ?? DEFAULT_SCENE.time_label,
			mood: persona.scene_defaults?.mood ?? DEFAULT_SCENE.mood,
			relationship_note: persona.relationship.initial_relation.slice(0, 200),
		};
		await initScene(row.id, scene);
		await bumpSession(row.id);
		return row;
	}

	async listSessionsLite(): Promise<
		Array<{ id: string; title: string | null; persona_id: string; persona_name: string; turn_count: number; updated_at: Date }>
	> {
		const rows = await listSessions(50);
		return rows.map((r) => ({
			id: r.id,
			title: r.title,
			persona_id: r.persona_id,
			persona_name: this.getPersonaName(r.persona_id),
			turn_count: r.turn_count,
			updated_at: r.updated_at,
		}));
	}

	async getHistory(sessionId: string) {
		return recentMessages(sessionId, 200);
	}

	async getScene(sessionId: string): Promise<SceneState | undefined> {
		const handle = this.handles.get(sessionId);
		if (handle) return handle.scene;
		return loadScene(sessionId);
	}

	/** Open (or reopen) the pi session behind a chat session. */
	async open(sessionId: string): Promise<SessionHandle> {
		const existing = this.handles.get(sessionId);
		if (existing) return existing;

		const row = await getSession(sessionId);
		if (!row) throw new Error(`session not found: ${sessionId}`);
		const persona = this.getPersona(row.persona_id);
		const corePrompt = renderCorePrompt(persona);

		const partial: Omit<SessionHandle, "rp"> = {
			row,
			persona,
			scene: (await loadScene(sessionId)) ?? { ...DEFAULT_SCENE },
			turnCtx: { memories: [], worldbook: [] },
			busy: false,
			lastAssistantTexts: [],
			currentStreamingText: "",
			subscribers: new Set(),
		};
		const handleRef = { current: undefined as SessionHandle | undefined };

		// SessionManager.create needs an existing directory, otherwise it
		// falls back to the default pi session location.
		const sessionDir = path.join(config.paths.sessionsDir, sessionId);
		fs.mkdirSync(sessionDir, { recursive: true });

		const rp = await createRoleplaySession(
			{
				corePrompt,
				sessionDir: path.join(config.paths.sessionsDir, sessionId),
				resumeFile: row.pi_session_file ?? undefined,
			},
			{
				toolsEnabled: true,
				buildDynamicBlock: () => {
					const h = handleRef.current;
					if (!h) return "";
					return renderDynamicBlock({
						personaName: persona.name,
						scene: h.scene,
						memories: h.turnCtx.memories,
						worldbook: h.turnCtx.worldbook,
						correctionNotice: h.turnCtx.correction,
					});
				},
				extraExtensions: [
					createRoleplayExtension({
						sessionId,
						onSceneUpdate: (scene) => {
							const h = handleRef.current;
							if (h) {
								h.scene = scene;
								this.emit(sessionId, { type: "state", scene });
							}
						},
					}),
				],
				onEvent: (event) => this.onPiEvent(sessionId, event),
			},
		);

		// Persist pi's session file path for future resumes.
		if (rp.sessionFile && rp.sessionFile !== row.pi_session_file) {
			await bumpSession(sessionId, rp.sessionFile);
			row.pi_session_file = rp.sessionFile;
		}

		const handle: SessionHandle = { ...partial, rp };
		handleRef.current = handle;
		this.handles.set(sessionId, handle);
		return handle;
	}

	private onPiEvent(sessionId: string, event: { type: string; [k: string]: unknown }): void {
		const handle = this.handles.get(sessionId);
		if (!handle) return;

		if (event.type === "message_update") {
			const ame = event.assistantMessageEvent as { type: string; delta?: string } | undefined;
			if (ame?.type === "text_delta" && typeof ame.delta === "string") {
				handle.currentStreamingText += ame.delta;
				this.emit(sessionId, { type: "delta", text: ame.delta });
			}
			return;
		}

		if (event.type === "message_end") {
			const message = event.message as { role: string; content?: unknown; toolName?: string } | undefined;
			if (!message) return;
			if (message.role === "assistant") {
				const text = messageText(message);
				if (text.trim()) {
					handle.lastAssistantTexts.push(text);
					insertMessage(sessionId, handle.row.turn_count, "assistant", text).catch((err) =>
						console.error("[log] assistant insert failed:", err.message),
					);
				}
			}
			return;
		}

		if (event.type === "tool_execution_start") {
			this.emit(sessionId, { type: "tool_start", name: String(event.toolName ?? "") });
			return;
		}
		if (event.type === "tool_execution_end") {
			this.emit(sessionId, { type: "tool_end", name: String(event.toolName ?? ""), isError: Boolean(event.isError) });
		}
	}

	private emit(sessionId: string, evt: StreamEvent): void {
		const handle = this.handles.get(sessionId);
		if (!handle) return;
		for (const sub of handle.subscribers) {
			try {
				sub(evt);
			} catch {
				/* subscriber gone */
			}
		}
	}

	subscribe(sessionId: string, fn: (evt: StreamEvent) => void): () => void {
		const handle = this.handles.get(sessionId);
		if (!handle) throw new Error("session not open");
		handle.subscribers.add(fn);
		return () => handle.subscribers.delete(fn);
	}

	/** The single-turn pipeline. */
	async chat(sessionId: string, rawInput: unknown): Promise<{ reply: string; scene: SceneState }> {
		const handle = await this.open(sessionId);
		if (handle.busy) throw new Error("上一轮对话仍在进行，请稍候");

		const userText = guardUserInput(rawInput);
		handle.busy = true;
		handle.lastAssistantTexts = [];
		handle.currentStreamingText = "";

		try {
			// 1) Retrieve relevant long-term memory & worldbook for this turn.
			const retrieval = await retrieveForTurn(userText);

			// 2) Assemble per-turn context (correction consumed exactly once).
			handle.turnCtx = {
				memories: retrieval.memories,
				worldbook: retrieval.worldbook,
				correction: handle.turnCtx.correction,
			};
			const correction = handle.turnCtx.correction;
			handle.turnCtx.correction = undefined;

			// 3) Log & count the user turn, then run the agent.
			const turn = await incrementTurn(sessionId);
			handle.row.turn_count = turn;
			await insertMessage(sessionId, turn, "user", userText);

			await handle.rp.session.prompt(userText);

			// 4) Refresh scene cache from DB (tools/extraction may have changed it).
			const freshScene = await loadScene(sessionId);
			if (freshScene) {
				handle.scene = freshScene;
				this.emit(sessionId, { type: "state", scene: freshScene });
			}

			const reply = handle.lastAssistantTexts.join("\n\n").trim() || handle.currentStreamingText.trim();
			await bumpSession(sessionId);

			// 5) Separated background jobs — fire-and-forget, never block the reply.
			this.trackJob(
				this.backgroundJobs(sessionId, handle, userText, reply, turn).catch((err) =>
					console.error("[background] jobs failed:", err.message),
				),
			);

			return { reply, scene: handle.scene };
		} finally {
			handle.busy = false;
		}
	}

	private async backgroundJobs(sessionId: string, handle: SessionHandle, userText: string, reply: string, turn: number): Promise<void> {
		// Turn extraction (separate model call, does not touch session context).
		if (reply.trim()) {
			await extractTurn(sessionId, userText, reply).catch((err) => console.error("[extract] turn failed:", err.message));
		}
		// Periodic persona consistency check (separate model call).
		if (config.app.checkEveryTurns > 0 && turn % config.app.checkEveryTurns === 0) {
			const correction = await checkPersonaConsistency(handle).catch((err) => {
				console.error("[consistency] check failed:", err.message);
				return undefined;
			});
			if (correction) {
				handle.turnCtx.correction = correction;
				console.log(`[consistency] correction queued for next turn (session ${sessionId})`);
			}
		}
	}

	dispose(sessionId: string): void {
		const handle = this.handles.get(sessionId);
		if (handle) {
			handle.rp.dispose();
			this.handles.delete(sessionId);
		}
	}

	/** Remove a session: DB row + pi session files. */
	async deleteSession(sessionId: string): Promise<void> {
		this.dispose(sessionId);
		await deleteSessionRow(sessionId);
		const dir = path.join(config.paths.sessionsDir, sessionId);
		fs.rmSync(dir, { recursive: true, force: true });
	}

	disposeAll(): void {
		for (const id of [...this.handles.keys()]) this.dispose(id);
	}
}

export const orchestrator = new Orchestrator();
