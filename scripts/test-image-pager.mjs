import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import imagePager, {
	DEFAULT_CONFIG,
	buildSmartPointerNotice,
	estimateVisualTokens,
	formatBytes,
	getPagerArgumentCompletions,
	loadConfig,
	matchesAnyPattern,
	matchesPattern,
	mergeConfig,
	normalizeDisplayPath,
	pageOutContextImages,
	shouldEnableForModel,
	stats,
} from "../extensions/image-pager.ts";

console.log("=== Test 1: Configuration & Model Matching ===");
assert.equal(DEFAULT_CONFIG.enabled, true);
assert.equal(DEFAULT_CONFIG.keepRecentImages, 1);
assert.deepEqual(DEFAULT_CONFIG.models, ["*"]);
assert.deepEqual(DEFAULT_CONFIG.excludeModels, []);
assert.equal(DEFAULT_CONFIG.minBytesThreshold, 0);
assert.equal(DEFAULT_CONFIG.noticeLanguage, "en");

// 1.1 mergeConfig
const merged = mergeConfig(DEFAULT_CONFIG, {
	keepRecentImages: 2,
	noticeLanguage: "zh",
	models: ["gemini-*"],
	excludeModels: ["gpt-3.5*"],
});
assert.equal(merged.keepRecentImages, 2);
assert.equal(merged.noticeLanguage, "zh");
assert.deepEqual(merged.models, ["gemini-*"]);
assert.deepEqual(merged.excludeModels, ["gpt-3.5*"]);

// 1.2 matchesPattern & shouldEnableForModel
assert.equal(matchesPattern("gemini-2.5-pro", "*"), true);
assert.equal(matchesPattern("gemini-2.5-pro", "gemini-*"), true);
assert.equal(matchesPattern("claude-3-opus", "gemini-*"), false);
assert.equal(shouldEnableForModel("gemini-2.5-pro", merged), true);
assert.equal(shouldEnableForModel("gpt-3.5-turbo", merged), false); // excluded
assert.equal(shouldEnableForModel("claude-3.7-sonnet", merged), false); // not in models
console.log("  ✓ Config and pattern matching passed.");

console.log("\n=== Test 2: Path Normalization & Utilities ===");
assert.equal(formatBytes(0), "0 B");
assert.equal(formatBytes(1024), "1 KB");
assert.equal(formatBytes(1048576), "1 MB");
assert.ok(estimateVisualTokens(10000) > 1200);

const posixPath = normalizeDisplayPath("d:\\novel\\shot_01.jpg");
assert.equal(posixPath.includes("\\"), false, "Backslashes must be normalized to forward slashes");
assert.ok(posixPath.endsWith("d:/novel/shot_01.jpg") || posixPath === "d:/novel/shot_01.jpg");
console.log("  ✓ Path normalization and utility functions passed.");

console.log("\n=== Test 3: Smart Pointer Notice Generation ===");
const enNotice = buildSmartPointerNotice({
	fileName: "shot_01_14.jpg",
	filePath: "d:/novel/shot_01_14.jpg",
	mimeType: "image/jpeg",
	bytes: 1048576,
	config: DEFAULT_CONFIG,
});
assert.ok(enNotice.includes("shot_01_14.jpg"));
assert.ok(enNotice.includes("d:/novel/shot_01_14.jpg"));
assert.ok(enNotice.includes("paged out"));
assert.ok(enNotice.includes("invoke the 'read' tool on this path"));

const zhNotice = buildSmartPointerNotice({
	fileName: "shot_01_14.jpg",
	filePath: "d:/novel/shot_01_14.jpg",
	mimeType: "image/jpeg",
	bytes: 1048576,
	config: { ...DEFAULT_CONFIG, noticeLanguage: "zh" },
});
assert.ok(zhNotice.includes("已从工作上下文换出"));
assert.ok(zhNotice.includes("d:/novel/shot_01_14.jpg"));
assert.ok(zhNotice.includes("调用 'read' 工具将其重新换入"));

// User attachment without path
const userAttachmentNotice = buildSmartPointerNotice({
	fileName: "user_attachment_1",
	filePath: undefined,
	mimeType: "image/png",
	bytes: 500000,
	config: DEFAULT_CONFIG,
});
assert.ok(userAttachmentNotice.includes("User-attached image"));
assert.ok(userAttachmentNotice.includes("ask the user to re-attach"));
console.log("  ✓ Self-healing smart pointer prompts generated correctly.");

