/**
 * Pure per-platform "open image in the system viewer" command builders.
 *
 * Nothing is spawned here: the extension runs the returned argv through an
 * injected runner with a bounded timeout, so tests only assert argv shapes.
 */

export type OpenPlatform = "macos" | "windows" | "wsl" | "linux";

export interface OpenCommand {
	cmd: string;
	args: string[];
}

/** Resolves the effective open platform for this process. */
export function resolveOpenPlatform(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): OpenPlatform {
	if (platform === "darwin") return "macos";
	if (platform === "win32") return "windows";
	if (env.WSL_DISTRO_NAME !== undefined && env.WSL_DISTRO_NAME !== "") return "wsl";
	if (env.WSL_INTEROP !== undefined && env.WSL_INTEROP !== "") return "wsl";
	return "linux";
}

/** Argv for `wslpath -w <path>`: converts a WSL path to its Windows form. */
export function buildWslPathArgv(path: string): OpenCommand {
	return { cmd: "wslpath", args: ["-w", path] };
}

/**
 * Builds the viewer argv for `platform`.
 *
 * - macOS: `open <path>`
 * - Windows: `cmd /c start "" <path>` (default image viewer)
 * - WSL: `cmd.exe /c start "" <windowsPath>` — pass the result of running
 *   `buildWslPathArgv(path)` through `wslpath -w` first.
 * - Linux: `xdg-open <path>`
 *
 * Returns null when the platform needs a converted path and none was given.
 */
export function buildOpenArgv(
	platform: OpenPlatform,
	path: string,
	windowsPath?: string,
): OpenCommand | null {
	switch (platform) {
		case "macos":
			return { cmd: "open", args: [path] };
		case "windows":
			return { cmd: "cmd", args: ["/c", "start", "", path] };
		case "wsl":
			if (windowsPath === undefined || windowsPath === "") return null;
			return { cmd: "cmd.exe", args: ["/c", "start", "", windowsPath] };
		case "linux":
			return { cmd: "xdg-open", args: [path] };
	}
}
