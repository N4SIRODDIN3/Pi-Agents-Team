import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_TEAM_CONFIG } from "../config.js";
import { getWorkerPromptPath, loadWorkerPrompt } from "../prompts/contracts.js";
import { GENERIC_WORKER_PROMPT_SENTINEL } from "../project-config/loader.js";
import {
	ensureWriteScope,
	isPathScopeNarrowerOrEqual,
	isPathScopeWithinProjectRoot,
	isPathWithinProjectRoot,
	normalizePathScope,
} from "./path-scope.js";
import type { TeamConfig, TeamPathScope, TeamProfileSpec, ThinkingLevel, WorkerExtensionMode } from "../types.js";
import { isRecursiveOrchestratorExtensionSource } from "./self-extension.js";

export interface LaunchPolicyRequest {
	cwd: string;
	profile: TeamProfileSpec;
	pathScope?: TeamPathScope;
	model?: string;
	orchestratorModel?: string;
	orchestratorThinkingLevel?: ThinkingLevel;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	extensionMode?: WorkerExtensionMode;
	systemPromptPath?: string;
	/** Depth of the worker being launched: 1 is a direct child of the orchestrator. */
	workerDepth?: number;
	/** Absolute path of this package's own extension entry, required to nest. */
	selfEntryPath?: string;
}

export interface LaunchPolicyResult {
	cwd: string;
	profile: TeamProfileSpec;
	pathScope?: TeamPathScope;
	model?: string;
	thinkingLevel: ThinkingLevel;
	tools: string[];
	workerExtensions?: string[];
	extensionMode: WorkerExtensionMode;
	systemPromptPath: string;
	/** True when this worker may delegate to its own workers. */
	nestedDelegation: boolean;
	workerDepth: number;
	maxWorkerDepth: number;
}

function extensionModeRank(mode: WorkerExtensionMode): number {
	switch (mode) {
		case "disable":
			return 2;
		case "worker-minimal":
			return 1;
		case "inherit":
		default:
			return 0;
	}
}

function isExtensionModeNarrowerOrEqual(candidate: WorkerExtensionMode, baseline: WorkerExtensionMode): boolean {
	return extensionModeRank(candidate) >= extensionModeRank(baseline);
}

/**
 * Tools that can mutate filesystem state via Pi's structured write path. Pi
 * DOES NOT currently enforce pathScope at the tool layer — it is an
 * orchestrator-discipline + prompt-convention boundary, NOT an OS sandbox. We
 * track `edit` and `write` here because those are the tools the orchestrator
 * contract ties to `pathScope`. `bash` can also mutate filesystem state (it
 * runs arbitrary shell commands), but requiring a writable pathScope for
 * every read-only profile that includes bash for git/ls/grep would defeat the
 * built-in roles (explorer, observer, librarian, oracle, designer, reviewer
 * all rely on bash). The honest framing: if you include bash in a profile,
 * you are trusting the model + role prompt to not mutate — use a dedicated
 * writable role like `fixer` with `write: true` + an explicit `pathScope`
 * when you actually want the worker to change files. See docs/profiles.md
 * "bash as escape hatch" for the full rationale.
 */
const WRITE_CAPABLE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/**
 * Tools a nested worker needs to run its own team. They are injected from the
 * launch policy, never from user-authored role config, so a role cannot widen
 * its collaboration surface beyond what canSpawnWorkers grants.
 */
export const NESTED_DELEGATION_TOOLS = [
	"delegate_task",
	"agent_status",
	"agent_result",
	"agent_message",
	"wait_for_agents",
	"agent_cancel",
	"ping_agents",
] as const;

function rejectRecursiveOrchestratorExtensions(sources: readonly string[] | undefined, baseDir: string): void {
	const blockedSource = sources?.find((source) => isRecursiveOrchestratorExtensionSource(source, baseDir));
	if (!blockedSource) return;
	throw new Error(
		`Recursive orchestrator extension source "${blockedSource}" is blocked. Do not load pi-agents-team as a worker extension; use a third-party provider extension instead.`,
	);
}

function hasWriteTools(tools: string[]): boolean {
	return tools.some((tool) => WRITE_CAPABLE_TOOLS.has(tool));
}

/**
 * Materialize an inline or generic-sentinel prompt to a temp file so Pi's
 * `--append-system-prompt` can read real file contents. Inline prompts (set
 * via `"prompt": "<prose>"` in agents-team.json) and the generic-worker
 * sentinel (used when a user-named role has no packaged contract) both need
 * this indirection: the sentinel is a synthetic path that is never a real file,
 * and `loadWorkerPrompt` does the `{NAME}`/`{DESCRIPTION}` substitution and
 * inline-text trimming. Without this materialization step, Pi would try to
 * read the sentinel path and crash, OR read the unrendered template with the
 * placeholders intact — both observed in review. Temp directories are left
 * for OS cleanup to reap; they are single-file prompts under a dedicated
 * prefix in `os.tmpdir()`.
 */
