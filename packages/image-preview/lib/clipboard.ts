/**
 * Per-platform clipboard reading: images, copied file paths and text.
 *
 * All access goes through an injected command runner so tests can fake the
 * clipboard without spawning anything, and through an injected platform so
 * every branch is exercisable from any host OS. The fallback mirrors what Pi's
 * own `handleClipboardPaste` covered, because taking its `ctrl+v` shortcut
 * means the built-in paste never runs: image → copied file paths → text, and
 * nothing readable means nothing is pasted.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { extensionForMime, sniffImage } from "./images.ts";

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

/** What a clipboard held, in Pi's own paste order. */
export type ClipboardContent =
	| { kind: "image"; image: ClipboardImage }
	| { kind: "files"; paths: string[] }
	| { kind: "text"; text: string };

const LIST_TIMEOUT_MS = 2000;
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

const POWERSHELL_FILE_LIST_SCRIPT = "Get-Clipboard -Format FileDropList";
const POWERSHELL_TEXT_SCRIPT = "Get-Clipboard -Raw";

/**
 * Reads the clipboard for the given platform, in Pi's own paste order:
 * image first (so screenshots become `[Image #N]`), then copied file paths,
 * then plain text. Returns null when nothing readable is there — the caller
 * must never paste a partial or empty result.
 *
 * - Linux/Wayland: `wl-paste --list-types`, then read by type.
 * - Linux/X11: `xclip -t TARGETS`, then read by type.
 * - macOS: `pngpaste -` for images, `pbpaste` for text. Copied file paths are
 *   NOT covered: they would need the native pasteboard, and no bounded
 *   one-shot command returns them reliably.
 * - Windows / WSL: PowerShell — `Get-Clipboard -Format FileDropList` for
 *   copied files, `Clipboard::GetImage` for images, `Get-Clipboard -Raw` for
 *   text. Under WSL only what `powershell.exe` interop reaches is available,
 *   and emitted Windows paths are converted with `wslpath -u`.
 */
