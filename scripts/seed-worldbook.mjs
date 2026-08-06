/**
 * Seed worldbook entries for the 林晚晴 scenario. Idempotent (upsert by key).
 *   node scripts/seed-worldbook.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const entries = [
	{
		entry_key: "shiguang-bookstore",
		title: "海边小镇",
		content:
			"小镇临海，古老质谱",
		entities: ["海边小镇", "防波提", "浪花"],
		tags: ["地点", "沙滩"],
	},
	{
		entry_key: "master-gu",
		title: "顾老先生（顾怀瑾）",
		content:
			"林晚晴的恩师，版本目录学大家，脾气古怪但对晚晴极好。三年前秋天留下一句「我去找一本书」便失踪，只寄出过最后一封信——那封信至今没有寄到。警方按失踪人口结过案。他习惯在藏书扉页盖一枚「拾光」小印。",
		entities: ["顾老先生", "顾怀瑾", "林晚晴"],
		tags: ["人物", "失踪", "恩师"],
	},
	{
		entry_key: "the-last-letter",
		title: "最后一封信",
		content:
			"顾老先生失踪前寄给林晚晴的信，邮路显示「已投递」，但晚晴从未收到。她查过邮局的旧档，跑遍附近每一个代收点。信封据说用的是老先生自制的桑皮纸，邮戳是邻市「溪口镇」。这是晚晴心里最大的结。",
		entities: ["最后一封信", "顾老先生", "溪口镇", "桑皮纸"],
		tags: ["伏笔", "信件", "谜团"],
	},
	{
		entry_key: "pocket-watch",
		title: "旧怀表手链",
		content:
			"晚晴左手腕上的手链，由一只走时不准的旧怀表改的——顾老先生留下的物件。表永远慢七分钟，走了四十年。老先生说过：「慢七分钟好，凡事都来得及。」晚晴从不修它。",
		entities: ["旧怀表", "怀表手链", "顾老先生", "林晚晴"],
		tags: ["物品", "信物"],
	},
	{
		entry_key: "old-town-redevelopment",
		title: "老城区改造",
		content:
			"青石巷一带去年被划进旧城改造范围，街坊一半盼拆迁一半舍不得。拾光书屋的产权是顾老先生留下的，晚晴收到过几次收购邀约，都回绝了。巷口的修表铺已经搬走，杂货铺上个月也关了门。",
		entities: ["青石巷", "旧城改造", "拾光书屋"],
		tags: ["背景", "冲突"],
	},
	{
		entry_key: "postman-old-zhou",
		title: "邮递员老周",
		content:
			"负责青石巷片区三十年的老邮递员，已经退休。他记得顾老先生常寄挂号信，也记得三年前那个秋天替老先生收走最后一批信。晚晴偶尔提着点心去看他，想从那几年的记忆里再捞出点什么。",
		entities: ["老周", "邮递员", "顾老先生"],
		tags: ["人物", "线索"],
	},
];

const pool = new pg.Pool({
	host: process.env.PGHOST,
	port: Number(process.env.PGPORT ?? 5432),
	database: process.env.PGDATABASE,
	user: process.env.PGUSER,
	password: process.env.PGPASSWORD,
});

for (const e of entries) {
	await pool.query(
		`INSERT INTO worldbook (entry_key, title, content, entities, tags)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (entry_key) DO UPDATE
		 SET title = EXCLUDED.title, content = EXCLUDED.content,
		     entities = EXCLUDED.entities, tags = EXCLUDED.tags, updated_at = now()`,
		[e.entry_key, e.title, e.content, e.entities, e.tags],
	);
	console.log(`[seed] ${e.entry_key}`);
}
console.log(`[seed] ${entries.length} worldbook entries upserted`);
await pool.end();
