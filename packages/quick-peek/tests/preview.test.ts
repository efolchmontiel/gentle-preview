import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildPreview,
	imageDimensions,
	MAX_TEXT_BYTES,
	mimeTypeForPath,
	type PreviewDeps,
} from "../lib/preview.ts";

function fakeDeps(overrides?: Partial<PreviewDeps>): PreviewDeps {
	return {
		stat: () => ({ size: 100, modifiedMs: 0 }),
		isDirectory: () => false,
		readText: () => "one\ntwo\nthree\n",
		readBytes: () => new Uint8Array(0),
		listDirectory: () => ({ entries: [], total: 0 }),
		...overrides,
	};
}

describe("text windows", () => {
	const THIRTY = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

	it("returns the first 20 lines by default with the total line count", () => {
		const p = buildPreview("/tmp/file.txt", {}, fakeDeps({ readText: () => THIRTY }));
		assert.ok(p.text);
		assert.equal(p.text.totalLines, 30);
		assert.equal(p.text.start, 1);
		assert.equal(p.text.lines.length, 20);
		assert.equal(p.text.lines[0]!.text, "line 1");
		assert.equal(p.text.lines[19]!.text, "line 20");
		assert.ok(p.text.lines.every((l) => !l.marked));
	});

	it("centers the window around a target line and marks it", () => {
		const p = buildPreview("/tmp/file.txt", { line: 15, window: 10 }, fakeDeps({ readText: () => THIRTY }));
		assert.ok(p.text);
		assert.equal(p.text.start, 10, "15 - 10/2 = 10");
		assert.equal(p.text.lines.length, 10);
		const marked = p.text.lines.filter((l) => l.marked);
		assert.deepEqual(marked.map((l) => l.number), [15]);
	});

	it("clamps the window to the end of the file", () => {
		const p = buildPreview("/tmp/file.txt", { line: 29, window: 10 }, fakeDeps({ readText: () => THIRTY }));
		assert.ok(p.text);
		assert.equal(p.text.start, 21);
		assert.equal(p.text.lines.length, 10);
		assert.equal(p.text.lines.at(-1)!.number, 30);
	});

	it("honours an explicit start line for scrolling", () => {
		const p = buildPreview("/tmp/file.txt", { startLine: 22 }, fakeDeps({ readText: () => THIRTY }));
		assert.ok(p.text);
		assert.equal(p.text.start, 22);
		assert.equal(p.text.lines[0]!.text, "line 22");
	});

	it("marks the requested line even when the window starts at the top", () => {
		const p = buildPreview("/tmp/file.txt", { line: 3, window: 20 }, fakeDeps({ readText: () => THIRTY }));
		assert.ok(p.text);
		assert.equal(p.text.start, 1);
		assert.ok(p.text.lines.some((l) => l.marked && l.number === 3));
	});
});

describe("size and content refusals", () => {
	it("refuses to read text for files over 1 MB and falls back to metadata only", () => {
		const p = buildPreview(
			"/tmp/huge.log",
			{},
			fakeDeps({
				stat: () => ({ size: MAX_TEXT_BYTES + 1, modifiedMs: 0 }),
				readText: () => {
					throw new Error("must not be called");
				},
			}),
		);
		assert.equal(p.text, undefined);
		assert.match(p.note ?? "", /1\.0 MB|exceeds/i);
		assert.equal(p.meta?.size, MAX_TEXT_BYTES + 1);
	});

	it("refuses text that contains a NUL byte and reports binary", () => {
		const p = buildPreview(
			"/tmp/blob.dat",
			{},
			fakeDeps({ readText: () => "abc\0def" }),
		);
		assert.equal(p.kind, "binary");
		assert.equal(p.text, undefined);
		assert.match(p.note ?? "", /binary/i);
	});

	it("keeps the kind from the extension for known text files", () => {
		const p = buildPreview("/tmp/app.ts", {}, fakeDeps());
		assert.equal(p.kind, "code");
		assert.ok(p.text);
		assert.equal(p.text.language, "TypeScript");
	});
});

