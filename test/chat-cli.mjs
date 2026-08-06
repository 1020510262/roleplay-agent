/**
 * Stage-3 CLI test: full pipeline — orchestrator + Postgres memory + tools.
 *
 *   node test/chat-cli.mjs                     # new session, REPL
 *   node test/chat-cli.mjs --session <id>      # resume existing session
 *   node test/chat-cli.mjs --turns "a" "b" ... # scripted turns, then exit
 */
import readline from "node:readline";
import { orchestrator } from "../dist/agent/orchestrator.js";
import { config } from "../dist/config.js";
import { query } from "../dist/db/pool.js";

const args = process.argv.slice(2);
const sessionIdx = args.indexOf("--session");
const turnsIdx = args.indexOf("--turns");

let sessionId;
if (sessionIdx !== -1 && args[sessionIdx + 1]) {
	sessionId = args[sessionIdx + 1];
	console.log(`[cli] resuming session ${sessionId}`);
} else {
	const row = await orchestrator.newSession(config.app.defaultPersona);
	sessionId = row.id;
	console.log(`[cli] new session ${sessionId} (${row.title})`);
}

const persona = orchestrator.getPersona(config.app.defaultPersona);
const scene = await orchestrator.getScene(sessionId);
console.log(`[cli] persona: ${persona.name} | scene: ${scene?.location} / ${scene?.mood} | 好感度 ${scene?.relationship_score}\n`);

// Open the pi session up front so streaming/tool events show from turn 1.
await orchestrator.open(sessionId);
const unsubscribe = orchestrator.subscribe(sessionId, (evt) => {
	if (evt.type === "delta") process.stdout.write(evt.text);
	else if (evt.type === "tool_start") process.stdout.write(`\n  ⚙ [${evt.name}] `);
	else if (evt.type === "tool_end") process.stdout.write(evt.isError ? "✗\n" : "✓\n");
});

async function oneTurn(text) {
	process.stdout.write(`玩家: ${text}\n${persona.name}: `);
	const { scene: sc } = await orchestrator.chat(sessionId, text);
	process.stdout.write(`\n  ⟢ 场景: ${sc.location} | ${sc.time_label} | ${sc.mood} | 好感度 ${sc.relationship_score}\n\n`);
}

if (turnsIdx !== -1) {
	for (const t of args.slice(turnsIdx + 1)) {
		await oneTurn(t);
	}
	console.log("[cli] waiting for background extraction/check jobs...");
	await orchestrator.settle();
	const mem = await query("SELECT id, kind, left(summary, 80) AS summary, entities, source FROM memory_summaries ORDER BY id");
	console.log(`\n[cli] memory_summaries rows: ${mem.rows.length}`);
	for (const r of mem.rows) console.log(`  #${r.id} [${r.kind}/${r.source}] ${r.summary} {${(r.entities ?? []).join(",")}}`);
	unsubscribe();
	orchestrator.disposeAll();
	process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
console.log("输入对话开始（/exit 退出, /scene 查看场景）\n");
for await (const line of rl) {
	const text = line.trim();
	if (!text) continue;
	if (text === "/exit" || text === "/quit") break;
	if (text === "/scene") {
		console.log(JSON.stringify(await orchestrator.getScene(sessionId), null, 2));
		continue;
	}
	try {
		await oneTurn(text);
	} catch (err) {
		console.error("[error]", err?.message ?? err);
	}
}
orchestrator.disposeAll();
process.exit(0);
