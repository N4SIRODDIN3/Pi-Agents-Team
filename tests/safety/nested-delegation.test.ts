import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolveProfile } from "../../src/profiles/loader";
import { applyLaunchPolicy, NESTED_DELEGATION_TOOLS } from "../../src/safety/launch-policy";
import { DEFAULT_TEAM_CONFIG } from "../../src/config";
import type { TeamProfileSpec } from "../../src/types";

// A real entry inside this checkout, so the recursive-extension guard is exercised.
const SELF_ENTRY = resolve("extensions/pi-agent-team/index.ts");

function nestedProfile(name = "reviewer"): TeamProfileSpec {
	return { ...resolveProfile(name), canSpawnWorkers: true };
}

function policyFor(profile: TeamProfileSpec, workerDepth = 1) {
	// Note: an explicit `undefined` argument would fall back to the default, so
	// the no-self-entry case is exercised by calling applyLaunchPolicy directly.
	return applyLaunchPolicy({ cwd: process.cwd(), profile, workerDepth, selfEntryPath: SELF_ENTRY }, DEFAULT_TEAM_CONFIG);
}

test("a role without canSpawnWorkers never gains the orchestrator extension", () => {
	const profile = { ...resolveProfile("reviewer"), canSpawnWorkers: false };
	const plan = policyFor(profile);
	assert.equal(plan.nestedDelegation, false);
	assert.equal(plan.workerExtensions, undefined);
	for (const tool of NESTED_DELEGATION_TOOLS) assert.equal(plan.tools.includes(tool), false, tool);
});

test("canSpawnWorkers wires the self entry and the collaboration tools", () => {
	const plan = policyFor(nestedProfile());
	assert.equal(plan.nestedDelegation, true);
	assert.deepEqual(plan.workerExtensions, [SELF_ENTRY]);
	for (const tool of NESTED_DELEGATION_TOOLS) assert.ok(plan.tools.includes(tool), tool);
	// The role's own tool set is preserved, not replaced.
	assert.ok(plan.tools.includes("read"));
});

test("nested workers cannot smuggle the orchestrator extension without opting in", () => {
	const profile = { ...resolveProfile("reviewer"), canSpawnWorkers: false, extensions: [SELF_ENTRY] };
	assert.throws(() => policyFor(profile), /Recursive orchestrator extension source/);
});

test("depth above safety.maxWorkerDepth is rejected before any launch", () => {
	const config = { ...DEFAULT_TEAM_CONFIG, safety: { ...DEFAULT_TEAM_CONFIG.safety, maxWorkerDepth: 1 } };
	assert.throws(
		() => applyLaunchPolicy({ cwd: process.cwd(), profile: nestedProfile(), workerDepth: 2, selfEntryPath: SELF_ENTRY }, config),
		/exceeds the configured limit 1/,
	);
	// The same role at the permitted depth still launches.
	const plan = applyLaunchPolicy({ cwd: process.cwd(), profile: nestedProfile(), workerDepth: 1, selfEntryPath: SELF_ENTRY }, config);
	assert.equal(plan.nestedDelegation, true);
	assert.equal(plan.workerDepth, 1);
	assert.equal(plan.maxWorkerDepth, 1);
});

test("maxWorkerDepth 0 disables nesting even for opted-in roles", () => {
	const config = { ...DEFAULT_TEAM_CONFIG, safety: { ...DEFAULT_TEAM_CONFIG.safety, maxWorkerDepth: 0 } };
	assert.throws(
		() => applyLaunchPolicy({ cwd: process.cwd(), profile: nestedProfile(), workerDepth: 1, selfEntryPath: SELF_ENTRY }, config),
		/exceeds the configured limit 0/,
	);
});

test("canSpawnWorkers without an extension entry fails closed", () => {
	assert.throws(
		() => applyLaunchPolicy({ cwd: process.cwd(), profile: nestedProfile(), workerDepth: 1 }, DEFAULT_TEAM_CONFIG),
		/no extension entry path/,
	);
});

test("canSpawnWorkers with extensionMode disable fails closed", () => {
	const profile = { ...nestedProfile(), extensionMode: "disable" as const };
	assert.throws(() => policyFor(profile), /extensionMode is disable/);
});

test("a user extension plus nesting keeps both, self entry first", () => {
	const profile = { ...nestedProfile(), extensions: ["./third-party-provider.ts"] };
	const plan = policyFor(profile);
	// Profile extension sources are preserved verbatim; only the self entry is prepended.
	assert.deepEqual(plan.workerExtensions, [SELF_ENTRY, "./third-party-provider.ts"]);
});

test("deeper levels keep the collaboration tools so grandchildren can spawn", () => {
	const config = { ...DEFAULT_TEAM_CONFIG, safety: { ...DEFAULT_TEAM_CONFIG.safety, maxWorkerDepth: 3 } };
	const plan = applyLaunchPolicy(
		{ cwd: process.cwd(), profile: nestedProfile(), workerDepth: 2, selfEntryPath: SELF_ENTRY },
		config,
	);
	assert.equal(plan.workerDepth, 2);
	assert.equal(plan.maxWorkerDepth, 3);
	for (const tool of NESTED_DELEGATION_TOOLS) assert.ok(plan.tools.includes(tool), tool);
});