describe("image previews", () => {
	it("reports mime type and PNG dimensions from the header", () => {
		// PNG: 8-byte signature, IHDR length/type, then width/height as BE u32.
		const bytes = new Uint8Array(24);
		bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
		bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
		new DataView(bytes.buffer).setUint32(16, 640, false);
		new DataView(bytes.buffer).setUint32(20, 480, false);
		assert.deepEqual(imageDimensions(bytes), { width: 640, height: 480 });

		const p = buildPreview(
			"/tmp/pic.png",
			{},
			fakeDeps({ readBytes: () => bytes }),
		);
		assert.equal(p.kind, "image");
		assert.deepEqual(p.image, { mimeType: "image/png", width: 640, height: 480 });
		assert.equal(p.text, undefined);
	});

	it("parses GIF dimensions", () => {
		const bytes = new Uint8Array(10);
		bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
		bytes[6] = 0x20; // 32
		bytes[7] = 0x00;
		bytes[8] = 0x40; // 64
		bytes[9] = 0x00;
		assert.deepEqual(imageDimensions(bytes), { width: 32, height: 64 });
	});

	it("parses WebP VP8 dimensions", () => {
		const bytes = new Uint8Array(30);
		bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
		bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
		bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
		new DataView(bytes.buffer).setUint16(26, 320, true);
		new DataView(bytes.buffer).setUint16(28, 200, true);
		assert.deepEqual(imageDimensions(bytes), { width: 320, height: 200 });
	});

	it("returns null for unknown bytes", () => {
		assert.equal(imageDimensions(new Uint8Array([1, 2, 3, 4])), null);
	});

	it("reports the mime type even when dimensions cannot be parsed", () => {
		const p = buildPreview("/tmp/pic.jpeg", {}, fakeDeps({ readBytes: () => new Uint8Array([0, 0]) }));
		assert.equal(p.kind, "image");
		assert.ok(p.image);
		assert.equal(p.image.mimeType, "image/jpeg");
		assert.equal(p.image.width, undefined);
	});
});

describe("directory previews", () => {
	it("lists the first entries and the total count", () => {
		const p = buildPreview(
			"/tmp/dir",
			{},
			fakeDeps({
				isDirectory: () => true,
				listDirectory: () => ({ entries: ["a.ts", "b.ts"], total: 7 }),
			}),
		);
		assert.equal(p.kind, "directory");
		assert.deepEqual(p.directory?.entries, ["a.ts", "b.ts"]);
		assert.equal(p.directory?.total, 7);
	});
});

describe("human labels", () => {
	it("formats byte sizes", () => {
		const p = buildPreview(
			"/tmp/file.txt",
			{},
			fakeDeps({ stat: () => ({ size: 1536, modifiedMs: 0 }) }),
		);
		assert.equal(p.sizeLabel, "1.5 KB");
	});

	it("formats age deterministically from the given now", () => {
		const now = Date.now();
		const p = buildPreview(
			"/tmp/file.txt",
			{ now },
			fakeDeps({ stat: () => ({ size: 10, modifiedMs: now - 2 * 60 * 60 * 1000 }) }),
		);
		assert.equal(p.ageLabel, "2h ago");
	});
});

describe("mime detection", () => {
	it("maps known extensions", () => {
		assert.equal(mimeTypeForPath("/a/x.png"), "image/png");
		assert.equal(mimeTypeForPath("/a/x.webp"), "image/webp");
		assert.equal(mimeTypeForPath("/a/x.jpg"), "image/jpeg");
		assert.equal(mimeTypeForPath("/a/x.gif"), "image/gif");
		assert.equal(mimeTypeForPath("/a/x.txt"), "text/plain");
		assert.equal(mimeTypeForPath("/a/x.ts"), "text/plain");
		assert.equal(mimeTypeForPath("/a/x.bin"), null);
	});
});
