import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActiveTeamConfig } from "../../src/project-config/loader";

function projectWith(config: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "pi-team-nesting-"));
	mkdirSync(join(root, ".pi", "agent"), { recursive: true });
	writeFileSync(join(root, ".pi", "agent", "agents-team.json"), JSON.stringify(config, null, 2));
	return root;
}

const BASE = {
	schemaVersion: 4,
	scaffoldVersion: 3,
	enabled: true,
	roles: {
		coordinator: {
			whenToUse: "Use to split work.",
			access: { tools: ["read"], extensionMode: "worker-minimal", canSpawnWorkers: true },
		},
	},
};

test("workerAccess.maxWorkerDepth sets the nesting budget from agents-team.json", () => {
	const root = projectWith({ ...BASE, workerAccess: { maxWorkerDepth: 2 } });
	const loaded = loadActiveTeamConfig({ cwd: root, projectConfigTrusted: true });
	assert.equal(loaded.config.safety.maxWorkerDepth, 2);
	assert.deepEqual(loaded.config.profiles.map((profile) => profile.name), ["coordinator"]);
	assert.equal(loaded.config.profiles[0]?.canSpawnWorkers, true);
});

test("an absent maxWorkerDepth keeps the default budget", () => {
	const root = projectWith(BASE);
	const loaded = loadActiveTeamConfig({ cwd: root, projectConfigTrusted: true });
	assert.equal(loaded.config.safety.maxWorkerDepth, 1);
});

test("an out-of-range maxWorkerDepth invalidates the file instead of silently clamping", () => {
	// The schema bounds the value at 0..8; anything outside is a config error, so
	// the session keeps the safe default rather than a surprising large budget.
	const high = loadActiveTeamConfig({ cwd: projectWith({ ...BASE, workerAccess: { maxWorkerDepth: 99 } }), projectConfigTrusted: true });
	assert.equal(high.config.safety.maxWorkerDepth, 1);
	assert.notEqual(high.status, "project");

	const negative = loadActiveTeamConfig({ cwd: projectWith({ ...BASE, workerAccess: { maxWorkerDepth: -3 } }), projectConfigTrusted: true });
	assert.equal(negative.config.safety.maxWorkerDepth, 1);
});

test("maxWorkerDepth 0 disables nesting while keeping the role", () => {
	const loaded = loadActiveTeamConfig({ cwd: projectWith({ ...BASE, workerAccess: { maxWorkerDepth: 0 } }), projectConfigTrusted: true });
	assert.equal(loaded.config.safety.maxWorkerDepth, 0);
	assert.deepEqual(loaded.config.profiles.map((profile) => profile.name), ["coordinator"]);
});
