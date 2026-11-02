import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { extractPaths, orderRefsForDisplay, type PathResolutionContext } from "../lib/paths.ts";

function ctx(exists: (path: string) => boolean, overrides?: Partial<PathResolutionContext>): PathResolutionContext {
	return {
		cwd: "/home/dev/project",
		home: "/home/dev",
		root: "/home/dev/project",
		exists,
		isDirectory: (path) => path.endsWith("/"),
		...overrides,
	};
}

const ALWAYS = () => true;
const NEVER = () => false;

describe("path extraction", () => {
	it("finds an absolute path", () => {
		const refs = extractPaths("look at /etc/hosts for details", ctx(ALWAYS));
		const hit = refs.find((r) => r.path === "/etc/hosts");
		assert.ok(hit, "expected /etc/hosts");
		assert.equal(hit.resolved, true);
		assert.equal(hit.line, undefined);
		assert.equal(hit.column, undefined);
	});

	it("finds a home-relative path and expands ~", () => {
		const refs = extractPaths("see ~/notes/todo.md", ctx(ALWAYS));
		const hit = refs.find((r) => r.path === "/home/dev/notes/todo.md");
		assert.ok(hit, "expected the ~ path expanded against home");
		assert.equal(hit.raw, "~/notes/todo.md");
		assert.equal(hit.resolved, true);
	});

	it("finds a bare ~", () => {
		const refs = extractPaths("my ~ dir", ctx(ALWAYS));
		const hit = refs.find((r) => r.path === "/home/dev");
		assert.ok(hit, "expected bare ~ to resolve to home");
	});

	it("resolves a relative path against cwd first", () => {
		const refs = extractPaths("open src/app.ts", ctx(ALWAYS));
		const hit = refs.find((r) => r.path === "/home/dev/project/src/app.ts");
		assert.ok(hit, "expected src/app.ts resolved against cwd");
		assert.equal(hit.resolved, true);
	});

	it("resolves ./x and ../x", () => {
		const refs = extractPaths("use ./config.json or ../shared/lib.ts", ctx(ALWAYS));
		const paths = refs.map((r) => r.path);
		assert.ok(paths.includes("/home/dev/project/config.json"), `missing ./config.json in ${JSON.stringify(paths)}`);
		assert.ok(paths.includes("/home/dev/shared/lib.ts"), `missing ../shared/lib.ts in ${JSON.stringify(paths)}`);
	});

	it("resolves a bare filename with an extension", () => {
		const refs = extractPaths("check README.md at the root", ctx(ALWAYS));
		const hit = refs.find((r) => r.path === "/home/dev/project/README.md");
		assert.ok(hit, "expected README.md resolved against cwd");
	});

	it("parses :line and :line:column suffixes", () => {
		const refs = extractPaths("see src/app.ts:42 and lib/util.ts:7:3", ctx(ALWAYS));
		const first = refs.find((r) => r.raw === "src/app.ts:42");
		assert.ok(first, "expected src/app.ts:42");
		assert.equal(first.line, 42);
		assert.equal(first.column, undefined);
		const second = refs.find((r) => r.raw === "lib/util.ts:7:3");
		assert.ok(second, "expected lib/util.ts:7:3");
		assert.equal(second.line, 7);
		assert.equal(second.column, 3);
		assert.equal(second.path, "/home/dev/project/lib/util.ts");
	});

	it("does not strip the colon of a Windows drive", () => {
		const refs = extractPaths("check C:\\work\\notes.txt", ctx(ALWAYS));
		const hit = refs.find((r) => r.raw === "C:\\work\\notes.txt");
		assert.ok(hit, "expected the windows path");
		assert.equal(hit.line, undefined);
	});

	it("extracts a backticked path containing spaces", () => {
		const refs = extractPaths("see `/home/dev/my folder/my file.ts` please", ctx(ALWAYS));
		const hit = refs.find((r) => r.path === "/home/dev/my folder/my file.ts");
		assert.ok(hit, "expected the backticked path with spaces");
		assert.equal(hit.resolved, true);
	});

	it("returns an unresolved candidate unchanged instead of dropping it", () => {
		const refs = extractPaths("maybe src/does-not-exist.ts:5", ctx(NEVER));
		assert.equal(refs.length, 1);
		assert.equal(refs[0]!.resolved, false);
		assert.equal(refs[0]!.path, "src/does-not-exist.ts");
		assert.equal(refs[0]!.line, 5);
	});

	it("falls back to the project root when cwd misses", () => {
		// Only the root location exists, so the cwd probe must miss first.
		const refs = extractPaths("open docs/guide.md", ctx(
			(p) => p.startsWith("/home/dev/project-docs"),
			{ root: "/home/dev/project-docs" },
		));
		const hit = refs.find((r) => r.path === "/home/dev/project-docs/docs/guide.md");
		assert.ok(hit, "expected resolution against the project root");
		assert.equal(hit.resolved, true);
	});

	it("ignores URLs and plain words", () => {
		const refs = extractPaths("browse https://example.com/a/b and hello world", ctx(ALWAYS));
		assert.deepEqual(refs, []);
	});
});

describe("path extraction with the real filesystem", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "gentle-preview-paths-"));
		writeFileSync(join(dir, "notes.md"), "# notes\n");
		mkdirSync(join(dir, "sub"));
	});

	afterEach(() => {
		// The root runner removes gentle-preview-* scratch directories; this is
		// a fallback so a direct `node --test` run does not leak either.
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort; the runner cleans the prefix anyway.
		}
	});

	it("resolves through the default exists/isDirectory probes", () => {
		const refs = extractPaths(`edit ${join(dir, "notes.md")} and ${join(dir, "sub")}`, {
			cwd: dir,
		});
		assert.equal(refs.length, 2, JSON.stringify(refs));
		assert.ok(refs.every((r) => r.resolved));
	});
});

describe("orderRefsForDisplay", () => {
	it("puts files before directories and keeps the order of appearance inside each group", () => {
		const refs = [
			{ path: "/p", raw: "pkg/lib", isDirectory: true },
			{ path: "/a", raw: "a.ts" },
			{ path: "/q", raw: "pkg/lib", isDirectory: true },
			{ path: "/b", raw: "b.ts" },
		];
		assert.deepEqual(
			orderRefsForDisplay(refs).map((ref) => ref.raw),
			["a.ts", "b.ts", "pkg/lib", "pkg/lib"],
		);
	});

	it("does not mutate the input", () => {
		const refs = [{ path: "/p", isDirectory: true }, { path: "/a" }];
		orderRefsForDisplay(refs);
		assert.equal(refs[0]?.isDirectory, true);
	});
});