console.log("\n=== Test 4: Core Paging Logic (pageOutContextImages) ===");
// Construct a simulated multi-turn conversation with 3 images
const dummyBase64 = "A".repeat(10000);

const messages = [
	{
		role: "user",
		content: "Analyze shot 1",
		timestamp: 1000,
	},
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_read_1",
				name: "read",
				arguments: { path: "d:/novel/shot_01.jpg" },
			},
		],
		timestamp: 1010,
	},
	{
		role: "toolResult",
		toolCallId: "call_read_1",
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/jpeg]" },
			{ type: "image", data: dummyBase64, mimeType: "image/jpeg" },
		],
		isError: false,
		timestamp: 1020,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "Shot 1 has character wearing blue robe." }],
		timestamp: 1030,
	},
	{
		role: "user",
		content: "Now analyze shot 2",
		timestamp: 1100,
	},
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_read_2",
				name: "read",
				arguments: { path: "d:/novel/shot_02.jpg" },
			},
		],
		timestamp: 1110,
	},
	{
		role: "toolResult",
		toolCallId: "call_read_2",
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/jpeg]" },
			{ type: "image", data: dummyBase64, mimeType: "image/jpeg" },
		],
		isError: false,
		timestamp: 1120,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "Shot 2 is a close-up." }],
		timestamp: 1130,
	},
	{
		role: "user",
		content: "Finally check shot 3",
		timestamp: 1200,
	},
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_read_3",
				name: "read",
				arguments: { path: "d:/novel/shot_03.jpg" },
			},
		],
		timestamp: 1210,
	},
	{
		role: "toolResult",
		toolCallId: "call_read_3",
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/jpeg]" },
			{ type: "image", data: dummyBase64, mimeType: "image/jpeg" },
		],
		isError: false,
		timestamp: 1220,
	},
];

// 4.1 Test turn-boundary strategy (Default Cache-Friendly behavior)
// Total 3 images: shot 1 & 2 are in past turns (before last user message); shot 3 is in active turn!
const result1 = pageOutContextImages(messages, DEFAULT_CONFIG);
assert.equal(result1.totalImages, 3, "Total images seen should be 3");
assert.equal(result1.pagedOutCount, 2, "2 images in past turns should be paged out");
assert.equal(result1.retainedCount, 1, "1 active turn image should be retained");
assert.equal(result1.savedBytes, 20000, "20,000 bytes saved");
assert.ok(result1.estimatedTokens > 2000, "Tokens should be saved");

// Check the modified messages
const modMsgShot1 = result1.messages[2]; // toolResult 1
assert.equal(modMsgShot1.role, "toolResult");
assert.equal(modMsgShot1.content[1].type, "text", "Cold image must be replaced by text smart pointer");
assert.ok(modMsgShot1.content[1].text.includes("shot_01.jpg"));
assert.ok(modMsgShot1.content[1].text.includes("invoke the 'read' tool on this path"));

const modMsgShot2 = result1.messages[6]; // toolResult 2
assert.equal(modMsgShot2.content[1].type, "text", "Cold image must be replaced by text smart pointer");
assert.ok(modMsgShot2.content[1].text.includes("shot_02.jpg"));

const modMsgShot3 = result1.messages[10]; // toolResult 3 (Active Turn Hot Page!)
assert.equal(modMsgShot3.content[1].type, "image", "Active turn image must remain raw image");
assert.equal(modMsgShot3.content[1].data, dummyBase64, "Raw image data preserved untouched");
console.log("  ✓ turn-boundary properly pages out past turn images and retains active turn image.");

// 4.2 Test Prefix Immutability across 50 text turns and subsequent image entry
// Simulating: Turn 1 (Image 1) -> Turn 2 (Text) -> ... -> Turn 50 (Text) -> Turn 51 (Image 2)
const prefixMessagesTurn1 = [
	{ role: "user", content: "Check shot 1", timestamp: 1 },
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "d:/shot1.jpg" } }],
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read",
		content: [{ type: "image", data: dummyBase64, mimeType: "image/jpeg" }],
		isError: false,
		timestamp: 3,
	},
];
// In Turn 1 active context: shot 1 is in active turn, so it stays raw
const resTurn1 = pageOutContextImages(prefixMessagesTurn1, DEFAULT_CONFIG);
assert.equal(resTurn1.messages[2].content[0].type, "image", "In turn 1, image 1 is raw");

