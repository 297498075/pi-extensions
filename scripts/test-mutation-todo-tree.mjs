import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

console.log("=== Running Mutation Tests for todo-tree test suite ===");

const targetFile = resolve("extensions/todo-tree.ts");
const originalSource = readFileSync(targetFile, "utf8");

// Mutation cases: inject known bugs/regressions into extensions/todo-tree.ts
// The test suite (test-todo-tree.mjs) MUST detect them and FAIL (non-zero exit code).
const mutations = [
	{
		name: "Mutation 1: Re-introducing before_provider_request payload tampering",
		mutate: (src) =>
			src.replace(
				'syncActiveTools(config.enabled);',
				'syncActiveTools(config.enabled);\npi.on("before_provider_request", () => {});',
			),
		expectedErrorKeyword: "before_provider_request",
	},
	{
		name: "Mutation 2: Removing defaultActive: false (violates declarative isolation)",
		mutate: (src) =>
			src.replace(
				'defaultActive: false,',
				'defaultActive: true,',
			),
		expectedErrorKeyword: "defaultActive: false",
	},
	{
		name: "Mutation 3: Dropping onPersist callback in modal c/x status change",
		mutate: (src) =>
			src.replace(
				'this.onPersist?.();',
				'// onPersist omitted (dropped persistence)',
			),
		expectedErrorKeyword: "MUST trigger onPersist callback",
	},
	{
		name: "Mutation 4: Overwriting completed subtask on parent cancellation",
		mutate: (src) =>
			src.replace(
				'if (newStatus === "cancelled" && t.status === "completed") {',
				'if (false && t.status === "completed") { // broken protection: allow overwriting completed',
			),
		expectedErrorKeyword: "Completed subtask 1.1 MUST NOT be overwritten",
	},
];

let allMutationsKilled = true;

try {
	for (const mut of mutations) {
		const mutatedSource = mut.mutate(originalSource);
		assert.notEqual(
			mutatedSource,
			originalSource,
			`Mutation "${mut.name}" failed to modify source code!`,
		);

		// Write mutated source temporarily
		writeFileSync(targetFile, mutatedSource, "utf8");

		// Run the test suite against the mutant
		const res = spawnSync(process.execPath, ["./scripts/test-todo-tree.mjs"], {
			encoding: "utf8",
		});

		// The test suite MUST fail on mutated code
		if (res.status === 0) {
			console.error(`❌ TEST SUITE FAILED TO KILL MUTANT: ${mut.name}`);
			console.error("Test suite unexpectedly PASSED when mutant was injected!");
			allMutationsKilled = false;
			break;
		}

		// Verify the failure caught the expected bug
		const output = (res.stdout || "") + (res.stderr || "");
		if (mut.expectedErrorKeyword && !output.includes(mut.expectedErrorKeyword)) {
			console.error(`⚠ Mutant was killed with unexpected error: ${mut.name}`);
			console.error(`Expected keyword: "${mut.expectedErrorKeyword}"`);
			console.error(`Actual output:\n${output.slice(0, 500)}`);
			allMutationsKilled = false;
			break;
		}

		console.log(`  ✓ Successfully killed mutant: ${mut.name}`);
	}
} finally {
	// Guarantee pristine source code restoration
	writeFileSync(targetFile, originalSource, "utf8");
}

if (!allMutationsKilled) {
	console.error("\n❌ Mutation testing gate FAILED: Test suite has blind spots!");
	process.exit(1);
} else {
	console.log("\n🎉 ALL MUTANTS KILLED: Test suite has true fault detection capability!");
}
