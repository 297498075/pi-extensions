import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { gunzipSync } from "node:zlib";

// No personal config/sessions, network services, clipboard, GUI or audio devices.
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "extension-review-followups-"));
const original = { cwd: process.cwd(), fetch: globalThis.fetch,
	env: Object.fromEntries(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]])) };
process.env.HOME = process.env.USERPROFILE = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
for (const path of [process.env.HOME, process.env.PI_CODING_AGENT_DIR, join(root, ".pi")]) mkdirSync(path, { recursive: true });
process.chdir(root);
let compression;
const components = new Set();
try {
	// Optional: verify the same tests against a separately installed Pi host.
	const hostArg = process.argv.indexOf("--host-dir");
	const hostDir = hostArg < 0 || !process.argv[hostArg + 1] ? undefined : resolve(original.cwd, process.argv[hostArg + 1]);
	if (hostArg >= 0 && !hostDir) throw new Error("--host-dir requires a node_modules directory");
	const packageUrl = name => pathToFileURL(join(hostDir, name, "dist/index.js"));
	const host = await import(hostDir ? packageUrl("@earendil-works/pi-coding-agent") : "@earendil-works/pi-coding-agent");
	const tuiLib = await import(hostDir ? packageUrl("@earendil-works/pi-tui") : "@earendil-works/pi-tui");
	host.initTheme();
	let extension = name => import(pathToFileURL(join(checkout, "extensions", name)));
	if (hostDir) {
		const hostUrl = packageUrl("@earendil-works/pi-coding-agent");
		const { createJiti } = await import(new URL("./core/extensions/jiti-loader.js", hostUrl));
		const require = createRequire(hostUrl);
		const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
			"@earendil-works/pi-coding-agent": fileURLToPath(hostUrl),
			"@earendil-works/pi-tui": fileURLToPath(packageUrl("@earendil-works/pi-tui")),
			typebox: require.resolve("typebox"),
		} });
		extension = name => jiti.import(join(checkout, "extensions", name), { default: false });
	}
	compression = await extension("request-compress.ts");
	const media = await extension("media-gen.ts");
	const todo = await extension("todo-tree.ts");
	const theme = { fg: (_c, text) => `\x1b[36m${text}\x1b[39m`, bg: (_c, text) => text,
		style: text => `\x1b[1m${text}\x1b[22m`, bold: text => text };
	const plain = lines => lines.map(stripVTControlCharacters).join("\n");
	function overlay(store, rows = 30, onClose = () => {}, onNote, onPersist) {
		const tui = { terminal: { rows }, requestRender() {} };
		const component = new todo.TodoTreeOverlayComponent(tui, theme, store, onClose, onNote, onPersist);
		components.add(component); return { component, tui };
	}

	// Full URL prefixes, origin/port/path boundaries, longest-prefix selection and collisions.
	const providers = {
		a: { baseUrl: "https://shared.invalid/team-a/v1/", models: [{ id: "model-a" }] },
		b: { baseUrl: "https://shared.invalid/team-b/v1", models: [{ id: "model-b" }] },
		nested: { baseUrl: "https://shared.invalid/team-a/v1/special", models: [{ id: "nested" }] },
	};
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ defaultProvider: "a" }));
	const writeModels = value => writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: value }));
	const config = { ...compression.DEFAULT_CONFIG, algorithm: "gzip", minBytesThreshold: 1, providers: ["*"], excludeProviders: ["a"] };
	const body = model => JSON.stringify({ model, messages: [{ role: "user", content: "request body" }] });
	const check = (env, url, model = "model-a", overrides = {}) => compression.shouldCompressRequest(url, "POST", Buffer.from(body(model)), undefined, { ...config, ...overrides }, env);
	for (const definitions of [providers, Object.fromEntries(Object.entries(providers).reverse())]) {
		writeModels(definitions); const env = compression.resolvePiEnvironment();
		const a = check(env, "https://SHARED.invalid/team-a/v1/chat/completions?key=value");
		assert.equal(a.shouldCompress, false); assert.match(a.reason, /excludeProviders/);
		assert.equal(check(env, "https://shared.invalid/team-a/v1", "model-a", { excludeProviders: [] }).providerId, "a");
		const b = check(env, "https://shared.invalid/team-b/v1/responses", "model-b");
		assert.equal(b.shouldCompress, true); assert.equal(b.providerId, "b");
		const nested = check(env, "https://shared.invalid/team-a/v1/special/responses", "nested");
		assert.equal(nested.providerId, "nested"); assert.equal(nested.shouldCompress, true);
		assert.equal(check(env, "https://shared.invalid/team-b/v1/responses", "model-b", { providers: ["a"] }).shouldCompress, false);
		for (const url of ["https://shared.invalid/team-a/v10/responses", "https://shared.invalid/team-a/v1-other/responses",
			"https://shared.invalid/unrelated", "https://shared.invalid/TEAM-A/v1/responses", "http://shared.invalid/team-a/v1/responses",
			"https://shared.invalid:8443/team-a/v1/responses"]) assert.equal(check(env, url, "model-a", { excludeProviders: [] }).shouldCompress, false, url);
		assert.ok([...env.providerBaseUrls.keys()].every(url => url.startsWith("https://")));
	}
	writeModels(providers); const env = compression.resolvePiEnvironment();
	let captured;
	globalThis.fetch = async (url, init) => { captured = { url, init }; return new Response("ok"); };
	compression.updateLiveContext(config, env); compression.setupFetchHook();
	await fetch("https://shared.invalid/team-a/v1/chat/completions", { method: "POST", body: body("model-a") });
	assert.equal(new Headers(captured.init.headers).get("content-encoding"), null);
	assert.equal(captured.init.body, body("model-a"));
	await fetch("https://shared.invalid/team-b/v1/chat/completions", { method: "POST", body: body("model-b") });
	assert.equal(new Headers(captured.init.headers).get("content-encoding"), "gzip");
	assert.equal(gunzipSync(captured.init.body).toString(), body("model-b"));
	compression.teardownFetchHook();
	writeModels({ ...providers, alias: { baseUrl: "https://SHARED.invalid/team-a/v1", models: [{ id: "alias" }] } });
	const ambiguous = compression.resolvePiEnvironment();
	for (const overrides of [{}, { targetHosts: ["shared.invalid"] }]) {
		const result = check(ambiguous, "https://shared.invalid/team-a/v1/responses", "model-a", overrides);
		assert.equal(result.shouldCompress, false); assert.match(result.reason, /ambiguous/i);
	}
	assert.equal(check(ambiguous, "https://shared.invalid/team-a/v1/special/responses", "nested").providerId, "nested");
	console.log("✓ provider API-prefix ownership, exclusions, longest matches, origin/path boundaries and fail-closed ambiguity");

	// MIME and multipart file names come from validated bytes, not HTTP headers or file suffixes.
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
	const formats = [
		{ ext: "png", mime: "image/png", bytes: png },
		{ ext: "jpg", mime: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]) },
		{ ext: "gif", mime: "image/gif", bytes: Buffer.from("GIF89a\x01\x00\x01\x00", "binary") },
		{ ext: "webp", mime: "image/webp", bytes: Buffer.from("RIFF\x04\x00\x00\x00WEBP", "binary") },
	];
	const provider = { providerName: "fixture", baseUrl: "https://api.invalid/v1", apiKey: "fixture", availableModels: ["image", "video"] };
	for (const image of formats) for (const header of [undefined, "application/octet-stream", "image/jpeg", "image/png; charset=binary"]) for (const apiMode of ["images", "chat"]) {
		let edits = 0, chats = 0;
		globalThis.fetch = async (url, init) => {
			if (url === "https://assets.invalid/mislabeled.jpg") return new Response(image.bytes, { headers: header ? { "content-type": header } : {} });
			if (String(url).endsWith("/images/edits")) {
				edits++; const file = init.body.get("image");
				assert.equal(file.type, image.mime); assert.equal(file.name, `image.${image.ext}`);
				assert.deepEqual(Buffer.from(await file.arrayBuffer()), image.bytes);
				return Response.json({ data: [{ b64_json: png.toString("base64") }] });
			}
			assert.ok(String(url).endsWith("/chat/completions"), String(url)); chats++;
			const content = JSON.parse(init.body).messages[0].content;
			assert.equal(content.find(part => part.type === "image_url").image_url.url, `data:${image.mime};base64,${image.bytes.toString("base64")}`);
			return Response.json({ choices: [{ message: { images: [`data:image/png;base64,${png.toString("base64")}`] } }] });
		};
		const result = await media.executeImageGeneration({ prompt: "edit", image: "https://assets.invalid/mislabeled.jpg" }, { primaryModel: "image", apiMode }, provider, root);
		assert.deepEqual(readFileSync(result.filePath), png);
		assert.equal(edits, apiMode === "images" ? 1 : 0); assert.equal(chats, apiMode === "chat" ? 1 : 0);
	}
	const mislabeled = join(root, "actually-png.jpg"); writeFileSync(mislabeled, png);
	const mp4 = Buffer.alloc(24); mp4.writeUInt32BE(24, 0); mp4.write("ftyp", 4); mp4.write("isom", 8);
	globalThis.fetch = async (url, init) => {
		assert.ok(String(url).endsWith("/videos/generations"));
		assert.equal(JSON.parse(init.body).image_url, `data:image/png;base64,${png.toString("base64")}`);
		return Response.json({ data: [{ b64_json: mp4.toString("base64") }] });
	};
	const video = await media.executeVideoGeneration({ prompt: "animate", image: mislabeled }, { primaryModel: "video" }, provider, root);
	assert.deepEqual(readFileSync(video.filePath), mp4);
	let apiCalls = 0;
	globalThis.fetch = async url => { assert.equal(url, "https://assets.invalid/error.png"); apiCalls++; return new Response("<html>not an image</html>"); };
	await assert.rejects(media.executeImageGeneration({ prompt: "edit", image: "https://assets.invalid/error.png" }, { primaryModel: "image" }, provider, root), /unsupported image payload/);
	assert.equal(apiCalls, 1);
	console.log("✓ PNG/JPEG/GIF/WebP input signatures determine MIME/file names; generic, wrong and parameterized headers, local video references and invalid bytes");

	// Fullscreen bounds, compact detail navigation, deep IDs/indentation and complete titles.
	const store = new todo.TodoTreeStore();
	store.createTask({ subject: "任务👩‍💻e\u0301".repeat(35) + "SUBJECT_END", description: "DESC_END" });
	store.addUserNote("1", "NOTE_END"); store.createTask({ subject: "second" });
	const view = overlay(store);
	assert.deepEqual(view.component.render(0), []);
	for (const rows of [1, 2, 3, 4, 8, 15, 16, 24, 30, 48]) for (const width of [1, 2, 3, 4, 5, 10, 20, 30, 49, 50, 60, 80, 100, 140]) {
		view.tui.terminal.rows = rows;
		const lines = view.component.render(width);
		assert.ok(lines.length <= rows, `${width}x${rows}: height ${lines.length}`);
		for (const line of lines) assert.ok(tuiLib.visibleWidth(line) <= width, `${width}x${rows}: width ${tuiLib.visibleWidth(line)}`);
	}
	view.tui.terminal.rows = 8; view.component.render(30);
	let seen = "";
	const budget = view.component.totalDetailLines + 2;
	for (let step = 0; step < budget; step++) { seen += plain(view.component.render(30)); view.component.handleInput("pagedown"); }
	assert.match(seen, /DESC_END/); assert.match(seen, /NOTE_END/);
	view.component.handleInput("home"); view.component.render(30); view.component.handleInput("down"); view.component.render(30);
	assert.equal(view.component.selectedIndex, 1);
	view.component.handleInput("up"); view.component.render(30);
	view.component.handleMouse({ type: "wheel", wheelDelta: 1, x: 2, y: 3 });
	assert.equal(view.component.detailScrollTop, 1);
	const controlStore = new todo.TodoTreeStore();
	controlStore.createTask({ subject: "root", description: "中文".repeat(20) });
	controlStore.createTask({ parentId: "1", subject: "child" }); controlStore.addUserNote("1", "备注".repeat(10));
	let persisted = 0, prompted = 0;
	const controls = overlay(controlStore, 8, () => {}, () => { prompted++; }, () => { persisted++; }).component;
	controls.render(10);
	const allText = controls.detailCache.lines.map(line => line.text).join("");
	assert.ok(allText.includes("中文".repeat(20))); assert.ok(allText.includes("备注".repeat(10)), "tiny detail widths retain wide-grapheme content");
	controls.handleMouse({ type: "click", button: "left", x: 3, y: 3 });
	assert.equal(controlStore.getTask("1").status, "pending", "compact details have no invisible action hitboxes");
	controls.handleInput("c"); assert.equal(controlStore.getTask("1").status, "completed");
	controls.handleInput("x"); assert.equal(controlStore.getTask("1").status, "cancelled"); assert.equal(persisted, 2);
	controls.handleInput(" "); assert.equal(controlStore.isCollapsed("1"), true);
	controls.handleInput("n"); assert.equal(prompted, 1); assert.equal(controlStore.listeners.length, 0);
	const deep = new todo.TodoTreeStore(); let parent;
	for (let depth = 0; depth < 32; depth++) parent = deep.createTask({ id: depth === 0 ? "root-" + "x".repeat(100) : undefined,
		parentId: parent?.id, subject: `level ${depth} 深层任务` });
	const deepView = overlay(deep); deepView.component.handleInput("end");
	for (const width of [50, 60, 80, 100, 140]) {
		const lines = deepView.component.render(width);
		assert.ok(lines.every(line => tuiLib.visibleWidth(line) <= width));
		assert.ok(plain(lines).includes("深层任务"), "compressed ancestry/IDs must leave room for task subjects");
	}
	console.log("✓ Todo overlay fits 1–140 columns and 1–48 rows, navigates full compact details, and bounds 32-level rows without hiding subjects");

	// Layout is linear on the first render and reused until content/selection/width/theme changes.
	const cachedStore = new todo.TodoTreeStore(); cachedStore.createTask({ subject: "long details", description: "中".repeat(16000) });
	cachedStore.addUserNote("1", "备注".repeat(4000)); cachedStore.createTask({ subject: "other" });
	const cached = overlay(cachedStore).component;
	const started = performance.now(); cached.render(80); const firstMs = performance.now() - started;
	let cache = cached.detailCache; assert.ok(cache?.lines.length > 500);
	const repeated = performance.now();
	for (let i = 0; i < 20; i++) { cached.render(80); assert.equal(cached.detailCache, cache); }
	const cachedMs = performance.now() - repeated;
	assert.ok(firstMs < 5000 && cachedMs < 2000, `bounded detail layout: first=${firstMs}ms cached=${cachedMs}ms`);
	cached.handleInput("pagedown"); const offset = cached.detailScrollTop; cached.render(80);
	assert.equal(cached.detailScrollTop, offset); assert.equal(cached.detailCache, cache);
	for (const mutate of [() => cachedStore.updateTask("1", { description: "updated description" }),
		() => cachedStore.addUserNote("1", "new note"), () => cachedStore.updateTask("1", { status: "completed" })]) {
		mutate(); cached.render(80); assert.notEqual(cached.detailCache, cache); cache = cached.detailCache;
	}
	cached.invalidate(); cached.render(80); assert.notEqual(cached.detailCache, cache); cache = cached.detailCache;
	cached.render(100); assert.notEqual(cached.detailCache, cache); cache = cached.detailCache;
	cached.handleInput("down"); cached.render(100); assert.notEqual(cached.detailCache, cache);
	assert.ok(cached.detailCache.lines.some(line => line.text.includes("other")));
	cache = cached.detailCache;
	const restoredTasks = structuredClone(cachedStore.getAllTasks()); restoredTasks[1].subject = "restored item";
	cachedStore.loadSnapshot(restoredTasks); cached.render(100);
	assert.notEqual(cached.detailCache, cache); assert.ok(cached.detailCache.lines.some(line => line.text.includes("restored item")));
	console.log(`✓ linear/cached Todo details, scroll retention and mutation/selection/resize/theme invalidation (${firstMs.toFixed(1)}ms first; ${cachedMs.toFixed(1)}ms for 20 redraws)`);

	// Exercise actual Pi custom() completion/disposal and native overlay compositing/mouse routing.
	const lifeStore = new todo.TodoTreeStore(); lifeStore.createTask({ subject: "note target" });
	let requests = 0;
	const interactive = Object.create(host.InteractiveMode.prototype);
	interactive.editor = { getText: () => "" }; interactive.keybindings = {};
	interactive.ui = { terminal: { rows: 30 }, requestRender() { requests++; }, hideOverlay() {}, showOverlay() { return { hide() {} }; } };
	for (let i = 0; i < 20; i++) {
		let component;
		const promise = interactive.showExtensionCustom((tui, _theme, _keys, done) => {
			component = new todo.TodoTreeOverlayComponent(tui, theme, lifeStore, () => done("close"), () => done("note"));
			components.add(component); return component;
		}, { overlay: true });
		await Promise.resolve();
		if (i % 2) {
			component.render(100);
			component.handleMouse({ type: "click", button: "left", x: component.boxLeft + 20,
				y: component.boxTop + 4 + component.listHeight + component.detailHeight });
		} else component.handleInput("n");
		assert.equal(await promise, "note"); component.dispose();
		assert.equal(lifeStore.listeners.length, 0);
	}
	requests = 0; lifeStore.addUserNote("1", "after closed dialogs"); assert.equal(requests, 0);
	const disposable = overlay(lifeStore).component; disposable.dispose(); disposable.dispose(); assert.equal(lifeStore.listeners.length, 0);
	const shortStore = new todo.TodoTreeStore(); shortStore.createTask({ subject: "task", description: "DETAIL_SENTINEL" });
	const native = new tuiLib.TuiAltScreen({ columns: 80, rows: 8, write() {}, hideCursor() {} }, false, undefined, { copyOnSelect: false });
	native.requestRender = () => {};
	const nativeComponent = new todo.TodoTreeOverlayComponent(native, theme, shortStore, () => {}); components.add(nativeComponent);
	const options = { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 };
	native.overlayStack = [{ component: nativeComponent, options, focusOrder: 1 }];
	const composited = native.compositeOverlays([], 80, 8);
	assert.equal(composited.length, 8); assert.ok(composited.every(line => tuiLib.visibleWidth(line) <= 80));
	assert.match(plain(composited), /DETAIL_SENTINEL/);
	const normal = overlay(lifeStore, 30, () => {}, undefined, () => {});
	native.terminal.columns = 100; native.terminal.rows = 30;
	native.overlayStack = [{ component: normal.component, options, focusOrder: 2 }]; native.compositeOverlays([], 100, 30);
	const x = normal.component.boxLeft + 30, y = normal.component.boxTop + 4 + normal.component.listHeight + normal.component.detailHeight;
	for (const suffix of ["M", "m"]) native.handleViewportInput(`\x1b[<0;${x + 1};${y + 1}${suffix}`);
	assert.equal(lifeStore.getTask("1").status, "completed", "actual SGR primary click still toggles Done");
	console.log("✓ native custom() note handoff disposes every subscription; native fullscreen details remain visible and primary mouse actions work");
} finally {
	for (const component of components) component.dispose();
	compression?.teardownFetchHook(); globalThis.fetch = original.fetch;
	process.chdir(original.cwd);
	for (const [key, value] of Object.entries(original.env)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}
