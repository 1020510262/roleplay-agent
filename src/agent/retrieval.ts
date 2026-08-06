/**
 * Retrieval-style injection for long-term memory (layer 2) and worldbook.
 *
 * We never stuff all memories into context: keywords from the current user
 * turn pull candidate rows, we score them in JS, and only the top-K go into
 * the per-turn dynamic block.
 */
import { searchMemoryCandidates, type MemoryRow } from "../db/memory.repo.js";
import { searchWorldbookCandidates, type WorldbookRow } from "../db/worldbook.repo.js";
import { config } from "../config.js";
import { extractKeywords } from "./keywords.js";
import type { MemorySnippet, WorldbookSnippet } from "./prompt-builder.js";

function scoreHits(keywords: string[], haystack: string): number {
	const lower = haystack.toLowerCase();
	let hits = 0;
	for (const k of keywords) if (lower.includes(k)) hits++;
	return hits;
}

function relativeWhen(d: Date): string {
	const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
	if (days <= 0) return "今天早些";
	if (days === 1) return "昨天";
	if (days < 7) return `${days} 天前`;
	if (days < 30) return `${Math.floor(days / 7)} 周前`;
	return `${Math.floor(days / 30)} 个月前`;
}

export interface RetrievalResult {
	memories: MemorySnippet[];
	worldbook: WorldbookSnippet[];
	keywords: string[];
}

/** Retrieve relevant snippets for a user turn. Failure degrades to empty. */
export async function retrieveForTurn(userText: string): Promise<RetrievalResult> {
	const empty: RetrievalResult = { memories: [], worldbook: [], keywords: [] };
	try {
		const keywords = extractKeywords(userText);
		if (keywords.length === 0) return empty;

		const [memCandidates, wbCandidates] = await Promise.all([
			searchMemoryCandidates(keywords, 40),
			searchWorldbookCandidates(keywords, 20),
		]);

		const scoredMem = memCandidates
			.map((row: MemoryRow) => {
				const entityHits = row.entities.filter((e) => keywords.some((k) => e.toLowerCase().includes(k) || k.includes(e.toLowerCase()))).length;
				const tagHits = row.tags.filter((t) => keywords.some((k) => t.toLowerCase().includes(k) || k.includes(t.toLowerCase()))).length;
				const textHits = scoreHits(keywords, row.summary);
				const ageDays = (Date.now() - row.created_at.getTime()) / 86_400_000;
				const recency = Math.max(0, 2 - ageDays / 14); // small fresh-memory boost
				return { row, score: entityHits * 3 + tagHits * 2 + textHits + row.importance * 0.5 + recency };
			})
			.filter((s) => s.score >= 2)
			.sort((a, b) => b.score - a.score);

		const scoredWb = wbCandidates
			.map((row: WorldbookRow) => {
				const entityHits = row.entities.filter((e) => keywords.some((k) => e.toLowerCase().includes(k) || k.includes(e.toLowerCase()))).length;
				const titleHits = scoreHits(keywords, row.title);
				const contentHits = scoreHits(keywords, row.content);
				return { row, score: entityHits * 3 + titleHits * 2 + contentHits };
			})
			.filter((s) => s.score >= 3)
			.sort((a, b) => b.score - a.score);

		return {
			memories: scoredMem.slice(0, config.app.memoryTopK).map((s) => ({
				summary: s.row.summary,
				kind: s.row.kind,
				when: relativeWhen(s.row.created_at),
			})),
			worldbook: scoredWb.slice(0, 2).map((s) => ({ title: s.row.title, content: s.row.content })),
			keywords,
		};
	} catch (err) {
		console.error("[retrieval] failed, degrading to empty:", (err as Error).message);
		return empty;
	}
}
