import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import { createServer, request } from "node:http";
import { Check } from "typebox/value";
import listary, { ListarySearchSchema, searchListary, formatListaryResults } from "../extensions/listary.ts";

let tool;
listary({ registerTool(definition) { assert.equal(tool, undefined); tool = definition; } });
assert.equal(tool.name, "listary_search");
assert.match(tool.description, /not file contents/);
assert.match(tool.description, /untrusted data/);
assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["query", "limit", "offset", "search_in", "types", "extensions"].sort());
assert.equal(Check(ListarySearchSchema, { query: "发票", limit: 100, offset: 2, search_in: ["D:\\工作"], types: ["file", "folder"], extensions: ["pdf", ".docx"] }), true);
const invalidParams = [
	{}, { query: "" }, { query: 1 }, { query: "x", limit: 0 }, { query: "x", limit: 101 },
	{ query: "x", limit: 1.5 }, { query: "x", offset: -1 }, { query: "x", offset: 0.5 },
	{ query: "x", offset: Number.MAX_SAFE_INTEGER + 1 }, { query: "x", types: ["link"] },
	{ query: "x", search_in: "D:\\Work" }, { query: "x", extensions: [1] }, { query: "x", url: "http://example.com" },
];
for (const params of invalidParams) {
	assert.equal(Check(ListarySearchSchema, params), false, JSON.stringify(params));
	await assert.rejects(searchListary(params), /REQUEST_VALIDATION_FAILED/);
}
await assert.rejects(searchListary({ query: " \t\n" }), /REQUEST_VALIDATION_FAILED/);
for (const path of ["relative", "C:relative", "\\root-relative"]) {
	await assert.rejects(searchListary({ query: "x", search_in: [path] }), /absolute directory/);
}
await assert.rejects(searchListary({ query: "界".repeat(100_000) }), /REQUEST_TOO_LARGE/);
await assert.rejects(tool.execute("invalid", { query: "" }), /REQUEST_VALIDATION_FAILED/);
console.log("✓ registration, schema and execution validation; no configurable URL or extra tool parameters");

