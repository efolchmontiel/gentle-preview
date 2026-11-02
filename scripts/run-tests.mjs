#!/usr/bin/env node
/**
 * Runs every package test suite, then removes the scratch directories the run
 * left in the system temp dir. Only entries that did not exist before the run
 * are removed, so a concurrent run or a real temp directory is never touched.
 *
 *   node scripts/run-tests.mjs                          # every package
 *   node scripts/run-tests.mjs packages/quick-peek/tests  # one directory or file
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(ROOT, "packages");
const SCRATCH = /^gentle-preview-/;

function scratchEntries() {
	try {
		return new Set(readdirSync(tmpdir()).filter((name) => SCRATCH.test(name)));
	} catch {
		return new Set();
	}
}

function testFilesIn(dir, found = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}
	for (const name of entries.sort()) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			testFilesIn(full, found);
		} else if (name.endsWith(".test.ts")) {
			found.push(full);
		}
	}
	return found;
}

/** Resolve an argument to test files: a file, a directory, or nothing for every package. */
function collect(args) {
	if (args.length > 0) {
		return args.flatMap((arg) => {
			const full = resolve(ROOT, arg);
			if (!existsSync(full)) {
				console.error(`run-tests: no such path: ${full}`);
				process.exit(2);
			}
			return statSync(full).isDirectory() ? testFilesIn(full) : [full];
		});
	}
	let packageNames;
	try {
		packageNames = readdirSync(PACKAGES).sort();
	} catch {
		console.error(`run-tests: no packages directory at ${PACKAGES}`);
		process.exit(2);
	}
	return packageNames.flatMap((name) => testFilesIn(join(PACKAGES, name, "tests")));
}

const files = collect(process.argv.slice(2));
if (files.length === 0) {
	console.error("run-tests: no *.test.ts files found");
	process.exit(2);
}

const before = scratchEntries();
const run = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: ROOT });

let removed = 0;
for (const name of scratchEntries()) {
	if (before.has(name)) continue;
	try {
		rmSync(join(tmpdir(), name), { recursive: true, force: true });
		removed += 1;
	} catch {
		// A leftover temp dir must not fail the suite.
	}
}
if (removed > 0) console.log(`run-tests: removed ${removed} scratch director${removed === 1 ? "y" : "ies"}`);

process.exit(run.status ?? 1);
