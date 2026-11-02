/**
 * Image file helpers: detection by magic bytes and extension, MIME types,
 * header-based dimensions, and the bounded cache directory for saved pastes.
 *
 * All parsers are pure functions over byte buffers so they can be tested
 * without a terminal, a filesystem or a real image.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** Upper bound on how many paste files the cache directory keeps. */
const MAX_CACHE_FILES = 200;
/** Hard cap for a single cached paste; larger payloads are still pasted but not cached. */
export const MAX_CACHE_FILE_BYTES = 64 * 1024 * 1024;

/** Absolute path of the bounded cache directory under `os.tmpdir()`. */
export function pasteCacheDir(tmpDir: string = tmpdir()): string {
	return join(tmpDir, "gentle-preview-paste");
}

/**
 * Writes `bytes` into the cache directory as `paste-<timestamp>-<rand>.<ext>`
 * and returns its absolute path. Keeps at most `MAX_CACHE_FILES` files by
 * removing the oldest ones. Returns null when the payload exceeds the cache
 * cap or writing fails, so the caller can degrade gracefully.
 */
export function savePasteToCache(
	bytes: Uint8Array,
	extension: string,
	options: { tmpDir?: string; now?: () => Date; random?: () => string } = {},
): string | null {
	if (bytes.length > MAX_CACHE_FILE_BYTES) return null;
	const dir = pasteCacheDir(options.tmpDir);
	const now = options.now ?? (() => new Date());
	const random = options.random ?? (() => Math.random().toString(36).slice(2, 10));
	const name = `paste-${now().toISOString().replace(/[:.]/g, "-")}-${random()}.${extension}`;
	const target = join(dir, name);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(target, bytes);
		enforceCacheLimit(dir);
		return target;
	} catch {
		return null;
	}
}

function enforceCacheLimit(dir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((name) => name.startsWith("paste-"));
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
