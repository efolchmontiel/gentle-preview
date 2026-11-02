/**
 * Image file helpers: detection by magic bytes and extension, MIME types,
 * header-based dimensions, and where a pasted image is written.
 *
 * All parsers are pure functions over byte buffers so they can be tested
 * without a terminal, a filesystem or a real image.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface SniffedImage {
	mimeType: string;
	width: number;
	height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Canonical file extension for a MIME type, without the dot. */
export function extensionForMime(mimeType: string): string | undefined {
	return EXTENSION_BY_MIME[mimeType.toLowerCase()];
}

/** MIME type for a path's extension, or undefined for unknown extensions. */
export function mimeFromPath(path: string): string | undefined {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return undefined;
	return MIME_BY_EXTENSION[path.slice(dot).toLowerCase()];
}

/** True when the path has a known image extension. */
export function isImageFilePath(path: string): boolean {
	return mimeFromPath(path) !== undefined;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

/** PNG: dimensions live in the IHDR chunk, big-endian. */
export function parsePngSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 24) return null;
	for (let i = 0; i < PNG_SIGNATURE.length; i++) {
		if (bytes[i] !== PNG_SIGNATURE[i]) return null;
	}
	const width = readUint32BE(bytes, 16);
	const height = readUint32BE(bytes, 20);
	if (width === 0 || height === 0) return null;
	return { width, height };
}

/** GIF: logical screen size, little-endian, right after the version header. */
export function parseGifSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 10) return null;
	const header = String.fromCharCode(...bytes.slice(0, 6));
	if (header !== "GIF87a" && header !== "GIF89a") return null;
	const width = readUint16LE(bytes, 6);
	const height = readUint16LE(bytes, 8);
	if (width === 0 || height === 0) return null;
	return { width, height };
}

/** JPEG: walks the marker segments until a start-of-frame marker. */
export function parseJpegSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let i = 2;
	while (i + 9 < bytes.length) {
		if (bytes[i] !== 0xff) {
			i += 1;
			continue;
		}
		const marker = bytes[i + 1];
		if (marker === undefined) return null;
		// Standalone markers carry no length segment.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			i += 2;
			continue;
		}
		const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isStartOfFrame) {
			const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
			const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
			if (width === 0 || height === 0) return null;
			return { width, height };
		}
		i += 2 + (((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0));
	}
	return null;
}

/**
 * WebP: parses the VP8X (extended), VP8 (lossy) and VP8L (lossless) chunks.
 */
export function parseWebpSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 30) return null;
	const riff = String.fromCharCode(...bytes.slice(0, 4));
	const webp = String.fromCharCode(...bytes.slice(8, 12));
	if (riff !== "RIFF" || webp !== "WEBP") return null;
	const chunk = String.fromCharCode(...bytes.slice(12, 16));
	if (chunk === "VP8X") {
		// 4 reserved bytes, then 24-bit canvas width-1 and height-1.
		const width = readUint24LE(bytes, 24) + 1;
		const height = readUint24LE(bytes, 27) + 1;
		if (width <= 0 || height <= 0) return null;
		return { width, height };
	}
	if (chunk === "VP8 ") {
		// 3-byte frame tag, sync code 0x9d 0x01 0x2a, then 14-bit LE sizes.
		if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
		const width = readUint16LE(bytes, 26) & 0x3fff;
		const height = readUint16LE(bytes, 28) & 0x3fff;
		if (width === 0 || height === 0) return null;
		return { width, height };
	}
	if (chunk === "VP8L") {
		// Signature byte 0x2f, then width-1 (14 bits) and height-1 (14 bits).
		if (bytes[20] !== 0x2f) return null;
		const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
		const width = (bits & 0x3fff) + 1;
		const height = ((bits >> 14) & 0x3fff) + 1;
		if (width <= 0 || height <= 0) return null;
		return { width, height };
	}
	return null;
}

/**
 * Detects a supported image from its magic bytes, returning MIME type and
 * pixel dimensions. Returns null for anything not recognisably an image.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
	const png = parsePngSize(bytes);
	if (png) return { mimeType: "image/png", ...png };
	const jpeg = parseJpegSize(bytes);
	if (jpeg) return { mimeType: "image/jpeg", ...jpeg };
	const gif = parseGifSize(bytes);
	if (gif) return { mimeType: "image/gif", ...gif };
	const webp = parseWebpSize(bytes);
	if (webp) return { mimeType: "image/webp", ...webp };
	return null;
}

/** Upper bound on how many paste files the temporary cache keeps. */
const MAX_CACHE_FILES = 200;
/** Hard cap for a single pasted image; larger payloads are refused. */
export const MAX_CACHE_FILE_BYTES = 64 * 1024 * 1024;
/** How many same-size candidates a duplicate search compares byte by byte. */
const DEDUPE_MAX_CANDIDATES = 50;
/** Extensions the duplicate search considers. */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;

