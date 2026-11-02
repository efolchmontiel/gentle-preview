import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extensionForMime,
	isImageFilePath,
	MAX_CACHE_FILE_BYTES,
	mimeFromPath,
	parseGifSize,
	parseJpegSize,
	parsePngSize,
	parseWebpSize,
	pasteDir,
	savePastedImage,
	sniffImage,
} from "../lib/images.ts";

function pngBytes(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(17);
	ihdr.writeUInt32BE(13, 0); // IHDR data length
	ihdr.write("IHDR", 4);
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

function gifBytes(width: number, height: number): Buffer {
	const head = Buffer.from("GIF89a");
	const dims = Buffer.alloc(4);
	dims.writeUInt16LE(width, 0);
	dims.writeUInt16LE(height, 2);
	return Buffer.concat([head, dims, Buffer.alloc(8)]);
}

function jpegBytes(width: number, height: number): Buffer {
	// SOI, a COM segment to prove the walk skips non-SOF markers, then SOF0.
	const com = Buffer.from([0xff, 0xfe, 0x00, 0x04, 0x61, 0x62]);
	const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 3);
	sof[0] = 0xff;
	sof[1] = 0xc0;
	sof.writeUInt16BE(17, 2);
	sof[4] = 8;
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), com, sof]);
}

function webpVp8lBytes(width: number, height: number): Buffer {
	const w = width - 1;
	const h = height - 1;
	const bits = Buffer.alloc(4);
	bits[0] = w & 0xff;
	bits[1] = ((w >> 8) | (h << 6)) & 0xff;
	bits[2] = (h >> 2) & 0xff;
	bits[3] = 0x00; // no transform bits (heights ≤ 1024 need none)
	const chunkPayload = Buffer.concat([Buffer.from([0x2f]), bits, Buffer.alloc(5)]);
	const header = Buffer.alloc(12);
	header.write("RIFF", 0);
	header.writeUInt32LE(4 + 8 + chunkPayload.length, 4);
	header.write("WEBP", 8);
	const chunkHeader = Buffer.alloc(8);
	chunkHeader.write("VP8L", 0);
	chunkHeader.writeUInt32LE(chunkPayload.length, 4);
	return Buffer.concat([header, chunkHeader, chunkPayload]);
}

function webpVp8xBytes(width: number, height: number): Buffer {
	const chunkPayload = Buffer.alloc(10);
	chunkPayload.writeUIntLE(width - 1, 4, 3);
	chunkPayload.writeUIntLE(height - 1, 7, 3);
	const header = Buffer.alloc(12);
	header.write("RIFF", 0);
	header.writeUInt32LE(4 + 8 + chunkPayload.length, 4);
	header.write("WEBP", 8);
	const chunkHeader = Buffer.alloc(8);
	chunkHeader.write("VP8X", 0);
	chunkHeader.writeUInt32LE(chunkPayload.length, 4);
	return Buffer.concat([header, chunkHeader, chunkPayload]);
}

test("PNG detection: magic bytes and IHDR dimensions", () => {
	const bytes = pngBytes(640, 480);
	assert.deepEqual(parsePngSize(bytes), { width: 640, height: 480 });
	assert.deepEqual(sniffImage(bytes), { mimeType: "image/png", width: 640, height: 480 });
	assert.equal(sniffImage(pngBytes(1, 1))?.width, 1);
});

test("JPEG detection: walks markers to the start-of-frame", () => {
	const bytes = jpegBytes(800, 600);
	assert.deepEqual(parseJpegSize(bytes), { width: 800, height: 600 });
	assert.deepEqual(sniffImage(bytes), { mimeType: "image/jpeg", width: 800, height: 600 });
	assert.equal(parseJpegSize(Buffer.from([0xff, 0xd9])), null);
});

test("GIF detection: header version and logical screen size", () => {
	const bytes = gifBytes(320, 200);
	assert.deepEqual(parseGifSize(bytes), { width: 320, height: 200 });
	assert.deepEqual(sniffImage(bytes), { mimeType: "image/gif", width: 320, height: 200 });
	assert.equal(parseGifSize(Buffer.from("GIF98a", "utf8")), null);
});

test("WebP detection: VP8L and VP8X chunks", () => {
	assert.deepEqual(parseWebpSize(webpVp8lBytes(3, 2)), { width: 3, height: 2 });
	assert.deepEqual(parseWebpSize(webpVp8xBytes(100, 50)), { width: 100, height: 50 });
	assert.deepEqual(sniffImage(webpVp8lBytes(1024, 768)), { mimeType: "image/webp", width: 1024, height: 768 });
});

test("sniffImage rejects non-images and truncated data", () => {
	assert.equal(sniffImage(Buffer.from("hello world, definitely not an image")), null);
	assert.equal(sniffImage(Buffer.alloc(0)), null);
	assert.equal(sniffImage(pngBytes(640, 480).subarray(0, 10)), null);
});

