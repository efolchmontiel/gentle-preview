/**
 * Preview model builder for quick-peek.
 *
 * All filesystem access goes through the injectable PreviewDeps, so the model
 * logic is fully deterministic and testable without a real filesystem.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

/** Files above this size are never read as text. */
export const MAX_TEXT_BYTES = 1_000_000;

/** Default number of lines shown in a text window. */
export const DEFAULT_WINDOW = 20;

/** Cap for the header probe of image files. */
const IMAGE_HEADER_BYTES = 64;

export type PreviewKind = "code" | "text" | "image" | "directory" | "binary" | "other";

export const KIND_LABELS: Record<PreviewKind, string> = {
	code: "code",
	text: "text",
	image: "image",
	directory: "directory",
	binary: "binary",
	other: "other",
};

export interface SourceLine {
	/** 1-based file line number. */
	number: number;
	text: string;
	marked: boolean;
}

export interface TextWindow {
	language: string;
	totalLines: number;
	/** 1-based line number of the first line in the window. */
	start: number;
	lines: SourceLine[];
}

export interface ImageInfo {
	mimeType: string;
	width?: number;
	height?: number;
}

export interface DirectoryInfo {
	entries: string[];
	total: number;
}

export interface PreviewModel {
	path: string;
	name: string;
	kind: PreviewKind;
	kindLabel: string;
	/** File metadata, null when the path does not exist. */
	meta: { size: number; modifiedMs: number } | null;
	sizeLabel: string;
	ageLabel: string;
	text?: TextWindow;
	image?: ImageInfo;
	directory?: DirectoryInfo;
	/** Human-readable note, e.g. why text was not shown. */
	note?: string;
}

export interface PreviewOptions {
	/** Target line to mark, 1-based. */
	line?: number;
	/** Target column, 1-based. Reported but only affects the marked line. */
	column?: number;
	/** Lines to show. Defaults to DEFAULT_WINDOW. */
	window?: number;
	/** Explicit 1-based window start, overriding the auto-centered position. */
	startLine?: number;
	/** Reference instant for the age label. Defaults to Date.now(). */
	now?: number;
}

/** Filesystem probes; inject for tests. */
export interface PreviewDeps {
	stat(path: string): { size: number; modifiedMs: number } | null;
	isDirectory(path: string): boolean;
	readText(path: string): string;
	readBytes(path: string, maxBytes: number): Uint8Array;
	listDirectory(path: string, limit: number): { entries: string[]; total: number };
}

export function defaultPreviewDeps(): PreviewDeps {
	return {
		stat(path) {
			try {
				const s = statSync(path);
				return { size: s.size, modifiedMs: s.mtimeMs };
			} catch {
				return null;
			}
		},
		isDirectory(path) {
			try {
				return statSync(path).isDirectory();
			} catch {
				return false;
			}
		},
		readText(path) {
			return readFileSync(path, "utf8");
		},
		readBytes(path, maxBytes) {
			const fd = readFileSync(path);
			return fd.length > maxBytes ? fd.subarray(0, maxBytes) : fd;
		},
		listDirectory(path, limit) {
			try {
				const all = readdirSync(path).sort((a, b) => a.localeCompare(b));
				return { entries: all.slice(0, limit), total: all.length };
			} catch {
				return { entries: [], total: 0 };
			}
		},
	};
}

const CODE_EXTENSIONS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte",
	".py", ".rb", ".rs", ".go", ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cpp",
	".hpp", ".cc", ".cs", ".php", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".pl",
	".lua", ".sql", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".yml",
	".yaml", ".toml", ".xml", ".graphql", ".proto", ".dart", ".ex", ".exs", ".zig",
	".hs", ".erl", ".clj", ".scala", ".m", ".mm", ".r", ".jl",
]);

const TEXT_EXTENSIONS = new Set([
	".md", ".mdx", ".txt", ".text", ".log", ".json", ".jsonc", ".json5", ".csv",
	".tsv", ".ini", ".cfg", ".conf", ".env", ".properties", ".gitignore",
	".dockerignore", ".editorconfig", ".lock", ".diff", ".patch", ".license",
]);

const IMAGE_EXTENSIONS = new Map<string, string>([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".bmp", "image/bmp"],
	[".svg", "image/svg+xml"],
]);

function imageMimeForPath(path: string): string | null {
	return IMAGE_EXTENSIONS.get(extname(path).toLowerCase()) ?? null;
}