function materializeInlinePrompt(profileName: string, body: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-agents-team-prompt-${profileName}-`));
	const path = join(dir, "prompt.md");
	writeFileSync(path, body, { mode: 0o600 });
	return path;
}

function resolveSystemPromptPath(request: LaunchPolicyRequest, config: TeamConfig): string {
	if (request.systemPromptPath) {
		const resolvedPromptPath = resolve(request.cwd, request.systemPromptPath);
		const projectRoot = config.safety.projectRoot;
		if (projectRoot && !isPathWithinProjectRoot(resolvedPromptPath, projectRoot, request.cwd)) {
			throw new Error("Worker prompt paths must stay within the discovered project root.");
		}
		return resolvedPromptPath;
	}
	if (request.profile.promptInline || request.profile.promptPath === GENERIC_WORKER_PROMPT_SENTINEL) {
		const rendered = loadWorkerPrompt(request.profile.name, config);
		return materializeInlinePrompt(request.profile.name, rendered);
	}
	return getWorkerPromptPath(request.profile.name, config);
}

function resolvePathScope(
	request: LaunchPolicyRequest,
	config: TeamConfig,
	tools: string[],
): TeamPathScope | undefined {
	const requestedScope = request.pathScope ?? request.profile.pathScope;
	const normalizedRequestedScope = normalizePathScope(requestedScope, request.cwd);
	if (request.pathScope && !isPathScopeNarrowerOrEqual(request.pathScope, request.profile.pathScope, request.cwd)) {
		throw new Error("Launch-time path scope cannot broaden the role's configured scope.");
	}

	const projectRoot = config.safety.projectRoot;
	if (!config.safety.allowWorkerPathsOutsideProject && projectRoot && !isPathScopeWithinProjectRoot(normalizedRequestedScope, projectRoot, request.cwd)) {
		throw new Error("Launch-time path scope roots must stay within the discovered project root.");
	}

	if (request.profile.writePolicy === "scoped-write" || hasWriteTools(tools)) {
		return ensureWriteScope(normalizedRequestedScope, request.cwd);
	}

	if (normalizedRequestedScope?.allowWrite) {
		throw new Error("Read-only roles cannot gain writable path scope at launch time.");
	}
	return normalizedRequestedScope;
}

export function applyLaunchPolicy(
	request: LaunchPolicyRequest,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): LaunchPolicyResult {
	const extensionMode = request.extensionMode ?? request.profile.extensionMode ?? config.safety.defaultWorkerExtensionMode;
	if (config.safety.preventRecursiveOrchestrator && extensionMode === "inherit") {
		throw new Error("Recursive orchestrator launches are blocked. Use worker-minimal or disable extensions for workers.");
	}
	if (!isExtensionModeNarrowerOrEqual(extensionMode, request.profile.extensionMode)) {
		throw new Error("Launch-time extension mode cannot broaden the role's configured extension mode.");
	}
	rejectRecursiveOrchestratorExtensions(request.profile.extensions, request.cwd);
	if (extensionMode === "disable" && request.profile.extensions && request.profile.extensions.length > 0) {
		throw new Error("Worker extension sources cannot be configured when extensionMode is disable.");
	}

	const tools = request.tools ?? request.profile.tools;
	if (tools.some((tool) => !tool || tool.startsWith("+") || tool.startsWith("-") || /[*,\s]/.test(tool))) {
		throw new Error("Worker tools must use exact names; Pi tool patterns and +name/-name selectors can broaden the role's configured tool set.");
	}
	if (tools.some((tool) => !request.profile.tools.includes(tool))) {
		throw new Error("Launch-time tool overrides must stay within the role's configured tool set.");
	}
	if (request.profile.writePolicy === "read-only" && hasWriteTools(tools)) {
		throw new Error("Read-only roles cannot gain edit/write tools at launch time.");
	}

	const pathScope = resolvePathScope(request, config, tools);

	// Nested delegation: a role opts in with `canSpawnWorkers: true`. The launch
	// policy — never the role config — decides what that grants, so a role cannot
	// hand itself the orchestrator extension or its collaboration tools.
	const workerDepth = request.workerDepth ?? 1;
	const maxWorkerDepth = config.safety.maxWorkerDepth;
	const nestedDelegation = request.profile.canSpawnWorkers === true;
	const resolvedTools = [...tools];
	const resolvedExtensions = request.profile.extensions ? [...request.profile.extensions] : [];
	if (nestedDelegation) {
		if (workerDepth > maxWorkerDepth) {
			throw new Error(
				`Nested delegation depth ${workerDepth} exceeds the configured limit ${maxWorkerDepth}. Raise workerAccess.maxWorkerDepth in agents-team.json (0-8) to allow deeper nesting.`,
			);
		}
		if (extensionMode === "disable") {
			throw new Error(
				`Role "${request.profile.name}" sets canSpawnWorkers but extensionMode is disable, so the collaboration tools could never load. Use worker-minimal.`,
			);
		}
		if (!request.selfEntryPath) {
			throw new Error(
				`Role "${request.profile.name}" sets canSpawnWorkers but no extension entry path was provided; nested delegation cannot be wired.`,
			);
		}
		// Deeper levels may exist, so every nested worker carries the tools too.
		for (const tool of NESTED_DELEGATION_TOOLS) {
			if (!resolvedTools.includes(tool)) resolvedTools.push(tool);
		}
		const selfEntry = request.selfEntryPath;
		if (!resolvedExtensions.some((source) => resolve(request.cwd, source) === resolve(selfEntry))) {
			resolvedExtensions.unshift(selfEntry);
		}
	}

	return {
		cwd: resolve(request.cwd),
		profile: request.profile,
		pathScope,
		model: request.model ?? request.profile.model ?? request.orchestratorModel,
		thinkingLevel: request.thinkingLevel ?? request.profile.thinkingLevel ?? request.orchestratorThinkingLevel ?? "medium",
		tools: resolvedTools,
		workerExtensions: resolvedExtensions.length > 0 ? resolvedExtensions : undefined,
		extensionMode,
		systemPromptPath: resolveSystemPromptPath(request, config),
		nestedDelegation,
		workerDepth,
		maxWorkerDepth,
	};
}