test("extension and path helpers", () => {
	assert.equal(extensionForMime("image/png"), "png");
	assert.equal(extensionForMime("image/jpeg"), "jpg");
	assert.equal(extensionForMime("image/webp"), "webp");
	assert.equal(mimeFromPath("/tmp/shot.PNG"), "image/png");
	assert.equal(mimeFromPath("/tmp/shot.jpeg"), "image/jpeg");
	assert.equal(mimeFromPath("/tmp/shot.txt"), undefined);
	assert.equal(mimeFromPath("/tmp/noext"), undefined);
	assert.equal(isImageFilePath("/tmp/shot.gif"), true);
	assert.equal(isImageFilePath("/tmp/notes.md"), false);
});

const PNG_BYTES = pngBytes(2, 2);

test("pasteDir prefers the configured folder over every fallback", () => {
	assert.deepEqual(
		pasteDir({
			env: { GENTLE_IMAGE_PREVIEW_DIR: "/pics", OMARCHY_SCREENSHOT_DIR: "/shots", XDG_PICTURES_DIR: "/xdg" },
			home: "/home/u",
			exists: () => true,
		}),
		{ dir: "/pics", temporary: false },
	);
});

test("pasteDir follows the Omarchy, XDG and conventional fallbacks in order", () => {
	assert.deepEqual(pasteDir({ env: { OMARCHY_SCREENSHOT_DIR: "/shots" }, home: "/home/u", exists: () => true }), {
		dir: "/shots",
		temporary: false,
	});
	assert.deepEqual(pasteDir({ env: { XDG_PICTURES_DIR: "/xdg" }, home: "/home/u", exists: () => true }), {
		dir: join("/xdg", "screenshots"),
		temporary: false,
	});
	const conventional = join("/home/u", "Pictures", "screenshots");
	assert.deepEqual(
		pasteDir({ env: {}, home: "/home/u", exists: (path) => path === conventional }),
		{ dir: conventional, temporary: false },
	);
});

test("pasteDir falls back to a bounded temp cache when no folder is available", () => {
	assert.deepEqual(pasteDir({ env: {}, home: "/home/u", exists: () => false, tmpDir: "/tmp/x" }), {
		dir: join("/tmp/x", "gentle-preview-paste"),
		temporary: true,
	});
});

test("savePastedImage writes into a user folder and never prunes it", () => {
	const dir = join(tmpdir(), `gentle-preview-userdir-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	const context = { env: { GENTLE_IMAGE_PREVIEW_DIR: dir } };
	for (let i = 0; i < 205; i += 1) {
		// Two distinct bytes per write so the duplicate search never collapses them.
		const path = savePastedImage(Buffer.from([i % 256, Math.floor(i / 256)]), "png", {
			context,
			now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
			random: () => `n${i}`,
		});
		assert.ok(path !== null);
	}
	// MAX_CACHE_FILES is 200; a user folder keeps everything.
	assert.equal(readdirSync(dir).length, 205);
});

test("savePastedImage reuses a file that already holds the same bytes", () => {
	const dir = join(tmpdir(), `gentle-preview-dedupe-${process.pid}`);
	const context = { env: { GENTLE_IMAGE_PREVIEW_DIR: dir } };
	const first = savePastedImage(PNG_BYTES, "png", {
		context,
		now: () => new Date("2026-01-01T00:00:00.000Z"),
		random: () => "a",
	});
	const second = savePastedImage(PNG_BYTES, "png", {
		context,
		now: () => new Date("2026-01-01T00:00:05.000Z"),
		random: () => "b",
	});
	assert.ok(first !== null);
	assert.equal(second, first);
	assert.equal(readdirSync(dir).length, 1);
});

test("savePastedImage names the file after the paste and keeps its bytes", () => {
	const dir = join(tmpdir(), `gentle-preview-name-${process.pid}`);
	const path = savePastedImage(PNG_BYTES, "png", {
		context: { env: { GENTLE_IMAGE_PREVIEW_DIR: dir } },
		now: () => new Date("2026-01-01T00:00:00.000Z"),
		random: () => "abc",
	});
	assert.equal(path, join(dir, "pasted-2026-01-01T00-00-00-000Z-abc.png"));
	assert.equal(readFileSync(path ?? "").length, PNG_BYTES.length);
});

test("savePastedImage keeps the temporary cache bounded", () => {
	const tmpDir = join(tmpdir(), `gentle-preview-cache-${process.pid}`);
	const context = { env: {}, home: join(tmpDir, "home"), exists: () => false, tmpDir };
	for (let i = 0; i < 202; i += 1) {
		savePastedImage(Buffer.from([i % 256, Math.floor(i / 256)]), "png", {
			context,
			now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
			random: () => `n${i}`,
		});
	}
	const cacheDir = join(tmpDir, "gentle-preview-paste");
	assert.equal(readdirSync(cacheDir).filter((name) => name.startsWith("pasted-")).length, 200);
});

test("savePastedImage refuses oversized payloads", () => {
	assert.equal(
		savePastedImage(Buffer.alloc(MAX_CACHE_FILE_BYTES + 1), "png", {
			context: { env: { GENTLE_IMAGE_PREVIEW_DIR: join(tmpdir(), `gentle-preview-oversize-${process.pid}`) } },
		}),
		null,
	);
});
