import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
	DEFAULT_CONFIG,
	matchesPattern,
	matchesAnyPattern,
	mergeConfig,
	compressPayload,
	shouldCompressRequest,
	formatBytes,
	isAlreadyCompressed,
} from "../extensions/request-compress.ts";

console.log("=== Test 1: Configuration & Merging ===");
assert.equal(DEFAULT_CONFIG.enabled, true);
assert.equal(DEFAULT_CONFIG.algorithm, "zstd");
assert.deepEqual(DEFAULT_CONFIG.providers, ["default"]);
assert.deepEqual(DEFAULT_CONFIG.models, ["*"]);
assert.equal(DEFAULT_CONFIG.minBytesThreshold, 1024);

const merged = mergeConfig(DEFAULT_CONFIG, {
	algorithm: "gzip",
	minBytesThreshold: 2048,
	providers: ["yqdcc-*"],
	models: ["gemini-*"],
});
assert.equal(merged.algorithm, "gzip");
assert.equal(merged.minBytesThreshold, 2048);
assert.deepEqual(merged.providers, ["yqdcc-*"]);
assert.deepEqual(merged.models, ["gemini-*"]);
console.log("  ✓ Config merging passed.");

console.log("=== Test 2: Pattern Matching ===");
assert.equal(matchesPattern("yqdcc-gemini", "*"), true);
assert.equal(matchesPattern("yqdcc-gemini", "yqdcc-*"), true);
assert.equal(matchesPattern("openai", "yqdcc-*"), false);
assert.equal(matchesPattern("gemini-3.8-flash-high", "gemini-*"), true);
assert.equal(matchesPattern("gpt-5.6-luna", "gemini-*"), false);
assert.equal(matchesAnyPattern("gemini-pro", ["gpt-*", "gemini-*"]), true);
assert.equal(matchesAnyPattern("claude-opus", ["gpt-*", "gemini-*"]), false);
console.log("  ✓ Pattern matching passed.");

console.log("=== Test 3: Compression Algorithms & Magic Detection ===");
const samplePayload = Buffer.from(
	JSON.stringify({
		model: "gemini-3.8-flash-high",
		messages: [{ role: "user", content: "Repeat text ".repeat(100) }],
	}),
);

// 3.1 zstd
const zstdRes = compressPayload(samplePayload, "zstd", DEFAULT_CONFIG);
assert.ok(zstdRes, "zstd compression should produce result");
assert.equal(zstdRes.encoding, "zstd");
assert.ok(zstdRes.compressed.length < samplePayload.length);
assert.equal(isAlreadyCompressed(zstdRes.compressed), true);
if (typeof zlib.zstdDecompressSync === "function") {
	const decompressed = zlib.zstdDecompressSync(zstdRes.compressed);
	assert.equal(decompressed.toString("utf-8"), samplePayload.toString("utf-8"));
}
console.log(`  ✓ zstd: ${samplePayload.length}B -> ${zstdRes.compressed.length}B`);

// 3.2 gzip
const gzipRes = compressPayload(samplePayload, "gzip", DEFAULT_CONFIG);
assert.ok(gzipRes);
assert.equal(gzipRes.encoding, "gzip");
assert.ok(gzipRes.compressed.length < samplePayload.length);
assert.equal(isAlreadyCompressed(gzipRes.compressed), true);
const decompressedGzip = zlib.gunzipSync(gzipRes.compressed);
assert.equal(decompressedGzip.toString("utf-8"), samplePayload.toString("utf-8"));
console.log(`  ✓ gzip: ${samplePayload.length}B -> ${gzipRes.compressed.length}B`);

// Raw payload should NOT be detected as compressed
assert.equal(isAlreadyCompressed(samplePayload), false);
console.log("  ✓ isAlreadyCompressed correctly distinguishes raw vs compressed data.");

