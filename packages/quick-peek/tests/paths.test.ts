import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as hostPath from "node:path";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { extractPaths, orderRefsForDisplay, type PathFlavour, type PathResolutionContext } from "../lib/paths.ts";

/**
 * One fixture set per path flavour. Every extraction case below runs against
 * BOTH flavours on every OS: the flavour is injected into the context, so the
 * Windows resolution semantics are exercised from Linux and macOS too, not
 * only on a Windows runner.
 */
interface Flavour {
	name: string;
	path: typeof hostPath.posix;
	cwd: string;
	home: string;
	absFile: string;
	tildeToken: string;
	homeNotes: string;
	relSrc: string;
	cwdSrcApp: string;
	dotConfig: string;
	cwdConfig: string;
	dotDotLib: string;
	homeSharedLib: string;
	cwdReadme: string;
	relSrcLine: string;
	relUtilLine: string;
	cwdUtil: string;
	relGuide: string;
	backtickedRaw: string;
	backticked: string;
	fallbackRoot: string;
	fallbackGuide: string;
}

const POSIX: Flavour = {
	name: "posix",
	path: hostPath.posix,
	cwd: "/home/dev/project",
	home: "/home/dev",
	absFile: "/etc/hosts",
	tildeToken: "~/notes/todo.md",
	homeNotes: "/home/dev/notes/todo.md",
	relSrc: "src/app.ts",
	cwdSrcApp: "/home/dev/project/src/app.ts",
	dotConfig: "./config.json",
	cwdConfig: "/home/dev/project/config.json",
	dotDotLib: "../shared/lib.ts",
	homeSharedLib: "/home/dev/shared/lib.ts",
	cwdReadme: "/home/dev/project/README.md",
	relSrcLine: "src/app.ts:42",
	relUtilLine: "lib/util.ts:7:3",
	cwdUtil: "/home/dev/project/lib/util.ts",
	relGuide: "docs/guide.md",
	backtickedRaw: "/home/dev/my folder/my file.ts",
	backticked: "/home/dev/my folder/my file.ts",
	fallbackRoot: "/home/dev/project-docs",
	fallbackGuide: "/home/dev/project-docs/docs/guide.md",
};

const WIN32: Flavour = {
	name: "win32",
	path: hostPath.win32,
	cwd: "C:\\home\\dev\\project",
	home: "C:\\home\\dev",
	absFile: "C:\\etc\\hosts",
	tildeToken: "~\\notes\\todo.md",
	homeNotes: "C:\\home\\dev\\notes\\todo.md",
	relSrc: "src\\app.ts",
	cwdSrcApp: "C:\\home\\dev\\project\\src\\app.ts",
	dotConfig: ".\\config.json",
	cwdConfig: "C:\\home\\dev\\project\\config.json",
	dotDotLib: "..\\shared\\lib.ts",
	homeSharedLib: "C:\\home\\dev\\shared\\lib.ts",
	cwdReadme: "C:\\home\\dev\\project\\README.md",
	relSrcLine: "src\\app.ts:42",
	relUtilLine: "lib\\util.ts:7:3",
	cwdUtil: "C:\\home\\dev\\project\\lib\\util.ts",
	relGuide: "docs\\guide.md",
	backtickedRaw: "C:\\home\\dev\\my folder\\my file.ts",
	backticked: "C:\\home\\dev\\my folder\\my file.ts",
	fallbackRoot: "C:\\home\\dev\\project-docs",
	fallbackGuide: "C:\\home\\dev\\project-docs\\docs\\guide.md",
};

const FLAVOURS: readonly Flavour[] = [POSIX, WIN32];

function ctx(f: Flavour, exists: (path: string) => boolean, overrides?: Partial<PathResolutionContext>): PathResolutionContext {
	return {
		cwd: f.cwd,
		home: f.home,
		root: f.cwd,
		path: f.path satisfies PathFlavour,
		exists,
		isDirectory: (path) => path.endsWith(f.path.sep),
		...overrides,
	};
}

const ALWAYS = () => true;
const NEVER = () => false;

