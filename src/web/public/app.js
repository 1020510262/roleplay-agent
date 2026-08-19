/*
 * Chat frontend. Security model: ALL model/user text is rendered through
 * textContent / createElement — never innerHTML. The only "formatting" is
 * splitting parenthesized stage directions into <em class="action"> nodes,
 * done by creating elements, not by parsing HTML.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = $("send");

let currentSession = null;
let personaName = "角色";
let busy = false;
let activeModelId = null;

async function api(path, opts = {}) {
	const res = await fetch(path, {
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		...opts,
	});
	if (res.status === 401) {
		location.href = "/";
		throw new Error("unauthorized");
	}
	return res;
}

/** Split text into runs of dialogue vs （stage directions）. Safe by construction. */
function renderRichText(container, text) {
	const re = /（[^（）]*）|\([^()]*\)/g;
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (m.index > last) {
			container.appendChild(document.createTextNode(text.slice(last, m.index)));
		}
		const em = document.createElement("em");
		em.className = "action";
		em.textContent = m[0];
		container.appendChild(em);
		last = m.index + m[0].length;
	}
	if (last < text.length) {
		container.appendChild(document.createTextNode(text.slice(last)));
	}
}

function addBubble(role, text) {
	const wrap = document.createElement("div");
	wrap.className = `msg ${role}`;
	const label = document.createElement("div");
	label.className = "msg-label";
	label.textContent = role === "user" ? "你" : personaName;
	const bubble = document.createElement("div");
	bubble.className = "bubble";
	if (text) renderRichText(bubble, text);
	wrap.appendChild(label);
	wrap.appendChild(bubble);
	messagesEl.appendChild(wrap);
	messagesEl.scrollTop = messagesEl.scrollHeight;
	return bubble;
}

function setChip(text) {
	const chips = $("scene-chips");
	while (chips.firstChild) chips.removeChild(chips.firstChild);
	if (text) {
		const span = document.createElement("span");
		span.className = "chip";
		span.textContent = text;
		chips.appendChild(span);
	}
}

function renderScene(scene) {
	if (!scene) return;
	setChip(`${scene.location || "—"} · ${scene.time_label || "—"} · ${scene.mood || "—"}`);
	const dl = $("scene-details");
	while (dl.firstChild) dl.removeChild(dl.firstChild);
	const rows = [
		["地点", scene.location],
		["时间", scene.time_label],
		["情绪", scene.mood],
		["关系", scene.relationship_note],
		["备注", scene.notes],
	];
	for (const [k, v] of rows) {
		if (!v) continue;
		const dt = document.createElement("dt");
		dt.textContent = k;
		const dd = document.createElement("dd");
		dd.textContent = v;
		dl.appendChild(dt);
		dl.appendChild(dd);
	}
	const score = Math.max(0, Math.min(100, Number(scene.relationship_score) || 0));
	$("affinity-num").textContent = `${score}/100`;
	$("affinity-fill").style.width = `${score}%`;
	$("scene-events").textContent = scene.ongoing_events || "";
}

function setToolIndicator(on) {
	$("tool-indicator").hidden = !on;
}

async function loadSessions() {
	const res = await api("/api/sessions");
	const data = await res.json();
	const sel = $("session-select");
	while (sel.firstChild) sel.removeChild(sel.firstChild);
	for (const s of data.sessions) {
		const opt = document.createElement("option");
		opt.value = s.id;
		let t = s.title ?? s.id.slice(0, 8);
		if (s.persona_name && t.startsWith(`${s.persona_name} · `)) t = t.slice(s.persona_name.length + 3);
		opt.textContent = `${s.persona_name ?? s.persona_id} · ${t}（${s.turn_count} 轮）`;
		sel.appendChild(opt);
	}
	if (currentSession) sel.value = currentSession;
	return data.sessions;
}

function modelLabel(model) {
	return `${model.name} · ${model.modelId}`;
}

