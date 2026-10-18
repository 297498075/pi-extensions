import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const productionPath = join(repo, "extensions", "todo-tree.ts");
const productionBytes = readFileSync(productionPath);
const root = mkdtempSync(join(tmpdir(), "mutation-safety-"));
const expectedFailures = "before_provider_request defaultActive: false MUST trigger onPersist callback Completed subtask 1.1 MUST NOT be overwritten";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(name, testSource) {
	const cwd = join(root, name);
	for (const dir of ["extensions", "scripts", "node_modules", "temp"]) mkdirSync(join(cwd, dir), { recursive: true });
	copyFileSync(productionPath, join(cwd, "extensions", "todo-tree.ts"));
	copyFileSync(join(repo, "scripts", "test-mutation-todo-tree.mjs"), join(cwd, "scripts", "test-mutation-todo-tree.mjs"));
	writeFileSync(join(cwd, "scripts", "test-todo-tree.mjs"), testSource);
	const target = join(cwd, "extensions", "todo-tree.ts");
	return { cwd, target, runner: join(cwd, "scripts", "test-mutation-todo-tree.mjs"), env: {
		...process.env, PI_MUTATION_FIXTURE_SOURCE: target, PI_MUTATION_FIXTURE_READY: join(cwd, "ready.json"),
		TMPDIR: join(cwd, "temp"), TEMP: join(cwd, "temp"), TMP: join(cwd, "temp"),
	} };
}
try {
	const concurrent = fixture("concurrent", `
import {appendFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
assert.notEqual(resolve('extensions/todo-tree.ts'),process.env.PI_MUTATION_FIXTURE_SOURCE);
assert.ok(readFileSync(resolve('extensions/todo-tree.ts'),'utf8').length>0);
appendFileSync(process.env.PI_MUTATION_FIXTURE_SOURCE,'\\n// CONCURRENT_USER_EDIT\\n');
console.log(${JSON.stringify(expectedFailures)});process.exit(1);
`);
	const result = spawnSync(process.execPath, [concurrent.runner], { cwd: concurrent.cwd, env: concurrent.env, encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr + result.stdout);
	const edited = readFileSync(concurrent.target, "utf8");
	assert.equal(edited, productionBytes.toString("utf8") + "\n// CONCURRENT_USER_EDIT\n".repeat(4), "normal completion must preserve every concurrent checkout edit");
	console.log("✓ successful mutation testing never restores over concurrent edits");

	const interrupted = fixture("interrupted", `
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.PI_MUTATION_FIXTURE_READY,JSON.stringify({workspace:process.cwd()}));
setTimeout(()=>{console.log(${JSON.stringify(expectedFailures)});process.exit(1)},700);
`);
	const child = spawn(process.execPath, [interrupted.runner], { cwd: interrupted.cwd, env: interrupted.env, stdio: "ignore" });
	const exited = new Promise((resolve, reject) => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
	try {
		const deadline = Date.now() + 5000;
		while (!existsSync(interrupted.env.PI_MUTATION_FIXTURE_READY) && Date.now() < deadline) await wait(10);
		assert.ok(existsSync(interrupted.env.PI_MUTATION_FIXTURE_READY), "child test must reach the mutated sandbox");
		const { workspace } = JSON.parse(readFileSync(interrupted.env.PI_MUTATION_FIXTURE_READY, "utf8"));
		assert.notEqual(workspace, interrupted.cwd);
		assert.ok(readFileSync(join(workspace, "extensions", "todo-tree.ts"), "utf8").includes('pi.on("before_provider_request", () => {});'));
		child.kill("SIGINT");
		await exited;
		await wait(900); // let the stub test finish; it can never touch production code
		assert.deepEqual(readFileSync(interrupted.target), productionBytes, "interruptions may leave temp files, never mutants in the checkout");
	} finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
	console.log("✓ SIGINT during mutation testing leaves checkout source byte-for-byte intact");

	const failing = fixture("failure", "console.error('unexpected test infrastructure failure');process.exit(2);");
	const failed = spawnSync(process.execPath, [failing.runner], { cwd: failing.cwd, env: failing.env, encoding: "utf8", timeout: 10_000 });
	assert.notEqual(failed.status, 0);
	assert.deepEqual(readFileSync(failing.target), productionBytes);
	assert.deepEqual(readFileSync(productionPath), productionBytes, "safety tests themselves must not change production source");
	console.log("✓ unexpected test failures are not counted as killed mutants and never touch source");
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("All mutation-isolation regressions passed.");