// In Turn 2: User asks text question. Image 1 is now in past turn -> becomes Smart Pointer
const prefixMessagesTurn2 = [
	...prefixMessagesTurn1,
	{ role: "assistant", content: [{ type: "text", text: "Shot 1 details..." }], timestamp: 4 },
	{ role: "user", content: "What clothes is hero wearing?", timestamp: 5 },
];
const resTurn2 = pageOutContextImages(prefixMessagesTurn2, DEFAULT_CONFIG);
assert.equal(resTurn2.messages[2].content[0].type, "text", "In turn 2, image 1 is paged out to pointer");
const frozenPointerText = resTurn2.messages[2].content[0].text;

// Now advance 50 turns with text conversation:
let longConversation = [...prefixMessagesTurn2];
for (let turn = 3; turn <= 50; turn++) {
	longConversation.push(
		{ role: "assistant", content: [{ type: "text", text: `Answer for turn ${turn}` }], timestamp: turn * 10 },
		{ role: "user", content: `Question for turn ${turn}`, timestamp: turn * 10 + 1 },
	);
}
const resTurn50 = pageOutContextImages(longConversation, DEFAULT_CONFIG);
// VERIFY: The smart pointer at Turn 1 message index 2 MUST BE 100% IDENTICAL to Turn 2!
assert.equal(
	resTurn50.messages[2].content[0].text,
	frozenPointerText,
	"Prefix at Turn 1 must remain 100% byte-identical across 50 text turns!",
);

// Turn 51: Suddenly read Image 2!
longConversation.push(
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "d:/shot2.jpg" } }],
		timestamp: 600,
	},
	{
		role: "toolResult",
		toolCallId: "c2",
		toolName: "read",
		content: [{ type: "image", data: dummyBase64, mimeType: "image/jpeg" }],
		isError: false,
		timestamp: 601,
	},
);
const resTurn51 = pageOutContextImages(longConversation, DEFAULT_CONFIG);
// VERIFY: Turn 1 smart pointer text is STILL 100% identical! NO CACHE INVALIDATION FOR PREVIOUS 50 TURNS!
assert.equal(
	resTurn51.messages[2].content[0].text,
	frozenPointerText,
	"CRITICAL: Turn 1 prefix MUST NOT change when Image 2 is added at turn 51! Cache stays 100% hit!",
);
// And Image 2 at Turn 51 is preserved as raw image!
assert.equal(resTurn51.messages[resTurn51.messages.length - 1].content[0].type, "image");
console.log("  ✓ Prefix immutability across 50 turns verified! KV-Cache 100% protected.");

// 4.3 Test FIFO Strategy (Sliding window by count)
const resultFifoKeep2 = pageOutContextImages(messages, {
	...DEFAULT_CONFIG,
	strategy: "fifo",
	keepRecentImages: 2,
});
assert.equal(resultFifoKeep2.pagedOutCount, 1, "FIFO keepRecentImages: 2 should page out 1 image");
assert.equal(resultFifoKeep2.retainedCount, 2, "FIFO should retain 2 images");
assert.equal(resultFifoKeep2.messages[2].content[1].type, "text");
assert.equal(resultFifoKeep2.messages[6].content[1].type, "image");
assert.equal(resultFifoKeep2.messages[10].content[1].type, "image");
console.log("  ✓ FIFO strategy properly adheres to count-based sliding window.");

// 4.4 Test keepRecentImages: 0 (Page out all history images)
const resultKeep0 = pageOutContextImages(messages, { ...DEFAULT_CONFIG, keepRecentImages: 0 });
assert.equal(resultKeep0.pagedOutCount, 3, "All 3 images should be paged out");
assert.equal(resultKeep0.retainedCount, 0);
assert.equal(resultKeep0.messages[2].content[1].type, "text");
assert.equal(resultKeep0.messages[6].content[1].type, "text");
assert.equal(resultKeep0.messages[10].content[1].type, "text");
console.log("  ✓ keepRecentImages: 0 pages out all images into smart pointers.");

// 4.5 Test minBytesThreshold
const resultThreshold = pageOutContextImages(messages, {
	...DEFAULT_CONFIG,
	keepRecentImages: 1,
	minBytesThreshold: 50000, // higher than dummyBase64 (10000)
});
assert.equal(resultThreshold.pagedOutCount, 0, "No image exceeds threshold, nothing paged out");
console.log("  ✓ minBytesThreshold properly bypasses smaller images.");