const LANGUAGES = new Map<string, string>([
	[".ts", "TypeScript"], [".tsx", "TypeScript"], [".mts", "TypeScript"], [".cts", "TypeScript"],
	[".js", "JavaScript"], [".jsx", "JavaScript"], [".mjs", "JavaScript"], [".cjs", "JavaScript"],
	[".py", "Python"], [".rb", "Ruby"], [".rs", "Rust"], [".go", "Go"], [".java", "Java"],
	[".kt", "Kotlin"], [".kts", "Kotlin"], [".swift", "Swift"], [".c", "C"], [".h", "C"],
	[".cpp", "C++"], [".hpp", "C++"], [".cc", "C++"], [".cs", "C#"], [".php", "PHP"],
	[".sh", "Shell"], [".bash", "Shell"], [".zsh", "Shell"], [".fish", "Shell"], [".ps1", "PowerShell"],
	[".lua", "Lua"], [".sql", "SQL"], [".html", "HTML"], [".htm", "HTML"], [".css", "CSS"],
	[".scss", "SCSS"], [".sass", "Sass"], [".less", "Less"], [".yml", "YAML"], [".yaml", "YAML"],
	[".toml", "TOML"], [".xml", "XML"], [".json", "JSON"], [".jsonc", "JSON"], [".json5", "JSON"],
	[".md", "Markdown"], [".mdx", "Markdown"], [".txt", "Text"], [".log", "Text"], [".csv", "CSV"],
	[".dart", "Dart"], [".ex", "Elixir"], [".exs", "Elixir"], [".zig", "Zig"], [".scala", "Scala"],
	[".graphql", "GraphQL"], [".proto", "Protocol Buffers"], [".vue", "Vue"], [".svelte", "Svelte"],
]);

/** Guessed display language for a path, or "Text". */
export function languageForPath(path: string): string {
	return LANGUAGES.get(extname(path).toLowerCase()) ?? "Text";
}

/** Mime type from the file extension: image mimes, text/plain for known text/code, else null. */
export function mimeTypeForPath(path: string): string | null {
	const image = imageMimeForPath(path);
	if (image) return image;
	const ext = extname(path).toLowerCase();
	if (CODE_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext)) return "text/plain";
	return null;
}

/** 1234 -> "1.2 KB". Deterministic; single decimal for KB and above. */
export function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = -1;
	do {
		value /= 1024;
		unit += 1;
	} while (value >= 1024 && unit < units.length - 1);
	return `${(Math.floor(value * 10) / 10).toFixed(1)} ${units[unit]}`;
}

/** Deterministic age label from a reference instant. */
export function humanAge(modifiedMs: number, now: number): string {
	const diff = Math.max(0, now - modifiedMs);
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}

export interface ImageDimensions {
	width: number;
	height: number;
}

/**
 * Read pixel dimensions from an image file header, cheaply and without
 * dependencies. Supports PNG, GIF, WebP (VP8/VP8L/VP8X) and JPEG (SOF scan).
 * Returns null when the bytes are not a recognizable header.
 */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | null {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// PNG: 8-byte signature, then IHDR chunk: length(4) "IHDR"(4) width(4) height(4).
	if (
		bytes.length >= 24 &&
		bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
		bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
	) {
		const width = dv.getUint32(16, false);
		const height = dv.getUint32(20, false);
		if (width > 0 && height > 0) return { width, height };
		return null;
	}

	// GIF: "GIF87a"/"GIF89a" then little-endian u16 width, height.
	if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		const width = dv.getUint16(6, true);
		const height = dv.getUint16(8, true);
		if (width > 0 && height > 0) return { width, height };
		return null;
	}

	// WebP: "RIFF"...."WEBP" then the chunk.
	if (
		bytes.length >= 30 &&
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
	) {
		const fourcc = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
		if (fourcc === "VP8 ") {
			// Lossy VP8 bitstream: dims at offset 26/28 as masked LE u16.
			if (bytes.length >= 30) {
				const width = dv.getUint16(26, true) & 0x3fff;
				const height = dv.getUint16(28, true) & 0x3fff;
				if (width > 0 && height > 0) return { width, height };
			}
			return null;
		}
		if (fourcc === "VP8L") {
			// Lossless: 14-bit packed dims starting at byte 21.
			if (bytes.length >= 25) {
				const bits = dv.getUint32(21, true);
				const width = (bits & 0x3fff) + 1;
				const height = ((bits >> 14) & 0x3fff) + 1;
				return { width, height };
			}
			return null;
		}
		if (fourcc === "VP8X") {
			// Extended: 24-bit LE width-1 at 24, height-1 at 27.
			if (bytes.length >= 30) {
				const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
				const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
				return { width, height };
			}
			return null;
		}
		return null;
	}

	// JPEG: scan segment markers for the first SOFn.
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 <= bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset += 1;
				continue;
			}
			const marker = bytes[offset + 1]!;
			// Standalone markers without a length payload.
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				offset += 2;
				continue;
			}
			if (marker === 0xda) break; // Start of scan; no SOF found.
			const sofn = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (sofn) {
				const height = dv.getUint16(offset + 5, false);
				const width = dv.getUint16(offset + 7, false);
				if (width > 0 && height > 0) return { width, height };
				return null;
			}
			const length = dv.getUint16(offset + 2, false);
			if (length < 2) break;
			offset += 2 + length;
		}
		return null;
	}

	return null;
}