async function loadModels() {
	const res = await api("/api/models");
	const data = await res.json();
	const sel = $("model-select");
	while (sel.firstChild) sel.removeChild(sel.firstChild);
	for (const model of data.models ?? []) {
		const opt = document.createElement("option");
		opt.value = model.id;
		opt.textContent = modelLabel(model);
		sel.appendChild(opt);
	}
	activeModelId = data.activeId;
	sel.value = activeModelId;
	return data;
}

async function openSession(id, { scrollToEnd = true } = {}) {
	currentSession = id;
	while (messagesEl.firstChild) messagesEl.removeChild(messagesEl.firstChild);
	const [msgRes, sceneRes, listRes] = await Promise.all([
		api(`/api/sessions/${id}/messages`),
		api(`/api/sessions/${id}`),
		api("/api/sessions"),
	]);
	const msgs = await msgRes.json();
	const scene = await sceneRes.json();
	const list = await listRes.json();
	const meta = list.sessions.find((s) => s.id === id);
	if (meta?.persona_name) {
		personaName = meta.persona_name;
		document.title = personaName;
		$("persona-name").textContent = personaName;
	}
	for (const m of msgs.messages) addBubble(m.role, m.content);
	renderScene(scene.scene);
	if (scrollToEnd) messagesEl.scrollTop = messagesEl.scrollHeight;
	await loadSessions();
}

async function send() {
	const text = inputEl.value.trim();
	if (!text || busy || !currentSession) return;
	busy = true;
	sendBtn.disabled = true;
	inputEl.value = "";

	addBubble("user", text);
	const bubble = addBubble("assistant", "");
	let acc = "";
	let toolDepth = 0;

	try {
		const res = await fetch(`/api/sessions/${currentSession}/messages`, {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (res.status === 401) {
			location.href = "/";
			return;
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf("\n\n")) !== -1) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				for (const line of frame.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					let evt;
					try {
						evt = JSON.parse(line.slice(6));
					} catch {
						continue;
					}
					if (evt.type === "delta" && evt.text) {
						acc += evt.text;
						while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
						renderRichText(bubble, acc);
						messagesEl.scrollTop = messagesEl.scrollHeight;
					} else if (evt.type === "tool_start") {
						toolDepth++;
						setToolIndicator(true);
					} else if (evt.type === "tool_end") {
						toolDepth = Math.max(0, toolDepth - 1);
						if (toolDepth === 0) setToolIndicator(false);
					} else if (evt.type === "state" && evt.scene) {
						renderScene(evt.scene);
					} else if (evt.type === "done") {
						if (evt.scene) renderScene(evt.scene);
					} else if (evt.type === "error") {
						bubble.textContent = `（出错：${evt.message ?? "未知错误"}）`;
					}
				}
			}
		}
		if (!acc && !bubble.textContent) {
			bubble.textContent = "（没有回应）";
		}
	} catch (err) {
		bubble.textContent = `（网络错误：${err.message}）`;
	} finally {
		setToolIndicator(false);
		busy = false;
		sendBtn.disabled = false;
		inputEl.focus();
		await loadSessions();
	}
}

sendBtn.addEventListener("click", send);
inputEl.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		send();
	}
});

// ── 新剧情（选择已有角色 / 创建新角色） ──────────────────────────
const modal = $("story-modal");

function openModal() {
	if (busy) return;
	$("persona-select").innerHTML = "";
	void (async () => {
		const res = await api("/api/me");
		const me = await res.json();
		const sel = $("persona-select");
		for (const p of me.personas) {
			const opt = document.createElement("option");
			opt.value = p.id;
			opt.textContent = p.name;
			sel.appendChild(opt);
		}
	})();
	modal.hidden = false;
}

function closeModal() {
	modal.hidden = true;
}

