/**
 * Per-platform "reveal in file manager / open in system viewer" logic.
 *
 * `detectPlatform` and `revealPlan` are pure and take the platform as input,
 * so every published case (WSL/Windows/macOS/Linux) is testable without the
 * real process. `reveal` is a thin bounded runner that reports failures
 * through its result instead of throwing.
 */

import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";

export type Platform = "darwin" | "win32" | "linux" | "wsl";

export interface PlatformInput {
	platform: string;
	env: Record<string, string | undefined>;
}

/**
 * Classify the runtime platform. Linux with WSL markers (WSL_DISTRO_NAME or
 * WSL_INTEROP) counts as WSL, mirroring pi's own Windows-keybinding heuristic.
 * Anything else unix-like falls back to "linux".
 */
export function detectPlatform(input: PlatformInput): Platform {
	if (input.platform === "win32") return "win32";
	if (input.platform === "darwin") return "darwin";
	if (input.platform === "linux" && Boolean(input.env.WSL_DISTRO_NAME || input.env.WSL_INTEROP)) {
		return "wsl";
	}
	return "linux";
}

export interface OpenPlan {
	command: string;
	args: string[];
}

export interface RevealInput {
	path: string;
	isDirectory: boolean;
	/** Windows path (from `wslpath -w`); required under WSL. */
	windowsPath?: string;
}

/**
 * Build the command/argv to reveal a file (selected in the file manager) or
 * open a directory. Returns null when the plan is impossible, e.g. WSL
 * without a converted Windows path.
 *
 * Linux fallback (documented): xdg-open cannot select a file, so the
 * containing directory is opened instead.
 */
export function revealPlan(platform: Platform, input: RevealInput): OpenPlan | null {
	switch (platform) {
		case "darwin":
			return input.isDirectory
				? { command: "open", args: [input.path] }
				: { command: "open", args: ["-R", input.path] };
		case "win32":
			return input.isDirectory
				? { command: "explorer", args: [input.path] }
				: { command: "explorer", args: [`/select,${input.path}`] };
		case "wsl": {
			if (!input.windowsPath) return null;
			return input.isDirectory
				? { command: "explorer.exe", args: [input.windowsPath] }
				: { command: "explorer.exe", args: [`/select,${input.windowsPath}`] };
		}
		case "linux":
			return { command: "xdg-open", args: [input.isDirectory ? input.path : dirname(input.path)] };
	}
}

/** Minimal spawn surface used by reveal; injectable for tests. */
export type SpawnFunction = (command: string, args: string[]) => Spawned;

export interface Spawned {
	on(event: "close", listener: (code: number | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	kill(signal?: number | string): boolean;
}

export interface RevealDeps {
	spawn: SpawnFunction;
}

export interface RevealOptions {
	/** Milliseconds before the process is killed. Required to stay bounded. */
	timeoutMs: number;
}

export interface RevealResult {
	ok: boolean;
	error?: string;
}

/**
 * Spawn the reveal command with a bounded timeout. Never throws: every
 * failure (spawn error, non-zero exit, timeout) becomes a result.
 */
export async function reveal(plan: OpenPlan, deps: RevealDeps, options: RevealOptions): Promise<RevealResult> {
	let child: ChildProcess | Spawned;
	try {
		child = deps.spawn(plan.command, plan.args);
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}

	return new Promise<RevealResult>((settle) => {
		let settled = false;
		const finish = (result: RevealResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			settle(result);
		};

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// The process may already be gone; the timeout result stands.
			}
			finish({ ok: false, error: `timed out after ${options.timeoutMs}ms` });
		}, options.timeoutMs);

		child.on("close", (code) => {
			if (code === 0) {
				finish({ ok: true });
			} else {
				finish({ ok: false, error: `exit code ${code ?? "signal"}` });
			}
		});
		child.on("error", (error) => {
			finish({ ok: false, error: describeError(error) });
		});
	});
}

/** Minimal exec surface for the WSL path conversion; injectable for tests. */
export interface WslExecDeps {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Convert a WSL path to its Windows form with `wslpath -w`. Returns null on
 * failure so callers can fall back to an unconverted reveal attempt.
 */
export async function windowsPathViaWsl(path: string, deps: WslExecDeps): Promise<string | null> {
	try {
		const result = await deps.exec("wslpath", ["-w", path]);
		const out = result.stdout.trim();
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
