import assert from "node:assert/strict";
import { test } from "node:test";
import { appendImageRefs, buildImageRefsBlock, formatToken, IMAGE_REFS_HEADER, parseTokenNumbers } from "../lib/tokens.ts";

test("formatToken renders [Image #N]", () => {
	assert.equal(formatToken(1), "[Image #1]");
	assert.equal(formatToken(42), "[Image #42]");
});

test("parseTokenNumbers returns numbers in order of appearance, deduplicated", () => {
	assert.deepEqual(parseTokenNumbers("a [Image #2] b [Image #1] c [Image #2]"), [2, 1]);
	assert.deepEqual(parseTokenNumbers("[Image #3][Image #10]"), [3, 10]);
	assert.deepEqual(parseTokenNumbers("no tokens here"), []);
	assert.deepEqual(parseTokenNumbers(""), []);
});

test("parseTokenNumbers ignores malformed lookalikes", () => {
	assert.deepEqual(parseTokenNumbers("[image #1] [Image #x] [Image#1] [ Image #1 ]"), []);
});

test("buildImageRefsBlock sorts ascending and formats one line per ref", () => {
	const block = buildImageRefsBlock([
		{ number: 2, path: "/tmp/b.png" },
		{ number: 1, path: "/tmp/a.png" },
	]);
	assert.equal(block, `${IMAGE_REFS_HEADER}\n[Image #1] = /tmp/a.png\n[Image #2] = /tmp/b.png`);
});

test("buildImageRefsBlock is empty without refs", () => {
	assert.equal(buildImageRefsBlock([]), "");
});

test("appendImageRefs preserves the body verbatim and appends the block", () => {
	const body = "look at [Image #1] and [Image #2]";
	const out = appendImageRefs(body, [{ number: 2, path: "/b.png" }, { number: 1, path: "/a.png" }]);
	assert.ok(out.startsWith(body));
	assert.ok(out.endsWith(`${IMAGE_REFS_HEADER}\n[Image #1] = /a.png\n[Image #2] = /b.png`));
});

test("appendImageRefs without refs returns the text unchanged", () => {
	const body = "just text";
	assert.equal(appendImageRefs(body, []), body);
});