function linesOf(id) {
	return (document.getElementById(id).value || "").split("\n").map((s) => s.trim()).filter(Boolean);
}
function listOf(id) {
	return (document.getElementById(id).value || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}
function valOf(id) {
	return document.getElementById(id).value.trim();
}

function collectPersonaForm() {
	// required fields live on the 扮演角色 tab
	const required = [
		["f-name", "角色名"],
		["f-traits", "性格特征"],
		["f-tone", "语言风格"],
		["f-never", "行为边界"],
		["f-relation", "与玩家的初始关系"],
	];
	for (const [id, label] of required) {
		if (!valOf(id)) {
			document.querySelector('[data-tab="tab-char"]').click();
			alert(`请填写「${label}」`);
			document.getElementById(id).focus();
			return null;
		}
	}
	const hasAny = (...ids) => ids.some((id) => valOf(id));
	const player = hasAny("p-name", "p-gender", "p-age", "p-occupation", "p-appearance", "p-background", "p-traits")
		? {
				name: valOf("p-name") || undefined,
				gender: valOf("p-gender") || undefined,
				age: valOf("p-age") || undefined,
				occupation: valOf("p-occupation") || undefined,
				appearance: valOf("p-appearance") || undefined,
				background: valOf("p-background") || undefined,
				personality: linesOf("p-traits"),
			}
		: undefined;

	const world = valOf("w-setting") ? { setting: valOf("w-setting") } : undefined;

	return {
		name: valOf("f-name"),
		...(player ? { player } : {}),
		...(world ? { world } : {}),
		basic_info: {
			gender: valOf("f-gender") || undefined,
			age: valOf("f-age") || undefined,
			occupation: valOf("f-occupation") || undefined,
			appearance: valOf("f-appearance") || undefined,
			background: valOf("f-background") || undefined,
		},
		personality: {
			core_traits: linesOf("f-traits"),
			values: valOf("f-values") || undefined,
			inner_conflict: valOf("f-conflict") || undefined,
		},
		speech_style: {
			tone: valOf("f-tone"),
			vocabulary: listOf("f-vocab"),
			interjections: listOf("f-interjections"),
			sentence_patterns: linesOf("f-patterns"),
			sample_lines: linesOf("f-samples"),
		},
		boundaries: {
			never_do: linesOf("f-never"),
			topics_to_avoid: linesOf("f-avoid"),
		},
		relationship: {
			initial_relation: valOf("f-relation"),
			backstory: valOf("f-relationship-go") || undefined,
		},
		scene_defaults: {
			location: valOf("f-loc") || undefined,
			time_label: valOf("f-time") || undefined,
			mood: valOf("f-mood") || undefined,
		},
	};
}

// ── persona form tabs ────────────────────────────────────
document.querySelectorAll(".tabs .tab").forEach((btn) => {
	btn.addEventListener("click", () => {
		document.querySelectorAll(".tabs .tab").forEach((b) => b.classList.toggle("active", b === btn));
		document.querySelectorAll(".tab-pane").forEach((p) => {
			p.hidden = p.id !== btn.dataset.tab;
		});
	});
});

$("char-more-toggle").addEventListener("click", () => {
	const more = $("char-more");
	more.hidden = !more.hidden;
	$("char-more-toggle").textContent = more.hidden ? "＋ 更多设定（外貌 / 价值观 / 台词等）" : "－ 收起更多设定";
});

async function startStory(personaId) {
	const res = await api("/api/sessions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ personaId }),
	});
	const data = await res.json();
	if (data.session) {
		closeModal();
		await openSession(data.session.id);
	} else {
		alert(data.error ?? "创建剧情失败");
	}
}

$("new-session").addEventListener("click", openModal);
$("modal-close").addEventListener("click", closeModal);

$("delete-session").addEventListener("click", async () => {
	if (!currentSession || busy) return;
	if (!confirm("删除当前剧情？此操作不可恢复。")) return;
	const res = await api(`/api/sessions/${currentSession}`, { method: "DELETE" });
	if (!res.ok) {
		alert("删除失败");
		return;
	}
	const sessions = await loadSessions();
	if (sessions.length > 0) {
		await openSession(sessions[0].id);
	} else {
		await startStory((await (await api("/api/me")).json()).defaultPersona);
	}
});
modal.addEventListener("click", (e) => {
	if (e.target === modal) closeModal();
});

$("start-existing").addEventListener("click", () => startStory($("persona-select").value));