export interface PasteDirContext {
	env?: Record<string, string | undefined>;
	home?: string;
	exists?: (path: string) => boolean;
	/** Overrides `os.tmpdir()` for the fallback, so tests never touch the shared cache. */
	tmpDir?: string;
}

export interface PasteDir {
	dir: string;
	/** True for the `os.tmpdir()` fallback, the only directory this module prunes. */
	temporary: boolean;
}

/**
 * Where a pasted image is written.
 *
 * A pasted image is something the user refers to again, so it does not belong in
 * the system temp dir while a real pictures folder is available. Order:
 * `GENTLE_IMAGE_PREVIEW_DIR`, the Omarchy screenshots folder,
 * `$XDG_PICTURES_DIR/screenshots`, an existing `~/Pictures/screenshots`, and
 * only then a bounded cache under `os.tmpdir()`.
 */
export function pasteDir(context: PasteDirContext = {}): PasteDir {
	const env = context.env ?? process.env;
	const home = context.home ?? homedir();
	const exists = context.exists ?? ((path: string) => existsSync(path));
	const configured = env.GENTLE_IMAGE_PREVIEW_DIR?.trim();
	if (configured) return { dir: configured, temporary: false };
	const omarchy = env.OMARCHY_SCREENSHOT_DIR?.trim();
	if (omarchy) return { dir: omarchy, temporary: false };
	const pictures = env.XDG_PICTURES_DIR?.trim();
	if (pictures) return { dir: join(pictures, "screenshots"), temporary: false };
	const conventional = join(home, "Pictures", "screenshots");
	if (exists(conventional)) return { dir: conventional, temporary: false };
	return { dir: join(context.tmpDir ?? tmpdir(), "gentle-preview-paste"), temporary: true };
}

/**
 * Returns a file in `dir` whose bytes equal `bytes`, or null. Only the newest
 * `DEDUPE_MAX_CANDIDATES` files of the same size are read, so a folder full of
 * screenshots stays cheap to search.
 */
function findSameImage(dir: string, bytes: Uint8Array): string | null {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	const candidates: Array<{ path: string; mtimeMs: number }> = [];
	for (const name of names) {
		const lower = name.toLowerCase();
		if (!IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))) continue;
		const path = join(dir, name);
		try {
			const stat = statSync(path);
			if (stat.isFile() && stat.size === bytes.length) candidates.push({ path, mtimeMs: stat.mtimeMs });
		} catch {
			// Ignore entries that disappear between listing and stat.
		}
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const candidate of candidates.slice(0, DEDUPE_MAX_CANDIDATES)) {
		try {
			if (readFileSync(candidate.path).equals(bytes)) return candidate.path;
		} catch {
			// Unreadable candidate: keep looking.
		}
	}
	return null;
}

/**
 * Writes a pasted image as `pasted-<timestamp>-<rand>.<ext>` and returns its
 * absolute path, reusing an existing file with identical bytes. The bounded
 * pruning only ever runs in the temporary fallback, never in a folder the user
 * owns. Returns null when the payload is too large or writing fails.
 */
export function savePastedImage(
	bytes: Uint8Array,
	extension: string,
	options: { context?: PasteDirContext; now?: () => Date; random?: () => string } = {},
): string | null {
	if (bytes.length > MAX_CACHE_FILE_BYTES) return null;
	const { dir, temporary } = pasteDir(options.context);
	const now = options.now ?? (() => new Date());
	const random = options.random ?? (() => Math.random().toString(36).slice(2, 10));
	try {
		mkdirSync(dir, { recursive: true });
		const existing = findSameImage(dir, bytes);
		if (existing !== null) return existing;
		const name = `pasted-${now().toISOString().replace(/[:.]/g, "-")}-${random()}.${extension}`;
		const target = join(dir, name);
		writeFileSync(target, bytes);
		if (temporary) enforceCacheLimit(dir);
		return target;
	} catch {
		return null;
	}
}

function enforceCacheLimit(dir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((name) => name.startsWith("pasted-"));
	} catch {
		return;
	}
	if (entries.length <= MAX_CACHE_FILES) return;
	const withTimes: Array<{ name: string; mtimeMs: number }> = [];
	for (const name of entries) {
		try {
			withTimes.push({ name, mtimeMs: statSync(join(dir, name)).mtimeMs });
		} catch {
			// Ignore entries that disappear between listing and stat.
		}
	}
	withTimes.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const { name } of withTimes.slice(0, withTimes.length - MAX_CACHE_FILES)) {
		try {
			unlinkSync(join(dir, name));
		} catch {
			// Best-effort cleanup only.
		}
	}
}
