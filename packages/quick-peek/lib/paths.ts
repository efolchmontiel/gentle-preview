/**
 * Path extraction and resolution for quick-peek.
 *
 * Pure, unit-testable logic: every filesystem probe is injectable, so the
 * tests run without touching a terminal or the real filesystem (except for
 * one explicit default-probe case under os.tmpdir()).
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** A file path candidate found in text. */
export interface PathRef {
	/** The candidate as found in the text, backticks stripped. */
	raw: string;
	/**
	 * The absolute path when `resolved` is true. When `resolved` is false the
	 * raw candidate is kept unchanged so callers can skip it without losing it.
	 */
	path: string;
	resolved: boolean;
	line?: number;
	column?: number;
	isDirectory: boolean;
}

/** Resolution inputs; every probe is injectable for tests. */
export interface PathResolutionContext {
	/** Session working directory: first resolution target for relative paths. */
	cwd: string;
	/** Home directory used to expand `~`/`~/...`. Defaults to os.homedir(). */
	home?: string;
	/** Project root: second resolution target for relative paths. */
	root?: string;
	exists?: (path: string) => boolean;
	isDirectory?: (path: string) => boolean;
}

const BARE_DELIMS = "\"'“”‘’,;()[]{}<>";
/** Strip surrounding punctuation that prose leaves around tokens. */
function cleanToken(token: string): string {
	let s = token;
	while (s.length > 1 && BARE_DELIMS.includes(s[0]!)) s = s.slice(1);
	while (s.length > 1 && BARE_DELIMS.includes(s.at(-1)!)) s = s.slice(0, -1);
	// Trailing sentence punctuation, unless it is a :line suffix.
	s = s.replace(/[.,;!?]+$/, "");
	return s;
}

/** Split off a trailing `:line` or `:line:column`, never a Windows drive colon. */
export function parseLocation(token: string): { path: string; line?: number; column?: number } {
	const match = /:(\d{1,9})(?::(\d{1,9}))?$/.exec(token);
	if (!match || match.index === undefined) return { path: token };
	const before = token.slice(0, match.index);
	// "C:" or a path ending in ":" is not a line suffix.
	if (before.length === 0 || before.endsWith(":")) return { path: token };
	const line = Number.parseInt(match[1]!, 10);
	if (!Number.isFinite(line) || line < 1) return { path: token };
	const columnRaw = match[2];
	const column = columnRaw ? Number.parseInt(columnRaw, 10) : undefined;
	return { path: before, line, column: column && column >= 1 ? column : undefined };
}

/** Whether a whitespace-free token plausibly denotes a filesystem path. */
export function looksLikePath(token: string): boolean {
	if (token.length === 0 || /\s/.test(token)) return false;
	return looksLikePathIgnoringSpaces(token);
}

/** Same check, tolerating spaces: used for backticked paths. */
function looksLikePathIgnoringSpaces(token: string): boolean {
	const s = token.replace(/\s+/g, "");
	if (s.length === 0) return false;
	if (s.includes("://")) return false; // URLs, not paths
	if (/^[A-Za-z]:[\\/]/.test(s)) return true; // C:\ or C:/
	if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) return true;
	if (s.startsWith("/") || s.startsWith("\\\\")) return true;
	if (s.startsWith("./") || s.startsWith("../")) return true;
	if (/[\\/]/.test(s)) return true; // relative path with separators
	// Bare filename with an extension: README.md, package.json, app.test.ts
	return /^[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+$/.test(s);
}

/** Extract path-looking tokens from text, including backticked paths with spaces. */
export function extractPathTokens(text: string): string[] {
	const tokens: string[] = [];
	// 1) Backticked spans may contain spaces; require them to look like paths.
	for (const match of text.matchAll(/`([^`\n]+)`/g)) {
		const inner = match[1]?.trim() ?? "";
		if (inner.length > 0 && looksLikePathIgnoringSpaces(inner)) {
			tokens.push(inner);
		}
	}
	// 2) Bare whitespace-delimited tokens.
	const masked = text.replace(/`[^`\n]*`/g, " ");
	for (const word of masked.split(/\s+/)) {
		const token = cleanToken(word);
		if (token.length > 0 && looksLikePath(token)) tokens.push(token);
	}
	return tokens;
}

/** Resolve one path part against home, cwd, then the project root. */
export function resolvePathPart(part: string, ctx: PathResolutionContext): { path: string; resolved: boolean } {
	const exists = ctx.exists ?? existsSync;
	const usable = (p: string): boolean => {
		try {
			return exists(p);
		} catch {
			return false;
		}
	};

	if (part === "~") {
		const home = ctx.home ?? homedir();
		return { path: home, resolved: usable(home) };
	}
	if (part.startsWith("~/") || part.startsWith("~\\")) {
		const candidate = resolve(ctx.home ?? homedir(), part.slice(2));
		return { path: candidate, resolved: usable(candidate) };
	}
	if (isAbsolute(part) || /^[A-Za-z]:[\\/]/.test(part)) {
		const candidate = resolve(part);
		return { path: candidate, resolved: usable(candidate) };
	}
	const inCwd = resolve(ctx.cwd, part);
	if (usable(inCwd)) {
		return { path: inCwd, resolved: true };
	}
	if (ctx.root && resolve(ctx.root) !== resolve(ctx.cwd)) {
		const inRoot = resolve(ctx.root, part);
		if (usable(inRoot)) {
			return { path: inRoot, resolved: true };
		}
	}
	// Unresolved: keep the raw candidate unchanged for the caller to skip.
	return { path: part, resolved: false };
}

/**
 * Extract candidate paths from arbitrary text and resolve them.
 *
 * Refs that do not resolve to an existing file or directory are returned with
 * `resolved: false` and their raw candidate in `path`, so callers can skip
 * them without the extractor silently dropping information.
 */
export function extractPaths(text: string, ctx: PathResolutionContext): PathRef[] {
	const exists = ctx.exists ?? existsSync;
	const isDirectory = ctx.isDirectory ?? ((p: string) => {
		try {
			return statSync(p).isDirectory();
		} catch {
			return false;
		}
	});

	const refs: PathRef[] = [];
	const seen = new Set<string>();
	for (const token of extractPathTokens(text)) {
		const { path: pathPart, line, column } = parseLocation(token);
		// Tokens are already validated by extractPathTokens (which allows spaces
		// for backticked paths), so no whitespace-rejecting re-check here.
		const { path: resolvedPath, resolved } = resolvePathPart(pathPart, ctx);
		if (resolved) {
			try {
				if (!exists(resolvedPath)) continue;
			} catch {
				continue;
			}
		}
		const key = `${resolvedPath}\u0000${line ?? ""}\u0000${column ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		refs.push({
			raw: token,
			path: resolvedPath,
			resolved,
			line,
			column,
			isDirectory: resolved ? isDirectory(resolvedPath) : false,
		});
	}	return refs;
}

/**
 * Display order for a candidate list: files first, directories last, otherwise
 * the order of appearance. `Array.prototype.sort` is stable, so entries that
 * share a group keep the order they were found in.
 */
export function orderRefsForDisplay<T extends { isDirectory?: boolean }>(refs: readonly T[]): T[] {
	return [...refs].sort((a, b) => Number(a.isDirectory === true) - Number(b.isDirectory === true));
}
