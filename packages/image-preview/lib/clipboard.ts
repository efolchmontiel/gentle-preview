/**
 * Per-platform clipboard image reading.
 *
 * All access goes through an injected command runner so tests can fake the
 * clipboard without spawning anything. Every backend fails soft: when a
 * backend cannot read an image the caller gets `null` and does nothing, so the
 * user keeps Pi's own paste behaviour.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { sniffImage } from "./images.ts";

export interface CommandResult {
	/** Exit status; null when the command could not be spawned. */
	status: number | null;
	stdout: Buffer;
}

export interface CommandRunOptions {
	timeoutMs: number;
	maxBuffer: number;
}

/** Runs a command and returns its result, or null on spawn error / non-zero exit. */
export type CommandRunner = (cmd: string, args: string[], options: CommandRunOptions) => CommandResult | null;

export interface ClipboardImage {
	bytes: Uint8Array;
	mimeType: string;
}

const READ_TIMEOUT_MS = 5000;
const PATH_TIMEOUT_MS = 2000;
const MAX_BUFFER = 50 * 1024 * 1024;

/** True when running under WSL (Windows interop available on a Linux kernel). */
export function isWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
	if (platform !== "linux") return false;
	if (env.WSL_DISTRO_NAME !== undefined && env.WSL_DISTRO_NAME !== "") return true;
	if (env.WSL_INTEROP !== undefined && env.WSL_INTEROP !== "") return true;
	try {
		return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
	} catch {
		return false;
	}
}

const POWERSHELL_CLIPBOARD_SCRIPT = [
	"Add-Type -AssemblyName System.Windows.Forms;",
	"$img = [System.Windows.Forms.Clipboard]::GetImage();",
	"if ($img -eq $null) { exit 1 }",
	"$p = [System.IO.Path]::GetTempFileName();",
	"$img.Save($p, [System.Drawing.Imaging.ImageFormat]::Png);",
	"Write-Output $p",
].join(" ");

/**
 * Reads a clipboard image, trying the available backends for the platform:
 *
 * - macOS: `pngpaste -` (homebrew), PNG on stdout.
 * - Windows: PowerShell `Clipboard::GetImage` saved as PNG to a temp file.
 * - WSL: the same PowerShell script via `powershell.exe` interop, with the
 *   Windows temp path converted back through `wslpath -u`.
 * - Linux: `wl-paste` (Wayland) then `xclip` (X11) for png/jpeg payloads.
 *
 * Returns null when no backend yields a recognisably valid image.
 */
export function readClipboardImage(
	run: CommandRunner,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): ClipboardImage | null {
	const backends: Array<() => ClipboardImage | null> = [];
	if (platform === "darwin") {
		backends.push(() => readViaStdout(run, ["pngpaste", "-"]));
	} else if (platform === "win32" || isWsl(platform, env)) {
		backends.push(() => readViaWindowsClipboard(run, platform, env));
	} else if (platform === "linux") {
		if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== "") {
			backends.push(() => readViaStdout(run, ["wl-paste", "--type", "image/png", "--no-newline"]));
			backends.push(() => readViaStdout(run, ["wl-paste", "--type", "image/jpeg", "--no-newline"]));
		}
		if (env.DISPLAY !== undefined && env.DISPLAY !== "") {
			backends.push(() => readViaStdout(run, ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]));
			backends.push(() => readViaStdout(run, ["xclip", "-selection", "clipboard", "-t", "image/jpeg", "-o"]));
		}
	}
	for (const backend of backends) {
		const image = backend();
		if (image !== null) return image;
	}
	return null;
}

/** Sniffs raw clipboard bytes into a validated image. */
function toImage(bytes: Buffer): ClipboardImage | null {
	const sniffed = sniffImage(bytes);
	if (sniffed === null) return null;
	return { bytes, mimeType: sniffed.mimeType };
}

/** Backend for helpers that write the payload to stdout. */
function readViaStdout(run: CommandRunner, args: string[]): ClipboardImage | null {
	const cmd = args[0] ?? "";
	const result = run(cmd, args.slice(1), { timeoutMs: READ_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
	if (result === null || result.status !== 0 || result.stdout.length === 0) return null;
	return toImage(result.stdout);
}

/** Windows / WSL backend: PowerShell saves the clipboard image to a temp file. */
function readViaWindowsClipboard(
	run: CommandRunner,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): ClipboardImage | null {
	const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_CLIPBOARD_SCRIPT], {
		timeoutMs: READ_TIMEOUT_MS,
		maxBuffer: MAX_BUFFER,
	});
	if (result === null || result.status !== 0) return null;
	const winPath = result.stdout.toString("utf8").trim();
	if (winPath === "") return null;
	// Use the injected platform, not process.platform: the WSL conversion is a
	// property of the backend being driven (linux + interop), not of the host
	// running this module, and tests exercise this path from any OS.
	const localPath = isWsl(platform, env) ? toWslPath(run, winPath) : winPath;
	if (localPath === null) return null;
	let bytes: Buffer;
	try {
		bytes = readFileSync(localPath);
	} catch {
		return null;
	}
	try {
		unlinkSync(localPath);
	} catch {
		// Best-effort cleanup of our own temp file.
	}
	return toImage(bytes);
}

/** Converts a Windows path to its WSL `/mnt/...` equivalent via `wslpath -u`. */
function toWslPath(run: CommandRunner, winPath: string): string | null {
	const result = run("wslpath", ["-u", winPath], { timeoutMs: PATH_TIMEOUT_MS, maxBuffer: 64 * 1024 });
	if (result === null || result.status !== 0) return null;
	const path = result.stdout.toString("utf8").trim();
	return path === "" ? null : path;
}