export function readClipboard(run: CommandRunner, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ClipboardContent | null {
	if (platform === "darwin") return readDarwin(run);
	if (platform === "win32" || isWsl(platform, env)) return readWindows(run, platform, env);
	return readLinux(run, env);
}

// --- Shared helpers -----------------------------------------------------------

function runFor(run: CommandRunner, cmd: string, args: string[], timeoutMs: number): Buffer | null {
	const result = run(cmd, args, { timeoutMs, maxBuffer: MAX_BUFFER });
	if (result === null || result.status !== 0) return null;
	return result.stdout;
}

/** Sniffs raw clipboard bytes into a validated image. */
function toImage(bytes: Buffer): ClipboardImage | null {
	const sniffed = sniffImage(bytes);
	if (sniffed === null) return null;
	return { bytes, mimeType: sniffed.mimeType };
}

function lines(buf: Buffer): string[] {
	return buf
		.toString("utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

const CONTROL_CHAR = /\p{Cc}/u;

/**
 * Parses a `text/uri-list` or `x-special/gnome-copied-files` payload into
 * local paths: `file://` URIs are decoded, the `copy`/`cut` marker and
 * comment lines are dropped, and non-file URIs are skipped. A payload with
 * control characters is refused entirely rather than pasted partially.
 */
export function parseCopiedFilePaths(text: string): string[] {
	const paths: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line === "copy" || line === "cut" || line.startsWith("#")) continue;
		if (/^file:\/\//i.test(line)) {
			try {
				const url = new URL(line);
				if (url.hostname !== "" && url.hostname !== "localhost") continue;
				paths.push(decodeURIComponent(url.pathname));
			} catch {
				// Malformed URI: not a usable path.
			}
		} else if (!line.includes("://")) {
			paths.push(line);
		}
	}
	return paths.some((path) => CONTROL_CHAR.test(path)) ? [] : paths;
}

/** Quotes a path for a shell command line, the way Pi quotes resume paths. */
export function quoteForShell(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

// --- Linux (Wayland and X11) ---------------------------------------------------

interface TypeBackend {
	listTypes: () => Buffer | null;
	readType: (type: string) => Buffer | null;
}

const IMAGE_TYPE_ORDER = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Advertised image types, preferred formats first. */
function imageTypeCandidates(types: string[]): string[] {
	const preferred: string[] = [];
	for (const wanted of IMAGE_TYPE_ORDER) {
		const match = types.find((type) => type.toLowerCase() === wanted);
		if (match !== undefined) preferred.push(match);
	}
	const rest = types.filter((type) => type.toLowerCase().startsWith("image/") && !preferred.includes(type));
	return [...preferred, ...rest];
}

/** Advertised copied-file types: the GNOME list first, then the URI list. */
function fileTypeCandidates(types: string[]): string[] {
	const candidates: string[] = [];
	const gnome = types.find((type) => type.toLowerCase() === "x-special/gnome-copied-files");
	if (gnome !== undefined) candidates.push(gnome);
	const uriList = types.find((type) => type.toLowerCase() === "text/uri-list");
	if (uriList !== undefined) candidates.push(uriList);
	return candidates;
}

/** Advertised text types, `text/plain` first; the URI list is not text. */
function textTypeCandidates(types: string[]): string[] {
	const plain = types.find((type) => (type.split(";")[0] ?? "").trim().toLowerCase() === "text/plain");
	const rest = types.filter(
		(type) =>
			type !== plain && /^text\//i.test(type) && !["text/uri-list", "text/x-uri-list"].includes(type.toLowerCase()),
	);
	return plain === undefined ? rest : [plain, ...rest];
}

/**
 * One backend's pipeline over its advertised types: a valid image first, then
 * copied file paths, then text. Null when none of the advertised types yields
 * anything readable.
 */
function contentFromTypeList(backend: TypeBackend): ClipboardContent | null {
	const listBuffer = backend.listTypes();
	if (listBuffer === null) return null;
	const types = lines(listBuffer);
	for (const type of imageTypeCandidates(types)) {
		const buffer = backend.readType(type);
		if (buffer === null || buffer.length === 0) continue;
		const image = toImage(buffer);
		if (image !== null) return { kind: "image", image };
	}
	for (const type of fileTypeCandidates(types)) {
		const buffer = backend.readType(type);
		if (buffer === null) continue;
		const paths = parseCopiedFilePaths(buffer.toString("utf8"));
		if (paths.length > 0) return { kind: "files", paths };
	}
	for (const type of textTypeCandidates(types)) {
		const buffer = backend.readType(type);
		if (buffer === null) continue;
		const text = buffer.toString("utf8");
		if (text !== "") return { kind: "text", text };
	}
	return null;
}

function readLinux(run: CommandRunner, env: NodeJS.ProcessEnv): ClipboardContent | null {
	const wayland = [env.WAYLAND_DISPLAY, env.WL_DISPLAY].some((value) => (value ?? "").trim() !== "");
	const x11 = (env.DISPLAY ?? "").trim() !== "";
	if (wayland) {
		const content = contentFromTypeList({
			listTypes: () => runFor(run, "wl-paste", ["--list-types"], LIST_TIMEOUT_MS),
			readType: (type) => runFor(run, "wl-paste", ["--type", type, "--no-newline"], READ_TIMEOUT_MS),
		});
		if (content !== null) return content;
	}
	if (x11) {
		return contentFromTypeList({
			listTypes: () => runFor(run, "xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], LIST_TIMEOUT_MS),
			readType: (type) => runFor(run, "xclip", ["-selection", "clipboard", "-t", type, "-o"], READ_TIMEOUT_MS),
		});
	}
	return null;
}

// --- macOS ---------------------------------------------------------------------

/**
 * macOS backend. Copied file paths are deliberately not covered: Finder puts
 * them on the native pasteboard, and no bounded one-shot command returns them
 * reliably (see the README coverage table).
 */
function readDarwin(run: CommandRunner): ClipboardContent | null {
	const pngpaste = runFor(run, "pngpaste", ["-"], READ_TIMEOUT_MS);
	if (pngpaste !== null && pngpaste.length > 0) {
		const image = toImage(pngpaste);
		if (image !== null) return { kind: "image", image };
	}
	const pbpaste = runFor(run, "pbpaste", [], READ_TIMEOUT_MS);
	if (pbpaste === null) return null;
	const text = pbpaste.toString("utf8");
	return text === "" ? null : { kind: "text", text };
}

// --- Windows and WSL -------------------------------------------------------------

/** Converts a Windows path to its WSL `/mnt/...` equivalent via `wslpath -u`. */
function toWslPath(run: CommandRunner, winPath: string): string | null {
	const result = run("wslpath", ["-u", winPath], { timeoutMs: PATH_TIMEOUT_MS, maxBuffer: 64 * 1024 });
	if (result === null || result.status !== 0) return null;
	const path = result.stdout.toString("utf8").trim();
	return path === "" ? null : path;
}

/** Windows / WSL image backend: PowerShell saves the clipboard image to a temp file. */
function readImageFromWindowsClipboard(
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

function runPowershell(run: CommandRunner, script: string): Buffer | null {
	return runFor(
		run,
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", script],
		READ_TIMEOUT_MS,
	);
}

/**
 * Windows / WSL backend, in Pi's own order: copied files (FileDropList), then
 * an image, then text. Under WSL every emitted Windows path goes through
 * `wslpath -u`; if a conversion fails the raw Windows path is kept rather
 * than swallowing the paste.
 */
function readWindows(run: CommandRunner, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ClipboardContent | null {
	const wsl = isWsl(platform, env);
	const fileList = runPowershell(run, POWERSHELL_FILE_LIST_SCRIPT);
	if (fileList !== null) {
		const paths = parseCopiedFilePaths(fileList.toString("utf8"));
		if (paths.length > 0) {
			return { kind: "files", paths: wsl ? paths.map((path) => toWslPath(run, path) ?? path) : paths };
		}
	}
	const image = readImageFromWindowsClipboard(run, platform, env);
	if (image !== null) return { kind: "image", image };
	const textBuffer = runPowershell(run, POWERSHELL_TEXT_SCRIPT);
	if (textBuffer !== null) {
		// PowerShell terminates stdout with one newline of its own.
		const text = textBuffer.toString("utf8").replace(/\r?\n$/, "");
		if (text !== "") return { kind: "text", text };
	}
	return null;
}
