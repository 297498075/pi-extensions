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

console.log("=== Test 3: Compression Algorithms ===");
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
const decompressedGzip = zlib.gunzipSync(gzipRes.compressed);
assert.equal(decompressedGzip.toString("utf-8"), samplePayload.toString("utf-8"));
console.log(`  ✓ gzip: ${samplePayload.length}B -> ${gzipRes.compressed.length}B`);

// 3.3 deflate
const deflateRes = compressPayload(samplePayload, "deflate", DEFAULT_CONFIG);
assert.ok(deflateRes);
assert.equal(deflateRes.encoding, "deflate");
const decompressedDeflate = zlib.inflateSync(deflateRes.compressed);
assert.equal(decompressedDeflate.toString("utf-8"), samplePayload.toString("utf-8"));
console.log(`  ✓ deflate: ${samplePayload.length}B -> ${deflateRes.compressed.length}B`);

// 3.4 br
const brRes = compressPayload(samplePayload, "br", DEFAULT_CONFIG);
assert.ok(brRes);
assert.equal(brRes.encoding, "br");
const decompressedBr = zlib.brotliDecompressSync(brRes.compressed);
assert.equal(decompressedBr.toString("utf-8"), samplePayload.toString("utf-8"));
console.log(`  ✓ br: ${samplePayload.length}B -> ${brRes.compressed.length}B`);

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
	DEFAULT_CONFIG,
	envCtx,
);
assert.equal(r2.shouldCompress, true);
assert.equal(r2.modelId, "gemini-3.8-flash-high");
assert.equal(r2.providerId, "yqdcc-gemini");

// 4.3 Non-default provider when config.providers = ["default"]
const otherPayload = Buffer.from(
	JSON.stringify({ model: "gpt-6-astra", input: "x".repeat(2000) }),
);
const r3 = shouldCompressRequest(
	"https://101.35.25.253/v1/responses",
	"POST",
	otherPayload,
	DEFAULT_CONFIG,
	envCtx,
);
assert.equal(r3.shouldCompress, false);
assert.match(r3.reason, /not in target providers/i);

// 4.4 All providers enabled when config.providers = ["*"]
const r4 = shouldCompressRequest(
	"https://101.35.25.253/v1/responses",
	"POST",
	otherPayload,
	{ ...DEFAULT_CONFIG, providers: ["*"] },
	envCtx,
);
assert.equal(r4.shouldCompress, true);

// 4.5 Excluded model
const r5 = shouldCompressRequest(
	"https://cpa-origin.yqdcc.site/v1/responses",
	"POST",
	largePayload,
	{ ...DEFAULT_CONFIG, excludeModels: ["gemini-*"] },
	envCtx,
);
assert.equal(r5.shouldCompress, false);
assert.match(r5.reason, /in excludeModels/i);

console.log("  ✓ All filtering criteria passed.");

console.log("=== Test 5: Utilities & Formatting ===");
assert.equal(formatBytes(500), "500 B");
assert.equal(formatBytes(2048), "2.0 KB");
assert.equal(formatBytes(1572864), "1.50 MB");
console.log("  ✓ Utilities passed.");

console.log("\nALL REQUEST COMPRESS TESTS PASSED! 🎉");