describe("path extraction", () => {
	it("finds an absolute path", () => {
		for (const f of FLAVOURS) {
			const refs = extractPaths(`look at ${f.absFile} for details`, ctx(f, ALWAYS));
			const hit = refs.find((r) => r.path === f.absFile);
			assert.ok(hit, `[${f.name}] expected ${f.absFile} in ${JSON.stringify(refs)}`);
			assert.equal(hit.resolved, true, f.name);
			assert.equal(hit.line, undefined, f.name);
			assert.equal(hit.column, undefined, f.name);
		}
	});

	it("finds a home-relative path and expands ~", () => {
		for (const f of FLAVOURS) {
			const refs = extractPaths(`see ${f.tildeToken}`, ctx(f, ALWAYS));
			const hit = refs.find((r) => r.path === f.homeNotes);
			assert.ok(hit, `[${f.name}] expected ${f.homeNotes} in ${JSON.stringify(refs)}`);
			assert.equal(hit.raw, f.tildeToken, f.name);
			assert.equal(hit.resolved, true, f.name);
		}
	});

	it("finds a bare ~", () => {
		for (const f of FLAVOURS) {
			const refs = extractPaths("my ~ dir", ctx(f, ALWAYS));
			const hit = refs.find((r) => r.path === f.home);
			assert.ok(hit, `[${f.name}] expected bare ~ to resolve to ${f.home}`);
		}
	});

	it("resolves a relative path against cwd first", () => {
		for (const f of FLAVOURS) {
			const refs = extractPaths(`open ${f.relSrc}`, ctx(f, ALWAYS));
			const hit = refs.find((r) => r.path === f.cwdSrcApp);
			assert.ok(hit, `[${f.name}] expected ${f.relSrc} resolved against cwd in ${JSON.stringify(refs)}`);
			assert.equal(hit.resolved, true, f.name);
		}
	});

	it("resolves ./x and ../x", () => {
		for (const f of FLAVOURS) {
			const refs = extractPaths(`use ${f.dotConfig} or ${f.dotDotLib}`, ctx(f, ALWAYS));
			const paths = refs.map((r) => r.path);
			assert.ok(paths.includes(f.cwdConfig), `[${f.name}] missing ${f.dotConfig} in ${JSON.stringify(paths)}`);
			assert.ok(paths.includes(f.homeSharedLib), `[${f.name}] missing ${f.dotDotLib} in ${JSON.stringify(paths)}`);
		}
	});

	it("resolves a bare filename with an extension", () => {
		for (const f of FLAVOURS) {
			const refs = extractPaths("check README.md at the root", ctx(f, ALWAYS));
			const hit = refs.find((r) => r.path === f.cwdReadme);
			assert.ok(hit, `[${f.name}] expected README.md resolved against cwd in ${JSON.stringify(refs)}`);
		}
	});

	it("parses :line and :line:column suffixes", () => {
		for (const f of FLAVOURS) {
			const refs = extractPaths(`see ${f.relSrcLine} and ${f.relUtilLine}`, ctx(f, ALWAYS));
			const first = refs.find((r) => r.raw === f.relSrcLine);
			assert.ok(first, `[${f.name}] expected ${f.relSrcLine} in ${JSON.stringify(refs)}`);
			assert.equal(first.line, 42, f.name);
			assert.equal(first.column, undefined, f.name);
			const second = refs.find((r) => r.raw === f.relUtilLine);
			assert.ok(second, `[${f.name}] expected ${f.relUtilLine} in ${JSON.stringify(refs)}`);
			assert.equal(second.line, 7, f.name);
			assert.equal(second.column, 3, f.name);
			assert.equal(second.path, f.cwdUtil, f.name);
		}
	});

	it("does not strip the colon of a Windows drive", () => {
		for (const f of FLAVOURS) {
			const refs = extractPaths("check C:\\work\\notes.txt", ctx(f, ALWAYS));
			const hit = refs.find((r) => r.raw === "C:\\work\\notes.txt");
			assert.ok(hit, `[${f.name}] expected the windows path in ${JSON.stringify(refs)}`);
			assert.equal(hit.line, undefined, f.name);
			if (f.name === "win32") {
				// With the Windows flavour the drive path resolves to itself.
				assert.equal(hit.path, "C:\\work\\notes.txt", f.name);
			}
		}
	});

	it("extracts a backticked path containing spaces", () => {
		for (const f of FLAVOURS) {
			const refs = extractPaths(`see \`${f.backtickedRaw}\` please`, ctx(f, ALWAYS));
			const hit = refs.find((r) => r.path === f.backticked);
			assert.ok(hit, `[${f.name}] expected the backticked path with spaces in ${JSON.stringify(refs)}`);
			assert.equal(hit.resolved, true, f.name);
		}
	});

	it("returns an unresolved candidate unchanged instead of dropping it", () => {
		for (const f of FLAVOURS) {
			// The raw token uses forward slashes in both flavours; an unresolved
			// candidate is kept verbatim regardless of flavour.
			const refs = extractPaths("maybe src/does-not-exist.ts:5", ctx(f, NEVER));
			assert.equal(refs.length, 1, f.name);
			assert.equal(refs[0]!.resolved, false, f.name);
			assert.equal(refs[0]!.path, "src/does-not-exist.ts", f.name);
			assert.equal(refs[0]!.line, 5, f.name);
		}
	});

	it("falls back to the project root when cwd misses", () => {
		for (const f of FLAVOURS) {
			// Only the root location exists, so the cwd probe must miss first.
			const refs = extractPaths(`open ${f.relGuide}`, ctx(
				f,
				(p) => p.startsWith(f.fallbackRoot),
				{ root: f.fallbackRoot },
			));
			const hit = refs.find((r) => r.path === f.fallbackGuide);
			assert.ok(hit, `[${f.name}] expected resolution against the project root in ${JSON.stringify(refs)}`);
			assert.equal(hit.resolved, true, f.name);
		}
	});

	it("ignores URLs and plain words", () => {
		for (const f of FLAVOURS) {
			assert.deepEqual(extractPaths("browse https://example.com/a/b and hello world", ctx(f, ALWAYS)), [], f.name);
		}
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