console.log("\n=== Test 5: Argument Autocompletions ===");
const compAll = getPagerArgumentCompletions("");
assert.ok(compAll && compAll.length >= 8, "Should return main subcommands");
assert.ok(compAll.some((c) => c.value === "status"));
assert.ok(compAll.some((c) => c.value === "strategy turn-boundary"));

const compStat = getPagerArgumentCompletions("stat");
assert.equal(compStat.length, 1);
assert.equal(compStat[0].value, "status");

const compStrategy = getPagerArgumentCompletions("strategy ");
assert.ok(compStrategy.length >= 2, "Should autocomplete strategy options");
assert.ok(compStrategy.some((c) => c.label === "turn-boundary"));

const compKeep = getPagerArgumentCompletions("keep ");
assert.ok(compKeep.length >= 3, "Should autocomplete keep numbers");
console.log("  ✓ Command argument autocompletions passed.");

console.log("\n=== Test 6: Extension Lifecycle & Commands ===");
const registeredHandlers = new Map();
const registeredCommands = new Map();
let lastNotification = "";
let currentWidgetKey = null;
let currentWidgetLines = null;

const mockPi = {
	on(event, handler) {
		registeredHandlers.set(event, handler);
	},
	registerCommand(name, opts) {
		registeredCommands.set(name, opts);
	},
};

const tempCwd = mkdtempSync(join(tmpdir(), "pi-image-pager-test-"));

const mockCtx = {
	cwd: tempCwd,
	ui: {
		notify(msg) {
			lastNotification = msg;
		},
		setWidget(key, content) {
			currentWidgetKey = key;
			currentWidgetLines = content;
		},
	},
};

imagePager(mockPi);

assert.ok(registeredHandlers.has("session_start"), "session_start hook must be registered");
assert.ok(registeredHandlers.has("context"), "context hook must be registered");
assert.ok(registeredHandlers.has("session_shutdown"), "session_shutdown hook must be registered");
assert.ok(registeredCommands.has("image-pager"), "image-pager command must be registered");
assert.ok(registeredCommands.has("image-paging"), "image-paging alias must be registered");

const cmdDef = registeredCommands.get("image-pager");
assert.ok(cmdDef.getArgumentCompletions, "getArgumentCompletions must be registered on command");

// Test context hook execution
const contextHandler = registeredHandlers.get("context");
const mockEvent = { messages: [...messages] };
const hookResult = await contextHandler(mockEvent, mockCtx);
assert.ok(hookResult && hookResult.messages, "Context hook should return modified messages");
assert.equal(hookResult.messages[2].content[1].type, "text");
assert.equal(stats.pagedOutImagesCount >= 2, true, "Telemetry count should increment");
assert.ok(stats.savedBytes > 0, "Saved bytes should be tracked");
console.log("  ✓ Context hook triggers paging and updates telemetry.");

// Test command handler: default empty args should execute status!
const cmd = registeredCommands.get("image-pager");
await cmd.handler("", mockCtx);
assert.equal(currentWidgetKey, "image-pager-status", "Should display widget for status");
assert.ok(currentWidgetLines && currentWidgetLines.length > 0);
const widgetText = currentWidgetLines.join("\n");
assert.ok(widgetText.includes("image-pager"), "Widget text should have header");
assert.ok(widgetText.includes("图像统计"), "Widget text should have image stats");
assert.ok(!widgetText.includes("Commands:"), "Widget text MUST NOT include verbose commands usage list!");
console.log("  ✓ Empty arguments default to compact status widget without usage clutter.");

await cmd.handler("strategy fifo", mockCtx);
assert.ok(lastNotification.includes("FIFO"));

await cmd.handler("strategy turn-boundary", mockCtx);
assert.ok(lastNotification.includes("Cache-Friendly"));

await cmd.handler("keep 3", mockCtx);
assert.ok(lastNotification.includes("3"));

await cmd.handler("lang zh", mockCtx);
assert.ok(lastNotification.includes("zh"));

await cmd.handler("reset", mockCtx);
assert.equal(stats.pagedOutImagesCount, 0, "Stats should reset");
assert.ok(lastNotification.includes("reset"));

console.log("  ✓ CLI commands executed and verified.");


// Cleanup temp directory
try {
	rmSync(tempCwd, { recursive: true, force: true });
} catch {}

console.log("\nALL IMAGE PAGER TESTS PASSED! 🎉\n");
