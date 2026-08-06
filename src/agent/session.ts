/**
 * Roleplay session factory — embeds pi in SDK mode.
 *
 * Each chat session owns one pi AgentSession backed by an in-memory or
 * file-persisted SessionManager. A single inline extension provides:
 *   - before_agent_start: appends the PER-TURN dynamic block (scene state,
 *     retrieved memories, correction notice) to the system prompt. The core
 *     persona prompt itself never changes after session creation.
 *   - (stage 3+) the roleplay tools and pre-compaction memory extraction.
 */
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getModelRuntime, getMainModel } from "./runtime.js";

export interface RoleplaySessionDeps {
	/**
	 * Build the dynamic per-turn block appended to the system prompt.
	 * Receives the raw user prompt; must be side-effect free and fast.
	 * May return empty string.
	 */
	buildDynamicBlock?: (userPrompt: string) => Promise<string> | string;
	/** Extra inline extensions (stage-3 tools etc.). */
	extraExtensions?: InlineExtension[];
	/** Stage 1: no tools at all. Stage 3+: only builtins disabled. */
	toolsEnabled?: boolean;
	/** Called for every session event (streaming, logging hooks). */
	onEvent?: (event: AgentSessionEvent) => void;
	/** Compaction settings override. */
	compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
}

export interface RoleplaySessionOptions {
	/** Immutable core system prompt (rendered persona). */
	corePrompt: string;
	/** Persist pi session files under this directory (new session). */
	sessionDir?: string;
	/** Resume an existing pi session file. */
	resumeFile?: string;
}

export interface RoleplaySession {
	session: AgentSession;
	sessionId: string;
	sessionFile?: string;
	dispose(): void;
}

/** Isolated pi "home" dir so nothing global (~/.pi) leaks in. */
const PI_HOME = path.join(config.paths.dataDir, "pi-home");

export async function createRoleplaySession(
	options: RoleplaySessionOptions,
	deps: RoleplaySessionDeps = {},
): Promise<RoleplaySession> {
	fs.mkdirSync(PI_HOME, { recursive: true });

	const modelRuntime: ModelRuntime = await getModelRuntime();
	const model = await getMainModel();

	// The dynamic-block extension: runs before each agent run and appends
	// mutable context to the (otherwise immutable) system prompt.
	const dynamicBlockExtension: InlineExtension = {
		name: "roleplay-dynamic-context",
		factory: (pi) => {
			pi.on("before_agent_start", async (event) => {
				if (!deps.buildDynamicBlock) return;
				const block = await deps.buildDynamicBlock(event.prompt ?? "");
				if (!block || block.trim() === "") return;
				return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
			});
		},
	};

	const loader = new DefaultResourceLoader({
		cwd: config.paths.sessionsDir,
		agentDir: PI_HOME,
		systemPromptOverride: () => options.corePrompt,
		extensionFactories: [dynamicBlockExtension, ...(deps.extraExtensions ?? [])],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const sessionManager = options.resumeFile
		? SessionManager.open(options.resumeFile)
		: options.sessionDir
			? SessionManager.create(config.paths.sessionsDir, options.sessionDir)
			: SessionManager.inMemory(config.paths.sessionsDir);

	const compactionSettings: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number } = {
		enabled: deps.compaction?.enabled ?? true,
	};
	if (deps.compaction?.reserveTokens !== undefined) compactionSettings.reserveTokens = deps.compaction.reserveTokens;
	if (deps.compaction?.keepRecentTokens !== undefined) compactionSettings.keepRecentTokens = deps.compaction.keepRecentTokens;
	const settingsManager = SettingsManager.inMemory({
		compaction: compactionSettings,
		retry: { enabled: true, maxRetries: 3 },
	});

	const { session } = await createAgentSession({
		cwd: config.paths.sessionsDir,
		agentDir: PI_HOME,
		model,
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
		...(deps.toolsEnabled
			? { noTools: "builtin" } // keep extension tools, drop read/bash/edit/write
			: { noTools: "all" }), // stage 1: zero tools
	});

	const unsubscribe = deps.onEvent ? session.subscribe(deps.onEvent) : undefined;

	return {
		session,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		dispose() {
			unsubscribe?.();
			session.dispose();
		},
	};
}