function success(overrides = {}) {
	return { ok: true, data: {
		query: "发票", total: 42, offset: 0, limit: 10, count: 1,
		results: [{ path: "D:\\工作\\发票.pdf", name: "发票.pdf", type: "file", size_bytes: 120034, modified_at: "2026-06-18T10:20:00+08:00", score: 9821 }],
		...overrides,
	}, error: null, message: null, ts: 1780000000000 };
}
let handler;
const received = [];
const sockets = new Set();
const server = createServer((req, res) => {
	const chunks = [];
	req.on("data", chunk => chunks.push(chunk));
	req.on("end", () => {
		received.push({ method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) });
		handler(req, res);
	});
});
server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const requests = [];
let transportCalls = 0;
// Only test code redirects to an ephemeral loopback fixture. Production target
// and protocol headers are asserted before delegation; no live Listary traffic.
const transport = {
	request(options, callback) {
		transportCalls++;
		assert.equal(options.hostname, "127.0.0.1");
		assert.equal(options.port, 38431);
		assert.equal(options.path, "/api/v1/search");
		assert.equal(options.method, "POST");
		assert.equal(options.agent, false);
		assert.deepEqual(Object.keys(options.headers).sort(), ["Content-Type", "Content-Length", "Connection"].sort());
		const req = request({ ...options, port }, callback);
		requests.push(req);
		return req;
	},
};
function respond(body, status = 200) {
	handler = (_req, res) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
}
try {
	respond(success());
	const controller = new AbortController();
	const data = await searchListary({ query: "发票" }, controller.signal, transport);
	assert.deepEqual(data, success().data);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	let wire = received.at(-1);
	assert.equal(wire.method, "POST");
	assert.equal(wire.url, "/api/v1/search");
	assert.equal(wire.headers.host, `127.0.0.1:${port}`);
	assert.equal(wire.rawHeaders.filter(value => value.toLowerCase() === "host").length, 1);
	assert.equal(wire.headers["content-type"], "application/json");
	assert.equal(wire.headers.connection, "close");
	assert.equal(wire.headers["transfer-encoding"], undefined);
	assert.equal(Number(wire.headers["content-length"]), wire.body.length);
	assert.ok(wire.body.length > wire.body.toString().length, "Content-Length is UTF-8 bytes, not characters");
	assert.deepEqual(JSON.parse(wire.body), { query: "发票", limit: 10, offset: 0 });
	const filtered = { query: "invoice", limit: 100, offset: 10, search_in: ["D:\\Work", "\\\\server\\share\\docs"], types: ["file"], extensions: ["pdf", ".docx"] };
	respond(success({ query: "invoice", offset: 10, limit: 100 }));
	await searchListary(filtered, undefined, transport);
	assert.deepEqual(JSON.parse(received.at(-1).body), filtered);
	respond(success({ results: [{ path: "D:\\Work", name: "Work", type: "folder", size_bytes: null, modified_at: null }] }));
	assert.equal((await searchListary({ query: "Work" }, undefined, transport)).results[0].type, "folder");
	respond(success({ total: 0, count: 0, results: [] }));
	assert.equal((await searchListary({ query: "absent" }, undefined, transport)).count, 0);
	console.log("✓ fixed loopback target; one Host, UTF-8 Content-Length, no chunking/keep-alive; filters, folders and empty results");

	for (const [code, status] of [
		["REQUEST_VALIDATION_FAILED", 400], ["RESOURCE_NOT_FOUND", 404], ["METHOD_NOT_ALLOWED", 405],
		["UNSUPPORTED_MEDIA_TYPE", 415], ["REQUEST_TOO_LARGE", 413], ["TOO_MANY_REQUESTS", 429],
		["SEARCH_UNAVAILABLE", 503], ["INTERNAL_ERROR", 500], ["FORBIDDEN", 403],
	]) {
		respond({ ok: false, data: null, error: code, message: "Fixture failure." }, status);
		const before = transportCalls;
		await assert.rejects(searchListary({ query: "x" }, undefined, transport), error => error.message.includes(code) && error.message.includes("Fixture failure."));
		assert.equal(transportCalls, before + 1, "Errors are not retried automatically");
	}
	respond({ ok: false, data: null, error: "SEARCH_UNAVAILABLE", message: "Not ready." });
	await assert.rejects(searchListary({ query: "x" }, undefined, transport), /SEARCH_UNAVAILABLE.*enabled/);
	respond(success(), 500);
	await assert.rejects(searchListary({ query: "x" }, undefined, transport), /HTTP_500/);
	respond({ ok: false, error: "BAD\x1bCODE", message: "\x9b" + "x".repeat(10_000) }, 400);
	await assert.rejects(searchListary({ query: "x" }, undefined, transport), error => error.message.length < 1200 && !/[\x1b\x9b]/.test(error.message));
	let redirected = false;
	handler = (_req, res) => { redirected = true; res.writeHead(302, { Location: "http://example.com", "Content-Type": "application/json" }); res.end(JSON.stringify(success())); };
	await assert.rejects(searchListary({ query: "x" }, undefined, transport), /HTTP_302/);
	assert.equal(redirected, true);
	for (const body of ["not json", "null", "[]", {}, { ok: "true" }, { ok: true, data: null },
		success({ total: -1 }), success({ offset: 0.5 }), success({ offset: Number.MAX_SAFE_INTEGER }), success({ limit: 101 }), success({ count: 2 }),
		success({ results: [{ path: "x", name: "x", type: "link" }] }),
		success({ results: [{ path: 42, name: "x", type: "file" }] }),
		success({ results: [{ path: "x", name: "x", type: "file", size_bytes: -1 }] }),
	]) {
		respond(body);
		await assert.rejects(searchListary({ query: "x" }, undefined, transport), /INVALID_RESPONSE/);
	}
	respond("x".repeat(2 * 1024 * 1024 + 1));
	await assert.rejects(searchListary({ query: "x" }, undefined, transport), /RESPONSE_TOO_LARGE/);
	handler = (_req, res) => { res.writeHead(200, { "Content-Length": 1000 }); res.write('{"ok":'); setImmediate(() => res.destroy()); };
	await assert.rejects(searchListary({ query: "x" }, undefined, transport), /CONNECTION_ERROR/);
	console.log("✓ API and HTTP errors, no retries/redirects, malformed/oversized/truncated responses");

	const beforeAbort = transportCalls;
	const preaborted = new AbortController(); preaborted.abort();
	await assert.rejects(searchListary({ query: "x" }, preaborted.signal, transport), /CANCELLED/);
	assert.equal(transportCalls, beforeAbort);
	await assert.rejects(tool.execute("aborted", { query: "x" }, preaborted.signal), /CANCELLED/);
	let entered;
	const active = new Promise(resolve => { entered = resolve; });
	handler = () => entered(); // Deliberately leave this request open.
	const abort = new AbortController();
	const pending = searchListary({ query: "x" }, abort.signal, transport);
	await active;
	abort.abort();
	await assert.rejects(pending, /CANCELLED/);
	assert.equal(getEventListeners(abort.signal, "abort").length, 0);
	assert.equal(requests.at(-1).destroyed, true);
	handler = () => {};
	const timeout = new AbortController();
	await assert.rejects(searchListary({ query: "x" }, timeout.signal, { ...transport, timeoutMs: 100 }), /TIMEOUT/);
	assert.equal(getEventListeners(timeout.signal, "abort").length, 0);
	assert.equal(requests.at(-1).destroyed, true);
	// A trickling response must not extend the overall deadline.
	let trickle;
	handler = (_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		trickle = setInterval(() => res.write(" "), 10);
		res.on("close", () => clearInterval(trickle));
	};
	try { await assert.rejects(searchListary({ query: "x" }, undefined, { ...transport, timeoutMs: 100 }), /TIMEOUT/); }
	finally { clearInterval(trickle); }
	respond(success());
	assert.equal((await searchListary({ query: "x" }, undefined, transport)).count, 1, "Requests still work after cancellation and timeout");
	console.log("✓ pre-abort, in-flight cancellation, wall-clock timeout including trickle, listener cleanup and subsequent recovery");
} finally {
	for (const socket of sockets) socket.destroy();
	await new Promise(resolve => server.close(resolve));
}
// The fixture's closed ephemeral port reliably refuses connections; no real API is contacted.
await assert.rejects(searchListary({ query: "x" }, undefined, transport), /CONNECTION_ERROR.*Listary is running.*enabled/);