/**
 * Build the preview model for one path. Never throws: read failures become a
 * note on the model. Text is refused for files over 1 MB and for content that
 * contains a NUL byte (binary).
 */
export function buildPreview(path: string, options: PreviewOptions, deps: PreviewDeps): PreviewModel {
	const now = options.now ?? Date.now();
	const window = options.window ?? DEFAULT_WINDOW;
	const meta = deps.stat(path);
	const kind = kindForPath(path, deps);

	const model: PreviewModel = {
		path,
		name: basename(path) || path,
		kind,
		kindLabel: KIND_LABELS[kind],
		meta,
		sizeLabel: meta ? humanSize(meta.size) : "unknown size",
		ageLabel: meta ? humanAge(meta.modifiedMs, now) : "unknown age",
	};

	if (kind === "directory") {
		const listed = deps.listDirectory(path, 20);
		model.directory = listed;
		return model;
	}

	if (kind === "image") {
		const mimeType = imageMimeForPath(path) ?? "application/octet-stream";
		try {
			const header = deps.readBytes(path, IMAGE_HEADER_BYTES);
			const dims = imageDimensions(header);
			model.image = dims ? { mimeType, ...dims } : { mimeType };
		} catch (error) {
			model.image = { mimeType };
			model.note = describeError(error);
		}
		return model;
	}

	if (kind === "binary") {
		model.note = "binary content";
		return model;
	}

	if (!meta) {
		model.note = "file not found";
		return model;
	}

	if (meta.size > MAX_TEXT_BYTES) {
		model.note = `file exceeds ${humanSize(MAX_TEXT_BYTES)}; showing metadata only`;
		return model;
	}

	let content: string;
	try {
		content = deps.readText(path);
	} catch (error) {
		model.note = describeError(error);
		return model;
	}

	if (content.includes("\u0000")) {
		model.kind = "binary";
		model.kindLabel = KIND_LABELS.binary;
		model.note = "binary content";
		return model;
	}

	model.text = textWindow(content, options.line, options.startLine, window);
	model.text.language = languageForPath(path);
	return model;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function kindForPath(path: string, deps: PreviewDeps): PreviewKind {
	if (deps.isDirectory(path)) return "directory";
	const mime = imageMimeForPath(path);
	if (mime) return "image";
	const ext = extname(path).toLowerCase();
	if (CODE_EXTENSIONS.has(ext)) return "code";
	if (TEXT_EXTENSIONS.has(ext)) return "text";
	// Unknown extension: assume text; the NUL-byte probe corrects to binary.
	return "text";
}

/**
 * Slice a text window. With no target line: the first `window` lines.
 * With a target line: a window around it (centered, clamped to the file),
 * with that line marked. `startLine` overrides the window start explicitly
 * (used for keyboard scrolling).
 */
export function textWindow(content: string, line?: number, startLine?: number, window = DEFAULT_WINDOW): TextWindow {
	const allLines = content.split("\n");
	if (allLines.length > 0 && allLines.at(-1) === "") allLines.pop();
	const totalLines = allLines.length;

	const size = Math.max(1, window);
	let start: number;
	if (startLine !== undefined) {
		// Explicit scroll position: clamp only to the file bounds.
		start = Math.min(Math.max(1, startLine), Math.max(1, totalLines));
	} else if (line === undefined || line <= size) {
		start = 1;
	} else {
		start = Math.min(line - Math.floor(size / 2), Math.max(1, totalLines - size + 1));
	}

	const lines: SourceLine[] = [];
	for (let number = start; number < start + size && number <= totalLines; number += 1) {
		lines.push({ number, text: allLines[number - 1] ?? "", marked: line !== undefined && number === line });
	}
	return {
		language: "Text",
		totalLines,
		start,
		lines,
	};
}
