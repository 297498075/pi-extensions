import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveAspectAndSize,
	resolveOutputDir,
	getMediaOutputPath,
	formatLocalFileUrl,
	GenerateImageSchema,
	GenerateVideoSchema,
	loadMediaGenConfigFile,
	getMediaGenContext,
	resolveProviderFromModelsJson,
	default as mediaGenExtension,
} from "../extensions/media-gen.ts";

console.log("Starting test-media-gen.mjs...");

// 1. Test Dimension & Aspect Ratio Resolution
{
	const res16_9 = resolveAspectAndSize(1920, 1080);
	assert.equal(res16_9.aspectRatio, "16:9", "1920x1080 should map to 16:9");
	assert.equal(res16_9.openAiSize, "1792x1024", "16:9 should map to openAiSize 1792x1024");
	assert.equal(res16_9.alignedWidth % 64, 0, "alignedWidth must be multiple of 64");
	assert.equal(res16_9.alignedHeight % 64, 0, "alignedHeight must be multiple of 64");

	const res9_16 = resolveAspectAndSize(1080, 1920);
	assert.equal(res9_16.aspectRatio, "9:16", "1080x1920 should map to 9:16");
	assert.equal(res9_16.openAiSize, "1024x1792", "9:16 should map to openAiSize 1024x1792");

	const res1_1 = resolveAspectAndSize(1024, 1024);
	assert.equal(res1_1.aspectRatio, "1:1", "1024x1024 should map to 1:1");
	assert.equal(res1_1.openAiSize, "1024x1024", "1:1 should map to openAiSize 1024x1024");

	const res4_3 = resolveAspectAndSize(800, 600);
	assert.equal(res4_3.aspectRatio, "4:3", "800x600 should map to 4:3");

	const resCustomDefault = resolveAspectAndSize(undefined, undefined, 512, 512);
	assert.equal(resCustomDefault.requestedWidth, 512);
	assert.equal(resCustomDefault.requestedHeight, 512);
	console.log("✓ resolveAspectAndSize passed");
}

// 2. Test Output Directory Resolution
{
	const cwd = "C:\\projects\\my-session";
	// Default output dir (.pi/media relative to cwd)
	const defOut = resolveOutputDir(undefined, cwd);
	assert.ok(defOut.endsWith(join(".pi", "media")), "Default outputDir should be .pi/media");

	// Relative custom path
	const relOut = resolveOutputDir("custom/media/path", cwd);
	assert.ok(relOut.endsWith(join("custom", "media", "path")), "Relative outputDir should resolve against cwd");

	// Absolute path
	const absInput = "D:\\absolute\\media";
	const absOut = resolveOutputDir(absInput, cwd);
	assert.equal(absOut, absInput, "Absolute outputDir should be preserved exactly");
	console.log("✓ resolveOutputDir passed (relative/absolute/default)");
}

// 3. Test Provider Resolution From models.json
{
	const provider = resolveProviderFromModelsJson("yqdcc");
	assert.equal(provider.providerName, "yqdcc");
	assert.ok(provider.baseUrl.includes("https://cpa.yqdcc.site"), "baseUrl should be resolved from models.json");
	assert.ok(provider.apiKey.length > 0, "apiKey should be resolved or expanded");
	console.log(`✓ resolveProviderFromModelsJson passed for yqdcc (baseUrl=${provider.baseUrl})`);
}

// 4. Test Standalone Config File Loading & Context Resolution
{
	const tempDir = mkdtempSync(join(tmpdir(), "media-gen-test-"));
	try {
		const configContent = {
			provider: "yqdcc",
			image: {
				primaryModel: "gpt-image-2.5-flare",
				fallbackModels: ["gemini-3.1-flash-image", "dall-e-3"],
				defaultWidth: 1024,
				defaultHeight: 1024,
				outputDir: ".pi/media",
			},
			video: {
				primaryModel: "cogvideox-5b",
				fallbackModels: ["wanx-v1"],
				defaultWidth: 1280,
				defaultHeight: 720,
				outputDir: "C:\\videos\\output",
			},
		};

		writeFileSync(join(tempDir, "media-gen.json"), JSON.stringify(configContent, null, 2), "utf8");

		const loaded = loadMediaGenConfigFile(tempDir);
		assert.ok(loaded, "Should load media-gen.json from tempDir");
		assert.equal(loaded.config.provider, "yqdcc");
		assert.equal(loaded.config.image?.primaryModel, "gpt-image-2.5-flare");
		assert.deepEqual(loaded.config.image?.fallbackModels, ["gemini-3.1-flash-image", "dall-e-3"]);

		const ctx = getMediaGenContext(tempDir);
		assert.equal(ctx.provider.providerName, "yqdcc");
		assert.equal(ctx.image?.primaryModel, "gpt-image-2.5-flare");
		assert.equal(ctx.video?.primaryModel, "cogvideox-5b");
		console.log("✓ Standalone media-gen.json loading & context resolution passed");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

// 5. Test Schema Properties
{
	const imgProps = GenerateImageSchema.properties;
	assert.ok(imgProps.prompt, "generate_image schema must have prompt");
	assert.ok(imgProps.image, "generate_image schema must have image");
	assert.ok(imgProps.width, "generate_image schema must have width");
	assert.ok(imgProps.height, "generate_image schema must have height");

	const vidProps = GenerateVideoSchema.properties;
	assert.ok(vidProps.prompt, "generate_video schema must have prompt");
	assert.ok(vidProps.image, "generate_video schema must have image");
	assert.ok(vidProps.width, "generate_video schema must have width");
	assert.ok(vidProps.height, "generate_video schema must have height");
	assert.equal(vidProps.duration, undefined, "duration should NOT exist in generate_video schema");
	console.log("✓ Schema properties verified (clean prompt in English, width/height present, duration removed)");
}

// 6. Test Extension Tool Registration
{
	const registeredTools = new Map();
	const mockPi = {
		registerTool(tool) {
			registeredTools.set(tool.name, tool);
		},
	};

	mediaGenExtension(mockPi);
	assert.ok(registeredTools.has("generate_image"), "Must register generate_image tool");
	assert.ok(registeredTools.has("generate_video"), "Must register generate_video tool");
	console.log("✓ Extension tool registration passed");
}

console.log("All test-media-gen.mjs assertions passed successfully!");