const longQuery = formatListaryResults(success({ query: "界".repeat(100_000) }).data);
assert.ok(Buffer.byteLength(longQuery.content[0].text) <= 32 * 1024);
assert.equal(longQuery.details.query.length, 100_000);
const formatted = formatListaryResults(success().data);
assert.match(formatted.content[0].text, /42 total/);
assert.match(formatted.content[0].text, /120034 bytes/);
assert.match(formatted.content[0].text, /offset=1/);
assert.equal(formatted.details.next_offset, 1);
assert.equal(formatted.details.displayed_count, 1);
assert.deepEqual(formatted.details.results, success().data.results);
const empty = formatListaryResults(success({ total: 0, count: 0, results: [] }).data);
assert.match(empty.content[0].text, /No matching files or folders/);
assert.equal(empty.details.next_offset, null);
const beyond = formatListaryResults(success({ offset: 100, count: 0, results: [] }).data);
assert.match(beyond.content[0].text, /smaller offset/);
assert.equal(beyond.details.next_offset, null);
const last = formatListaryResults(success({ offset: 41 }).data);
assert.equal(last.details.next_offset, null);
const terminal = formatListaryResults(success({ results: [{ path: "D:\\evil\n\x1b[31m.pdf", name: "evil", type: "file" }] }).data);
assert.ok(!terminal.content[0].text.includes("\x1b"));
assert.ok(terminal.content[0].text.includes("\\n\\u001b"));
const c1 = formatListaryResults(success({ query: "\x9bquery", results: [{ path: "D:\\evil\x9b\u2028file", name: "evil", type: "file" }] }).data);
assert.ok(!/[\x9b\u2028]/.test(c1.content[0].text));
assert.match(c1.content[0].text, /\\u009b/);
const many = success({ total: 500, offset: 5, limit: 100, count: 100, results: Array.from({ length: 100 }, (_, i) => ({ path: `D:\\${i}-${"界".repeat(500)}.pdf`, name: "file.pdf", type: "file" })) }).data;
const truncated = formatListaryResults(many);
assert.ok(Buffer.byteLength(truncated.content[0].text) <= 32 * 1024);
assert.ok(truncated.details.displayed_count > 0 && truncated.details.displayed_count < 100);
assert.equal(truncated.details.next_offset, 5 + truncated.details.displayed_count, "Pagination resumes after displayed results, not the full server page");
assert.equal(truncated.details.results.length, 100, "Structured results are retained");
assert.throws(() => formatListaryResults(success({ results: [{ path: "x".repeat(40_000), name: "x", type: "file" }] }).data), /RESULT_TOO_LARGE/);
console.log("✓ structured metadata, pagination including empty/last/limited pages, inert filenames and bounded UTF-8 output");
console.log("All isolated Listary regressions passed.");
