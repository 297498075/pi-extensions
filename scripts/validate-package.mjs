import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packagePath = join(root, "package.json");
const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
const resourceTypes = ["extensions", "skills", "prompts", "themes"];

if (!manifest.pi || typeof manifest.pi !== "object") {
	throw new Error("package.json must define a pi manifest");
}

for (const resourceType of resourceTypes) {
	const paths = manifest.pi[resourceType];
	if (!Array.isArray(paths) || paths.length === 0) {
		throw new Error(`pi.${resourceType} must contain at least one path`);
	}

	for (const resourcePath of paths) {
		if (typeof resourcePath !== "string") {
			throw new Error(`pi.${resourceType} contains a non-string path`);
		}
		const absolutePath = resolve(root, resourcePath);
		if (!existsSync(absolutePath)) {
			throw new Error(`Missing ${resourceType} path: ${resourcePath}`);
		}
	}
}

const themeRoot = join(root, "themes");
for (const entry of readdirSync(themeRoot)) {
	const themePath = join(themeRoot, entry);
	if (!statSync(themePath).isFile() || !entry.endsWith(".json")) continue;
	try {
		JSON.parse(readFileSync(themePath, "utf8"));
	} catch (error) {
		throw new Error(`Invalid theme JSON: ${relative(root, themePath)}`, { cause: error });
	}
}

console.log("Pi package manifest and resource paths are valid.");