$("create-persona").addEventListener("click", async () => {
	const body = collectPersonaForm();
	if (!body) return;
	const btn = $("create-persona");
	btn.disabled = true;
	try {
		const res = await api("/api/personas", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = await res.json();
		if (!res.ok) {
			alert(data.error ?? "创建角色失败");
			return;
		}
		await startStory(data.persona.id);
		resetPersonaForm();
	} finally {
		btn.disabled = false;
	}
});

function resetPersonaForm() {
	for (const el of modal.querySelectorAll("input, textarea")) el.value = "";
}

$("session-select").addEventListener("change", async (e) => {
	if (!busy && e.target.value) await openSession(e.target.value);
});

// ── 模型设置与全局切换 ───────────────────────────────────
const modelModal = $("model-modal");

function setModelStatus(message, isError = false) {
	const el = $("model-status");
	el.textContent = message;
	el.classList.toggle("error", isError);
}

$("add-model").addEventListener("click", () => {
	if (busy) return;
	setModelStatus("");
	modelModal.hidden = false;
});
$("model-modal-close").addEventListener("click", () => { modelModal.hidden = true; });
modelModal.addEventListener("click", (e) => { if (e.target === modelModal) modelModal.hidden = true; });

$("save-model").addEventListener("click", async () => {
	const body = {
		name: valOf("m-name"),
		modelId: valOf("m-id"),
		baseUrl: valOf("m-url"),
		apiKey: valOf("m-key"),
		api: valOf("m-api"),
		contextWindow: Number(valOf("m-context")),
		maxTokens: Number(valOf("m-max-tokens")),
	};
	const btn = $("save-model");
	btn.disabled = true;
	setModelStatus("正在测试模型连接…");
	try {
		const res = await api("/api/models", { method: "POST", body: JSON.stringify(body) });
		const data = await res.json();
		if (!res.ok) {
			setModelStatus(data.modelConnectionFailed ? `模型无法联通：${data.error}` : data.error ?? "模型配置无效", true);
			return;
		}
		$("m-key").value = "";
		setModelStatus(`连接成功（${data.test.latencyMs} ms），模型已保存。`);
		await loadModels();
		setTimeout(() => { modelModal.hidden = true; }, 700);
	} catch (err) {
		setModelStatus(`网络错误：${err.message}`, true);
	} finally {
		btn.disabled = false;
	}
});

$("model-select").addEventListener("change", async (e) => {
	if (busy) {
		e.target.value = activeModelId;
		return;
	}
	const nextId = e.target.value;
	e.target.disabled = true;
	try {
		const res = await api("/api/models/active", { method: "PUT", body: JSON.stringify({ id: nextId }) });
		const data = await res.json();
		if (!res.ok) {
			alert(data.modelConnectionFailed ? `模型无法联通：${data.error}\n\n其他链路未受影响，请检查该模型服务。` : data.error ?? "切换模型失败");
			e.target.value = activeModelId;
			return;
		}
		activeModelId = data.model.id;
		e.target.value = activeModelId;
	} catch (err) {
		alert(`切换模型失败：${err.message}`);
		e.target.value = activeModelId;
	} finally {
		e.target.disabled = false;
	}
});

$("logout").addEventListener("click", async () => {
	await api("/api/logout", { method: "POST" }).catch(() => {});
	location.href = "/";
});

(async function init() {
	try {
		const res = await api("/api/me");
		const me = await res.json();
		await loadModels();
		personaName = me.displayName ?? me.defaultPersona ?? "角色";
		document.title = personaName;
		$("persona-name").textContent = personaName;
		const sessions = await loadSessions();
		if (sessions.length > 0) {
			await openSession(sessions[0].id);
			const persona = await api(`/api/sessions/${sessions[0].id}`).catch(() => null);
			void persona;
		} else {
			const created = await api("/api/sessions", { method: "POST", body: "{}" });
			const data = await created.json();
			if (data.session) await openSession(data.session.id);
		}
		// fetch persona display name from first session scene header
		inputEl.focus();
	} catch (err) {
		console.error(err);
	}
})();
