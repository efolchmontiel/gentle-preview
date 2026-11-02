import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { highlightLine, type Span } from "../lib/highlight.ts";

function styles(spans: Span[]): string[] {
	return spans.map((s) => s.style);
}

function joined(spans: Span[]): string {
	return spans.map((s) => s.text).join("");
}

describe("highlightLine", () => {
	it("marks keywords, strings, numbers and comments in TypeScript", () => {
		const spans = highlightLine('const n = 42; // done', "TypeScript");
		assert.ok(spans.some((s) => s.style === "keyword" && s.text === "const"));
		assert.ok(spans.some((s) => s.style === "number" && s.text === "42"));
		assert.ok(spans.some((s) => s.style === "comment" && s.text === "// done"));
		assert.equal(joined(spans), 'const n = 42; // done');
	});

	it("keeps strings intact including keywords inside them", () => {
		const spans = highlightLine('const s = "return value";', "TypeScript");
		const strings = spans.filter((s) => s.style === "string");
		assert.deepEqual(strings.map((s) => s.text), ['"return value"']);
		assert.ok(!spans.some((s) => s.style === "keyword" && s.text === "return"));
	});

	it("handles escaped quotes inside strings", () => {
		const spans = highlightLine('const s = "a\\"b";', "TypeScript");
		const strings = spans.filter((s) => s.style === "string");
		assert.deepEqual(strings.map((s) => s.text), ['"a\\"b"']);
	});

	it("marks Python comments with # and Python keywords", () => {
		const spans = highlightLine("def f(): return None  # done", "Python");
		assert.ok(spans.some((s) => s.style === "keyword" && s.text === "def"));
		assert.ok(spans.some((s) => s.style === "keyword" && s.text === "None"));
		assert.ok(spans.some((s) => s.style === "comment" && s.text === "# done"));
	});

	it("marks JSON structural words", () => {
		const spans = highlightLine('{"a": true, "b": null}', "JSON");
		assert.ok(spans.some((s) => s.style === "keyword" && s.text === "true"));
		assert.ok(spans.some((s) => s.style === "keyword" && s.text === "null"));
	});

	it("returns a single plain span for an unknown language", () => {
		const spans = highlightLine("just text here", "Unknown");
		assert.deepEqual(spans, [{ text: "just text here", style: "plain" }]);
	});

	it("round-trips the input text exactly", () => {
		const line = 'if (x >= 0x1f) { log("hi"); } /* c */';
		for (const language of ["TypeScript", "Python", "JSON", "Unknown"]) {
			assert.equal(joined(highlightLine(line, language)), line);
		}
	});
});
