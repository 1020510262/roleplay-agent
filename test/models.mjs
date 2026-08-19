import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import { ModelConnectionError, testModelConnection, validateModelProfileInput } from "../dist/agent/model-settings.js";

const requests = [];
const server = http.createServer((req, res) => {
	let body = "";
	req.setEncoding("utf8");
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
		if (req.headers.authorization !== "Bearer test-secret") {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "bad key" } }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
	});
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();

const base = {
	name: "Local test model",
	baseUrl: `http://127.0.0.1:${port}/v1/`,
	apiKey: "test-secret",
	modelId: "test-model",
	api: "openai-completions",
	contextWindow: 32768,
	maxTokens: 2048,
};

const validated = validateModelProfileInput(base);
assert.equal(validated.baseUrl, `http://127.0.0.1:${port}/v1`);
await testModelConnection(base, 2_000);
assert.equal(requests.length, 1);
assert.equal(requests[0].url, "/v1/chat/completions");
assert.equal(requests[0].authorization, "Bearer test-secret");
assert.equal(requests[0].body.model, "test-model");

await assert.rejects(
	() => testModelConnection({ ...base, apiKey: "wrong" }, 2_000),
	(err) => err instanceof ModelConnectionError && err.status === 401 && /bad key/.test(err.message),
);
assert.throws(() => validateModelProfileInput({ ...base, baseUrl: "http://example.com/v1" }), /HTTPS/);
assert.throws(() => validateModelProfileInput({ ...base, api: "unknown" }), /仅支持/);
assert.throws(() => validateModelProfileInput({ ...base, maxTokens: 40000 }), /最大输出长度/);

server.close();
await once(server, "close");
console.log("model settings: 8 passed, 0 failed");
