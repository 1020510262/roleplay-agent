/**
 * Lightweight keyword extraction for retrieval-injection.
 * Deliberately simple (no tokenizer dependency): CJK bigrams + runs, ASCII
 * words. Postgres has no Chinese FTS parser installed, so matching is
 * array-overlap + ILIKE based (see memory.repo.ts).
 */

const STOPWORDS = new Set([
	"我们", "你们", "他们", "什么", "怎么", "这个", "那个", "一个", "可以",
	"没有", "不是", "就是", "还是", "因为", "所以", "但是", "如果", "然后",
	"现在", "今天", "明天", "昨天", "自己", "知道", "觉得", "时候", "东西",
	"the", "and", "for", "with", "this", "that", "have", "will", "you",
]);

export function extractKeywords(text: string, max = 12): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (w: string) => {
		const k = w.toLowerCase();
		if (seen.has(k) || STOPWORDS.has(k)) return;
		seen.add(k);
		out.push(k);
	};

	// CJK runs: keep whole run (if short) and bigrams.
	const cjkRuns = text.match(/[一-鿿㐀-䶿]{2,}/g) ?? [];
	for (const run of cjkRuns) {
		if (run.length <= 4) push(run);
		for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2));
	}

	// ASCII words.
	const ascii = text.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g) ?? [];
	for (const w of ascii) push(w);

	return out.slice(0, max);
}
