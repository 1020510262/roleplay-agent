/**
 * Stage-2 smoke test: pi SDK agent loop + structured YAML persona + dynamic
 * per-turn prompt assembly (scene state). No database yet.
 *
 *   node test/smoke.mjs                 # interactive REPL
 *   node test/smoke.mjs --once "你好"   # single prompt, then exit
 */
import readline from "node:readline";
import { createRoleplaySession } from "../dist/agent/session.js";
import { HARDCODED_PERSONA, renderCorePrompt } from "../dist/agent/persona.js";
import { loadPersona } from "../dist/agent/persona-io.js";
import { DEFAULT_SCENE } from "../dist/agent/scene.js";
import { renderDynamicBlock } from "../dist/agent/prompt-builder.js";
import { config } from "../dist/config.js";

let persona;
try {
	persona = loadPersona(config.app.defaultPersona);
	console.log(`[smoke] loaded persona from YAML: ${persona.name} v${persona.version}`);
} catch (err) {
	console.warn(`[smoke] YAML persona unavailable (${err.message}); using hardcoded fallback`);
	persona = HARDCODED_PERSONA;
}

const corePrompt = renderCorePrompt(persona);
const scene = {
	...DEFAULT_SCENE,
	location: persona.scene_defaults?.location ?? DEFAULT_SCENE.location,
	time_label: persona.scene_defaults?.time_label ?? DEFAULT_SCENE.time_label,
	mood: persona.scene_defaults?.mood ?? DEFAULT_SCENE.mood,
};

const handle = await createRoleplaySession(
	{ corePrompt },
	{
		// Stage 2: dynamic block = scene state only. Stage 3 adds retrieved
		// memories/worldbook; stage 4 adds correction notices.
		buildDynamicBlock: () =>
			renderDynamicBlock({ personaName: persona.name, scene, memories: [], worldbook: [] }),
		onEvent: (event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
		},
	},
);

console.log(`[smoke] session ${handle.sessionId} ready\n`);

const onceIdx = process.argv.indexOf("--once");
if (onceIdx !== -1) {
	const prompt = process.argv.slice(onceIdx + 1).join(" ") || "你好";
	process.stdout.write(`玩家: ${prompt}\n${persona.name}: `);
	await handle.session.prompt(prompt);
	console.log("\n[smoke] done");
	handle.dispose();
	process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
console.log("输入对话开始（/exit 退出）\n");

for await (const line of rl) {
	const text = line.trim();
	if (!text) continue;
	if (text === "/exit" || text === "/quit") break;
	process.stdout.write(`${persona.name}: `);
	try {
		await handle.session.prompt(text);
		process.stdout.write("\n\n");
	} catch (err) {
		console.error("\n[error]", err?.message ?? err);
	}
}

handle.dispose();
process.exit(0);
