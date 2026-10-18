import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mutations = [
	{
		name: "Mutation 1: Re-introducing before_provider_request payload tampering",
		mutate: src => src.replace('syncActiveTools(config.enabled);', 'syncActiveTools(config.enabled);\npi.on("before_provider_request", () => {});'),
		expectedErrorKeyword: "before_provider_request",
	},
	{
		name: "Mutation 2: Removing defaultActive: false (violates declarative isolation)",
		mutate: src => src.replace('defaultActive: false,', 'defaultActive: true,'),
		expectedErrorKeyword: "defaultActive: false",
	},
	{
		name: "Mutation 3: Dropping onPersist callback in modal c/x status change",
		mutate: src => src.replace('this.onPersist?.();', '// onPersist omitted (dropped persistence)'),
		expectedErrorKeyword: "MUST trigger onPersist callback",
	},
	{
		name: "Mutation 4: Overwriting completed subtask on parent cancellation",
		mutate: src => src.replace('if (newStatus === "cancelled" && t.status === "completed") {', 'if (false && t.status === "completed") { // broken protection'),
		expectedErrorKeyword: "Completed subtask 1.1 MUST NOT be overwritten",
	},
];

/** Mutants and their test suite live only in a disposable copy, never in the checkout. */
export function runMutationTests(repoRoot = resolve(import.meta.dirname, "..")) {
	const workspace = mkdtempSync(join(tmpdir(), "pi-todo-mutation-"));
	try {
		cpSync(join(repoRoot, "extensions"), join(workspace, "extensions"), { recursive: true, dereference: true });
		mkdirSync(join(workspace, "scripts"));
		cpSync(join(repoRoot, "scripts", "test-todo-tree.mjs"), join(workspace, "scripts", "test-todo-tree.mjs"));
		writeFileSync(join(workspace, "package.json"), '{"type":"module"}\n');
		// Link dependencies read-only in practice; all writes below target the copy.
		symlinkSync(join(repoRoot, "node_modules"), join(workspace, "node_modules"), process.platform === "win32" ? "junction" : "dir");
		const home = join(workspace, "home");
		const agent = join(home, ".pi", "agent");
		mkdirSync(agent, { recursive: true });
		const targetFile = join(workspace, "extensions", "todo-tree.ts");
		const originalSource = readFileSync(targetFile, "utf8");

		for (const mutation of mutations) {
			const mutatedSource = mutation.mutate(originalSource);
			assert.notEqual(mutatedSource, originalSource, `Mutation did not match source: ${mutation.name}`);
			writeFileSync(targetFile, mutatedSource, "utf8");
			const result = spawnSync(process.execPath, [join(workspace, "scripts", "test-todo-tree.mjs")], {
				cwd: workspace,
				encoding: "utf8",
				timeout: 30_000,
				env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent },
			});
			if (result.error) throw result.error;
			assert.equal(result.signal, null, `Test process was interrupted: ${mutation.name}`);
			assert.notEqual(result.status, 0, `TEST SUITE FAILED TO KILL MUTANT: ${mutation.name}`);
			const output = (result.stdout || "") + (result.stderr || "");
			assert.ok(output.includes(mutation.expectedErrorKeyword), `Unexpected failure for ${mutation.name}:\n${output.slice(0, 1200)}`);
			console.log(`  ✓ Successfully killed mutant: ${mutation.name}`);
		}
	} finally {
		// A hard interruption may leave a temp directory, but never a dirty source
		// file. There is no backup restore that could overwrite concurrent edits.
		rmSync(workspace, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log("=== Running isolated mutation tests for todo-tree ===");
	runMutationTests();
	console.log("🎉 ALL MUTANTS KILLED without modifying the checkout.");
}
