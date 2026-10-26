import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, VoiceRuntime, TtsGatewayAdapter, getVoiceArgumentCompletions, VoiceListVoicesParamsSchema } from "../extensions/voice.ts";
import { parseVoices, resolveVoice, voicePage, VoiceDirectory } from "../extensions/lib/voice-catalog.ts";
import { VoicePickerComponent } from "../extensions/lib/voice-picker.ts";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const native = { id: "C11-V32", name: "Iggy", engine: "voice-library", ready: true, capabilities: { speed: false, independent_emotion: false } };
const wire = v => ({ ...v, voice_id: v.id });
const signal = () => new AbortController().signal;
function harness(catalog = [native]) {
 let value = structuredClone(DEFAULT_CONFIG), calls = 0, reads = 0, writes = 0;
 value.voicesCacheByGateway[value.gatewayUrl] = [];
 const notices = [], speeches = [];
 const store = { get() { reads++; return structuredClone(value); }, async update(fn, s) { if (s?.aborted) throw Error("cancelled"); value = fn(structuredClone(value)); writes++; return value; } };
 const gateway = { async getVoices() { calls++; return structuredClone(catalog); }, async speak(text, options) { speeches.push({ text, ...options }); }, async recordAndTranscribe() { throw Error("unexpected recording"); } };
 const ctx = { hasUI: true, mode: "tui", isIdle: () => true, ui: { notify: (...a) => notices.push(a), setStatus() {} } };
 const runtime = new VoiceRuntime({ getActiveTools: () => [], setActiveTools() {} }, { config: store, gateway: () => gateway }); runtime.start(ctx);
 return { runtime, ctx, notices, speeches, store, gateway, setCatalog: v => { catalog = v; }, change: v => { value = { ...value, ...v }; }, get calls() { return calls; }, get reads() { return reads; }, get writes() { return writes; }, close: () => runtime.stop(true) };
}
await test("catalog retains routing metadata and legacy wire compatibility, rejects duplicate/broken IDs", () => {
 assert.equal(parseVoices([wire(native)], true)[0].engine, "voice-library");
 assert.equal(parseVoices([{ voice_id: "legacy", name: "Legacy" }], true)[0].engine, "cosyvoice");
 assert.equal(parseVoices([{ id: "old", name: "Old cache" }])[0].engine, undefined);
 for (const bad of [[wire(native), wire(native)], [{ voice_id: "bad\n", name: "x" }], {}]) assert.throws(() => parseVoices(bad, true));
 assert.throws(() => resolveVoice([{ ...native, ready: false }], native.id), /未就绪/);
 assert.throws(() => resolveVoice([{ ...native, engine: "future-engine" }], native.id), /不支持/);
 assert.throws(() => resolveVoice([native], "missing"), /不存在/);
});
await test("untrusted catalog labels cannot inject terminal control sequences", () => {
 const [v] = parseVoices([{ voice_id: "safe", name: "\u001b[31mName\u001b[0m\nnext", engine: "\u001b[31munsafe", description: "line\r\nvalue" }], true);
 assert.equal(v.name, "Name next"); assert(!/[\u0000-\u001f]/.test(v.description)); assert.equal(v.engine, "unknown"); assert.throws(() => resolveVoice([v], "safe"), /不支持/);
});
await test("large catalog pages are bounded, searchable and schema stays small", () => {
 const rows = Array.from({ length: 10000 }, (_, i) => ({ id: `C${i}`, name: `Voice ${i}`, engine: i % 2 ? "voice-library" : "cosyvoice" }));
 assert.equal(voicePage(rows, {}).voices.length, 20);
 const page = voicePage(rows, { query: "voice-library Voice", offset: 20, limit: 50 });
 assert.equal(page.total, 10000); assert.equal(page.matched, 5000); assert.equal(page.voices.length, 50); assert(page.has_more);
 assert.equal(voicePage(rows, { offset: 10000 }).voices.length, 0);
 for (const p of [{ limit: 51 }, { offset: -1 }, { limit: 1.5 }, { query: "x".repeat(257) }]) assert.throws(() => voicePage(rows, p));
 assert(JSON.stringify(VoiceListVoicesParamsSchema).length < 2000); assert(!JSON.stringify(VoiceListVoicesParamsSchema).includes("C11-V32"));
});
await test("single-flight refreshes coalesce; one cancelled subscriber leaves other readers alive", async () => {
 const d = deferred(); let calls = 0, producerSignal;
 const dir = new VoiceDirectory(s => { calls++; producerSignal = s; return d.promise; });
 const c = new AbortController(); const a = dir.get(true, c.signal), b = dir.get(true), z = dir.get(false);
 c.abort(); await assert.rejects(a, /取消/); assert.equal(calls, 1); assert(!producerSignal.aborted);
 d.resolve({ voices: [native] }); const [bb, zz] = await Promise.all([b, z]); assert.equal(bb, zz);
 assert.equal(await dir.get(), bb); assert.equal(calls, 1); dir.clear();
});
await test("clear invalidates an uncooperative producer; deadline settles and a later request can succeed", async () => {
 const late = deferred(); const dir = new VoiceDirectory(() => late.promise, 5, 15);
 const p = dir.get(); await assert.rejects(p, /取消/); assert.equal(dir.peek(), undefined);
 late.resolve({ voices: [native] }); await Promise.resolve(); assert.equal(dir.peek(), undefined);
 const next = dir.get(); dir.clear(); await assert.rejects(next, /取消/); assert.equal(dir.peek(), undefined);
});
await test("TTL expiry and explicit refresh fetch again; identical catalogs do not churn the config file", async () => {
 let calls = 0; const dir = new VoiceDirectory(async () => { calls++; return { voices: [native] }; }, 0);
 await dir.get(); await dir.get(); assert.equal(calls, 2); dir.clear();
 const h = harness(); try { await h.runtime.listVoices({ refresh: true }, undefined, true); const writes = h.writes; await h.runtime.listVoices({ refresh: true }, undefined, true); assert.equal(h.calls, 2); assert.equal(h.writes, writes); } finally { h.close(); }
 const broken = new VoiceDirectory(() => { throw Error("sync loader failure"); }); await assert.rejects(broken.get(), /sync loader failure/); broken.clear();
});
await test("real adapter resolves voice-library engine, preserves default whole-utterance recipe and reuses catalog", async () => {
 const original = globalThis.fetch; const calls = [];
 globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return url.endsWith("/api/voices") ? Response.json([wire(native)]) : Response.json({ status: "completed" }); };
 try {
  const adapter = new TtsGatewayAdapter("http://mock");
  await adapter.speak("你好。", { voiceId: native.id, speed: 1, signal: signal() });
  await adapter.speak("下一句。", { voiceId: native.id.toLowerCase(), speed: 1, signal: signal() });
  assert.equal(calls.filter(c => c.url.endsWith("/api/voices")).length, 1);
  const bodies = calls.filter(c => c.opts.body).map(c => JSON.parse(c.opts.body));
  assert.equal(bodies.length, 2); for (const b of bodies) { assert.equal(b.engine, "voice-library"); assert.equal(b.voice_id, native.id); assert.equal(b.output_mode, "speaker_playback"); assert(!("speed" in b)); assert(!("instruct" in b)); assert(!b.streaming); }
 } finally { globalThis.fetch = original; }
});
await test("native controls, unready/unknown voices fail before synthesis; no silent CosyVoice fallback", async () => {
 const original = globalThis.fetch; let posts = 0;
 globalThis.fetch = async (url, opts) => { if (opts.method === "POST") posts++; return Response.json([wire(native), wire({ ...native, id: "held", ready: false }), wire({ ...native, id: "future", engine: "other" })]); };
 try {
  const a = new TtsGatewayAdapter("http://mock");
  for (const p of [{ voiceId: "missing" }, { voiceId: "held" }, { voiceId: "future" }, { speed: 1.2 }, { instruct: "cheerful" }, { text: "字".repeat(81) }]) {
   const { text = "你好", ...options } = p; await assert.rejects(a.speak(text, { voiceId: native.id, speed: 1, signal: signal(), ...options }));
  }
  assert.equal(posts, 0);
 } finally { globalThis.fetch = original; }
});
await test("cancelling catalog lookup does not send a global speaker stop", async () => {
 const original = globalThis.fetch, d = deferred(), calls = [];
 globalThis.fetch = async (url, options) => { calls.push(url); return d.promise; };
 try {
  const c = new AbortController(), a = new TtsGatewayAdapter("http://mock");
  const p = a.speak("你好", { voiceId: native.id, speed: 1, signal: c.signal }); c.abort(); await assert.rejects(p);
  d.resolve(Response.json([wire(native)])); assert(calls.every(u => u.endsWith("/api/voices")));
 } finally { globalThis.fetch = original; }
});
await test("independent command selects live stable ID while disabled, without speaking or altering startup preferences", async () => {
 const h = harness();
 try {
  await h.runtime.command(`voice ${native.id}`, h.ctx);
  assert.equal(h.store.get().defaultVoiceId, native.id); assert.equal(h.calls, 1);
  assert.equal(h.runtime.enabled, false); assert.equal(h.store.get().defaultEnabled, false); assert.equal(h.runtime.live, false); assert.equal(h.speeches.length, 0);
  await h.runtime.command("set-voice Iggy", h.ctx); assert.equal(h.calls, 2); assert.equal(h.store.get().defaultVoiceId, native.id);
 } finally { h.close(); }
});
await test("unknown/ambiguous names and offline cache cannot silently change the default", async () => {
 const h = harness([native, { ...native, id: "other" }]);
 try {
  for (const arg of ["Iggy", "missing"]) await h.runtime.command(`voice ${arg}`, h.ctx);
  assert.equal(h.store.get().defaultVoiceId, DEFAULT_CONFIG.defaultVoiceId); assert(h.notices.some(n => n[0].includes("唯一")));
  h.gateway.getVoices = async () => { throw Error("offline"); };
  await h.runtime.command(`voice ${native.id}`, h.ctx); assert.equal(h.store.get().defaultVoiceId, DEFAULT_CONFIG.defaultVoiceId);
  const result = await h.runtime.listVoices({ refresh: true }, undefined, true); assert.equal(result.source, "cache"); assert.equal(result.stale, true); assert.match(result.warning, /历史缓存/);
 } finally { h.close(); }
});
await test("picker cancellation saves no default, confirmation revalidates removal and stop", async () => {
 for (const mode of ["cancel", "removed", "stopped", "saved"]) {
  const h = harness();
  h.ctx.ui.custom = async factory => { const component = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c, s) => s }, {}, () => {}); assert(component.render(70).some(s => s.includes("默认音色"))); if (mode === "removed") h.setCatalog([]); if (mode === "stopped") h.runtime.stop(true); return mode === "cancel" ? undefined : native.id; };
  try {
   await h.runtime.command("voice", h.ctx);
   assert.equal(h.store.get().defaultVoiceId, mode === "saved" ? native.id : DEFAULT_CONFIG.defaultVoiceId);
   assert.equal(h.speeches.length, 0); assert.equal(h.runtime.enabled, false);
   assert.equal(h.calls, mode === "cancel" || mode === "stopped" ? 1 : 2);
  } finally { h.close(); }
 }
});
await test("100 autocomplete updates over 10000 voices use one fetch, bounded results and no per-key disk reads", async () => {
 const h = harness(Array.from({ length: 10000 }, (_, i) => ({ ...native, id: `C${i}`, name: `Voice ${i}` })));
 try {
  const start = performance.now();
  const results = await Promise.all(Array.from({ length: 100 }, () => getVoiceArgumentCompletions("voice C1", h.runtime)));
  assert.equal(h.calls, 1); assert(results.every(r => r.length <= 20 && r.every(v => v.value.startsWith("voice C1"))));
  const reads = h.reads, writes = h.writes;
  for (let i = 0; i < 100; i++) await getVoiceArgumentCompletions("voice C2", h.runtime);
  assert.equal(h.calls, 1); assert.equal(h.reads, reads); assert.equal(h.writes, writes);
  console.log(`voice catalog benchmark: 10000 entries / 200 completions / ${h.calls} GET / ${(performance.now() - start).toFixed(1)} ms`);
  assert.equal(await getVoiceArgumentCompletions("voice no-match-12345", h.runtime), null);
 } finally { h.close(); }
});
await test("tool voice override is per-call and listing is paged, not the whole catalog", async () => {
 const h = harness(Array.from({ length: 180 }, (_, i) => ({ ...native, id: `V${i}` })));
 try {
  h.runtime.enable(); const page = await h.runtime.listVoices({ offset: 20, limit: 10 });
  assert.equal(page.total, 180); assert.equal(page.voices.length, 10); assert.equal(page.has_more, true); assert.equal(page.stale, false);
  assert.equal((await h.runtime.speak({ text: "你好", voice_id: "V20" })).status, "success");
  assert.equal(h.speeches[0].voiceId, "V20"); assert.equal(h.store.get().defaultVoiceId, DEFAULT_CONFIG.defaultVoiceId);
 } finally { h.close(); }
});
await test("saving a new default preserves the active utterance snapshot and only affects the next request", async () => {
 const h = harness(), d = deferred(); let captured;
 h.gateway.speak = async (_text, options) => { captured = options; return d.promise; };
 try {
  h.runtime.enable(); const p = h.runtime.speak({ text: "正在说" });
  const old = captured; await h.runtime.command(`voice ${native.id}`, h.ctx); assert(!old.signal.aborted); assert.equal(old.voiceId, DEFAULT_CONFIG.defaultVoiceId);
  d.resolve(); assert.equal((await p).status, "success");
  await h.runtime.speak({ text: "下一句" }); assert.equal(captured.voiceId, native.id);
 } finally { h.close(); }
});
await test("picker renders a bounded searchable native list at narrow widths and forwards focus for IME", () => {
 let picked = "pending", renders = 0;
 const picker = new VoicePickerComponent([native, { ...native, id: "second", name: "另一声线" }], "Iggy", { fg: (_c, s) => s }, () => renders++, id => { picked = id; });
 picker.focused = true; assert.equal(picker.focused, true); assert.equal(picker.input.focused, true);
 for (const width of [1, 12, 40, 80]) { const lines = picker.render(width); assert(lines.length <= 17); assert(lines.every(s => visibleWidth(s) <= width)); }
 picker.handleInput("\r"); assert.equal(picked, native.id);
 picker.handleInput("\x1b"); assert.equal(picked, undefined); assert(renders > 0);
 const empty = new VoicePickerComponent([native], "不存在", { fg: (_c, s) => s }, () => {}, () => assert.fail("empty list must not select")); empty.handleInput("\r");
});