console.log("=== Test 4: Request Filtering Criteria (shouldCompressRequest) ===");
const envCtx = {
	defaultProvider: "yqdcc-gemini",
	providerBaseUrls: new Map([
		["cpa-origin.yqdcc.site", "yqdcc-gemini"],
		["101.35.25.253", "yqdcc-openai"],
	]),
	modelToProvider: new Map([
		["gemini-3.8-flash-high", "yqdcc-gemini"],
		["gpt-6-astra", "yqdcc-openai"],
	]),
};

// 4.1 Below threshold
const smallPayload = Buffer.from(JSON.stringify({ model: "gemini-3.8-flash-high", input: "hi" }));
const r1 = shouldCompressRequest(
	"https://cpa-origin.yqdcc.site/v1/responses",
	"POST",
	smallPayload,
	undefined,
	DEFAULT_CONFIG,
	envCtx,
);
assert.equal(r1.shouldCompress, false);
assert.match(r1.reason, /below threshold/i);

// 4.2 Large payload matching default provider
const largePayload = Buffer.from(
	JSON.stringify({ model: "gemini-3.8-flash-high", input: "x".repeat(2000) }),
);
const r2 = shouldCompressRequest(
	"https://cpa-origin.yqdcc.site/v1/responses",
	"POST",
	largePayload,
	undefined,
	DEFAULT_CONFIG,
	envCtx,
);
assert.equal(r2.shouldCompress, true);
assert.equal(r2.modelId, "gemini-3.8-flash-high");
assert.equal(r2.providerId, "yqdcc-gemini");

// 4.3 Protection: already has Content-Encoding in headers
const rAlreadyEncoded = shouldCompressRequest(
	"https://cpa-origin.yqdcc.site/v1/responses",
	"POST",
	largePayload,
	"zstd",
	DEFAULT_CONFIG,
	envCtx,
);
assert.equal(rAlreadyEncoded.shouldCompress, false);
assert.match(rAlreadyEncoded.reason, /already has Content-Encoding/i);

// 4.4 Protection: body is already compressed binary data
const rAlreadyCompData = shouldCompressRequest(
	"https://cpa-origin.yqdcc.site/v1/responses",
	"POST",
	zstdRes.compressed,
	undefined,
	DEFAULT_CONFIG,
	envCtx,
);
assert.equal(rAlreadyCompData.shouldCompress, false);
assert.match(rAlreadyCompData.reason, /already compressed binary/i);

// 4.5 Protection: non-JSON body
const invalidJson = Buffer.from("not-a-json-payload-binary-or-text-data-padding".repeat(30));
const rInvalidJson = shouldCompressRequest(
	"https://cpa-origin.yqdcc.site/v1/responses",
	"POST",
	invalidJson,
	undefined,
	DEFAULT_CONFIG,
	envCtx,
);
assert.equal(rInvalidJson.shouldCompress, false);
assert.match(rInvalidJson.reason, /cannot be parsed as JSON/i);

// 4.6 Non-default provider when config.providers = ["default"]
const otherPayload = Buffer.from(
	JSON.stringify({ model: "gpt-6-astra", input: "x".repeat(2000) }),
);
const r3 = shouldCompressRequest(
	"https://101.35.25.253/v1/responses",
	"POST",
	otherPayload,
	undefined,
	DEFAULT_CONFIG,
	envCtx,
);
assert.equal(r3.shouldCompress, false);
assert.match(r3.reason, /not in target providers/i);

// 4.7 Excluded model
const r5 = shouldCompressRequest(
	"https://cpa-origin.yqdcc.site/v1/responses",
	"POST",
	largePayload,
	undefined,
	{ ...DEFAULT_CONFIG, excludeModels: ["gemini-*"] },
	envCtx,
);
assert.equal(r5.shouldCompress, false);
assert.match(r5.reason, /in excludeModels/i);

console.log("  ✓ All filtering and safeguard criteria passed.");

console.log("=== Test 5: Utilities & Formatting ===");
assert.equal(formatBytes(500), "500 B");
assert.equal(formatBytes(2048), "2.0 KB");
assert.equal(formatBytes(1572864), "1.50 MB");
console.log("  ✓ Utilities passed.");

console.log("\nALL REQUEST COMPRESS TESTS PASSED! 🎉");
