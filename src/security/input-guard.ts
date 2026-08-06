/**
 * User-input guard. Player input is UNTRUSTED: it only ever travels as a
 * `user` role message — never concatenated into system prompts, SQL, or
 * shell. This module normalizes and bounds it at the edge.
 */
import { config } from "../config.js";
import { cleanText } from "./tool-validation.js";

export class InputRejected extends Error {}

export function guardUserInput(raw: unknown): string {
	if (typeof raw !== "string") throw new InputRejected("输入必须是文本");
	// Trim to hard cap before anything else touches it.
	const clipped = raw.slice(0, config.app.maxInputChars * 2);
	const text = cleanText(clipped).replace(/\n{4,}/g, "\n\n\n");
	if (text.length === 0) throw new InputRejected("输入为空");
	if (text.length > config.app.maxInputChars) {
		throw new InputRejected(`输入过长（最多 ${config.app.maxInputChars} 字）`);
	}
	return text;
}

/**
 * HTML-escape for any place where model/user text is embedded into HTML.
 * The frontend additionally renders via textContent — defense in depth.
 */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
