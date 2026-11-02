/**
 * gentle-quick-peek — inspect a file from the current session without opening
 * it: `/peek [path[:line[:column]]]` or alt+o.
 *
 * Without an argument the overlay lists the file paths found in the current
 * session transcript and previews the focused one. Keyboard is the primary
 * path; mouse hover and click are additive and only active in fullscreen.
 *
 * No processes, watchers or timers are started in the extension factory; the
 * only spawns happen on an explicit user action (Enter / click), with a
 * bounded timeout.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	detectCapabilities,
	imageFallback,
	Image,
	matchesKey,
	MouseRegion,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
	ImageTheme,
	KeybindingsManager,
	TuiMouseEvent,
	TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

import { highlightLine, type Span } from "../lib/highlight.ts";
import {
	detectPlatform,
	reveal,
	revealPlan,
	windowsPathViaWsl,
	type Platform,
	type RevealDeps,
	type WslExecDeps,
} from "../lib/open.ts";
import { extractPaths, type PathRef, type PathResolutionContext } from "../lib/paths.ts";
import {
	buildPreview,
	defaultPreviewDeps,
	type PreviewModel,
} from "../lib/preview.ts";

const execFile = promisify(execFileCb);

/** Free in every default keybinding set (alt+p is taken on Windows/WSL). */
const PEEK_SHORTCUT = "alt+o" as const;

const MAX_ITEMS = 50;
const MAX_SCAN_ENTRIES = 300;
const MAX_SCAN_CHARS = 200_000;
const MAX_VISIBLE_ITEMS = 10;
const PREVIEW_LINES = 14;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const REVEAL_TIMEOUT_MS = 5_000;
const WSLPATH_TIMEOUT_MS = 3_000;

const STYLE_TOKENS = {
	keyword: "syntaxKeyword",
	string: "syntaxString",
	comment: "syntaxComment",
	number: "syntaxNumber",
	plain: "text",
} as const;

/** Pull text worth scanning for paths out of session transcript entries. */
export function collectSessionTexts(entries: readonly unknown[]): string[] {
	const texts: string[] = [];
	let budget = MAX_SCAN_CHARS;
	for (const entry of entries) {
		const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
		if (!message || typeof message.role !== "string") continue;
		const chunks: string[] = [];
		const content = message.content;
		if (typeof content === "string") {
			chunks.push(content);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				const p = part as { type?: unknown; text?: unknown; arguments?: unknown };
				if (p.type === "text" && typeof p.text === "string") {
					chunks.push(p.text);
				} else if (p.type === "toolCall" && p.arguments !== undefined) {
					try {
						chunks.push(JSON.stringify(p.arguments));
					} catch {
						// Non-serializable arguments; skip.
					}
				}
			}
		}
		for (const chunk of chunks) {
			if (budget <= 0) return texts;
			const slice = chunk.length > budget ? chunk.slice(0, budget) : chunk;
			budget -= slice.length;
			texts.push(slice);
		}
	}
	return texts;
}

/** The list rows rendered inside the MouseRegion; coords are list-local. */
class PathList implements Component {
	private readonly items: PathRef[];
	private readonly focus: () => number;
	private readonly scrollTop: () => number;

	constructor(items: PathRef[], focus: () => number, scrollTop: () => number) {
		this.items = items;
		this.focus = focus;
		this.scrollTop = scrollTop;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (let row = 0; row < MAX_VISIBLE_ITEMS; row += 1) {
			const index = this.scrollTop() + row;
			const item = this.items[index];
			if (!item) break;
			const marker = index === this.focus() ? "▸ " : "  ";
			const label = `${item.raw}${item.isDirectory ? "/" : ""}`;
			lines.push(truncateToWidth(index === this.focus() ? `${marker}${label}` : `${marker}${label}`, width));
		}
		return lines;
	}

	invalidate(): void {}
}

/** Overlay component: session path list + preview, keyboard-first. */
class QuickPeekOverlay implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly kb: KeybindingsManager;
	private readonly items: PathRef[];
	private readonly done: (revealed: boolean) => void;
	private readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
	private focus = 0;
	private preview: PreviewModel | null = null;
	private viewStart: number | undefined;
	private imageComponent: Image | undefined;
	/** Row offset (in rendered lines) where the path list starts; -1 when hidden. */
	private listTop = -1;
	private listScrollTop = 0;
	private readonly previewDeps = defaultPreviewDeps();
	private readonly list: PathList;
	private readonly listRegion: MouseRegion;

	constructor(
		tui: TUI,
		theme: Theme,
		kb: KeybindingsManager,
		items: PathRef[],
		done: (revealed: boolean) => void,
		notify: (message: string, type?: "info" | "warning" | "error") => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.kb = kb;
		this.items = items;
		this.done = done;
		this.notify = notify;
		this.list = new PathList(
			items,
			() => this.focus,
			() => this.listScrollTop,
		);
		this.listRegion = new MouseRegion(this.list, (event) => this.onListMouse(event));
		this.refresh();
	}

	// ——— state ———————————————————————————————————————————————————————————

	private refresh(): void {
		const ref = this.items[this.focus];
		if (!ref) {
			this.preview = null;
			return;
		}
		this.preview = buildPreview(
			ref.path,
			{ line: ref.line, column: ref.column, window: PREVIEW_LINES, startLine: this.viewStart },
			this.previewDeps,
		);
		this.imageComponent = undefined;
	}

	private setFocus(index: number): void {
		const next = Math.min(Math.max(0, index), this.items.length - 1);
		if (next === this.focus) return;
		this.focus = next;
		this.viewStart = undefined;
		this.refresh();
		this.syncListScroll();
	}

	private scrollPreview(delta: number): void {
		if (!this.preview?.text) return;
		const current = this.viewStart ?? this.preview.text.start;
		const next = current + delta;
		this.viewStart = Math.min(Math.max(1, next), Math.max(1, this.preview.text.totalLines));
		this.refresh();
	}

	private syncListScroll(): void {
		if (this.focus < this.listScrollTop) this.listScrollTop = this.focus;
		if (this.focus >= this.listScrollTop + MAX_VISIBLE_ITEMS) {
			this.listScrollTop = this.focus - MAX_VISIBLE_ITEMS + 1;
		}
	}

	// ——— keyboard (primary path) —————————————————————————————————————————

	handleInput(data: string): void {
		if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
			this.done(false);
			return;
		}
		if (this.kb.matches(data, "tui.select.up")) {
			this.setFocus(this.focus - 1);
			return;
		}
		if (this.kb.matches(data, "tui.select.down")) {
			this.setFocus(this.focus + 1);
			return;
		}
		if (this.kb.matches(data, "tui.select.pageUp")) {
			this.scrollPreview(-PREVIEW_LINES);
			return;
		}
		if (this.kb.matches(data, "tui.select.pageDown")) {
			this.scrollPreview(PREVIEW_LINES);
			return;
		}
		if (this.kb.matches(data, "tui.select.confirm")) {
			void this.revealFocused();
		}
	}

	// ——— mouse (additive, fullscreen only) ———————————————————————————————

	private onListMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.tui.mode !== "fullscreen") return undefined;
		const index = this.listScrollTop + event.y;
		if (index < 0 || index >= this.items.length) return undefined;
		if (event.type === "move") {
			if (index !== this.focus) this.setFocus(index);
			return { handled: true, render: true };
		}
		if (event.type === "click" && event.button === "left") {
			this.setFocus(index);
			void this.revealFocused();
			return { handled: true };
		}
		return undefined;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.listTop < 0 || event.y < this.listTop) return undefined;
		// Retarget into the MouseRegion: its coordinates are list-local.
		const local: TuiMouseEvent = { ...event, y: event.y - this.listTop };
		return this.listRegion.handleMouse(local);
	}

	// ——— reveal ———————————————————————————————————————————————————————————

	private async revealFocused(): Promise<void> {
		const ref = this.items[this.focus];
		if (!ref) return;
		const platform: Platform = detectPlatform({ platform: process.platform, env: process.env });
		let windowsPath: string | undefined;
		if (platform === "wsl") {
			const wslDeps: WslExecDeps = {
				exec: (command, args) => execFile(command, args, { timeout: WSLPATH_TIMEOUT_MS }),
			};
			windowsPath = (await windowsPathViaWsl(ref.path, wslDeps)) ?? undefined;
		}
		const plan = revealPlan(platform, { path: ref.path, isDirectory: ref.isDirectory, windowsPath });
		if (!plan) {
			this.notify(`quick-peek: could not convert "${ref.path}" to a Windows path.`, "error");
			return;
		}
		const deps: RevealDeps = {
			spawn: (command, args) => spawn(command, args, { detached: true, stdio: "ignore" }),
		};
		const result = await reveal(plan, deps, { timeoutMs: REVEAL_TIMEOUT_MS });
		if (!result.ok) {
			this.notify(`quick-peek: ${plan.command} failed: ${result.error ?? "unknown error"}`, "error");
			return;
		}
		this.done(true);
	}

	// ——— rendering ———————————————————————————————————————————————————————

	invalidate(): void {
		this.listRegion.invalidate();
		this.imageComponent?.invalidate();
	}

	render(width: number): string[] {
		const th = this.theme;
		const ref = this.items[this.focus];
		const preview = this.preview;
		if (!ref || !preview) return [th.fg("muted", " quick-peek: nothing to show")];

		const lines: string[] = [];

		// Header: name (with :line:col) + path + kind · size · age.
		const title = `${preview.name}${ref.line ? `:${ref.line}${ref.column ? `:${ref.column}` : ""}` : ""}`;
		lines.push(truncateToWidth(` ${th.fg("accent", title)}  ${th.fg("muted", preview.kindLabel)}`, width));
		lines.push(
			truncateToWidth(
				` ${th.fg("muted", `${preview.path} · ${preview.sizeLabel} · ${preview.ageLabel}`)}`,
				width,
			),
		);
		if (preview.note) {
			lines.push(truncateToWidth(` ${th.fg("warning", preview.note)}`, width));
		}

		// Path list (only when there is more than one candidate).
		this.listTop = -1;
		if (this.items.length > 1) {
			lines.push("");
			this.listTop = lines.length;
			this.syncListScroll();
			lines.push(...this.listRegion.render(width));
		}

		lines.push("");

		// Preview body.
		if (preview.text) {
			const gutter = String(preview.text.totalLines).length;
			const rangeEnd = Math.min(preview.text.start + preview.text.lines.length - 1, preview.text.totalLines);
			lines.push(
				truncateToWidth(
					` ${th.fg("muted", `${preview.text.language} · lines ${preview.text.start}–${rangeEnd} of ${preview.text.totalLines}`)}`,
					width,
				),
			);
			for (const line of preview.text.lines) {
				const num = line.marked
					? th.fg("accent", String(line.number).padStart(gutter))
					: th.fg("muted", String(line.number).padStart(gutter));
				const marker = line.marked ? th.fg("accent", "❯") : " ";
				const body = this.highlight(line.text, preview.text.language);
				lines.push(truncateToWidth(`${marker}${num} ${body}`, width));
			}
		} else if (preview.image) {
			for (const line of this.renderImagePreview(preview, width)) lines.push(line);
		} else if (preview.directory) {
			lines.push(
				truncateToWidth(` ${th.fg("muted", `directory · ${preview.directory.total} entries`)}`, width),
			);
			for (const entry of preview.directory.entries) {
				lines.push(truncateToWidth(`   ${entry}`, width));
			}
		} else if (preview.kind === "binary") {
			lines.push(truncateToWidth(` ${th.fg("muted", "binary content — no preview")}`, width));
		}

		// Footer hints.
		lines.push(truncateToWidth(th.fg("muted", " ↑/↓ move · PgUp/PgDn scroll · Enter reveal · Esc close"), width));
		return lines;
	}

	private highlight(text: string, language: string): string {
		const th = this.theme;
		const spans: Span[] = highlightLine(text, language);
		return spans.map((s) => th.fg(STYLE_TOKENS[s.style], s.text)).join("");
	}

	private renderImagePreview(preview: PreviewModel, width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const image = preview.image;
		const dims = image?.width && image?.height ? ` ${image.width}×${image.height}px` : "";
		lines.push(truncateToWidth(` ${th.fg("muted", `${image?.mimeType ?? "image"}${dims}`)}`, width));

		const ref = this.items[this.focus];
		if (!ref) return lines;

		const capabilities = detectCapabilities();
		if (capabilities.images === null) {
			// Terminal cannot render inline images: documented text fallback.
			lines.push(` ${imageFallback(image?.mimeType ?? "image", undefined, preview.name)}`);
			return lines;
		}

		try {
			if (!this.imageComponent) {
				const stat = this.previewDeps.stat(ref.path);
				if (!stat || stat.size > MAX_IMAGE_BYTES) {
					lines.push(truncateToWidth(` ${th.fg("muted", "image too large to display inline")}`, width));
					return lines;
				}
				const imageTheme: ImageTheme = { fallbackColor: (s: string) => th.fg("muted", s) };
				this.imageComponent = new Image(
					readFileSync(ref.path).toString("base64"),
					image?.mimeType ?? "application/octet-stream",
					imageTheme,
					{ maxWidthCells: Math.max(10, width - 4), maxHeightCells: 16, filename: preview.name },
				);
			}
			for (const line of this.imageComponent.render(Math.max(10, width - 4))) lines.push(line);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lines.push(truncateToWidth(` ${th.fg("warning", `could not render image: ${message}`)}`, width));
		}
		return lines;
	}
}

/** The slice of ExtensionContext the peek UI actually needs. */
type PeekUiContext = Pick<ExtensionContext, "mode" | "cwd" | "sessionManager" | "ui">;

/** Resolve path refs from the session transcript (existing files only). */
function collectSessionRefs(ctx: PeekUiContext): PathRef[] {
	const resolution: PathResolutionContext = { cwd: ctx.cwd, root: ctx.cwd, home: homedir() };
	const entries = ctx.sessionManager.getEntries().slice(-MAX_SCAN_ENTRIES);
	const refs: PathRef[] = [];
	const seen = new Set<string>();
	for (const text of collectSessionTexts(entries)) {
		for (const ref of extractPaths(text, resolution)) {
			if (!ref.resolved) continue;
			const key = `${ref.path}:${ref.line ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			refs.push(ref);
			if (refs.length >= MAX_ITEMS) return refs;
		}
	}
	return refs;
}

export default function quickPeek(pi: ExtensionAPI): void {
	let activeHandle: OverlayHandle | null = null;

	/** HandleInput receives the base {@link ExtensionContext} (extension shortcuts). */
	async function openPeek(args: string, ctx: PeekUiContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`quick-peek needs a TUI session to show its overlay (current mode: ${ctx.mode}).`, "warning");
			return;
		}

		const resolution: PathResolutionContext = { cwd: ctx.cwd, root: ctx.cwd, home: homedir() };
		let items: PathRef[];
		if (args.trim().length > 0) {
			items = extractPaths(args, resolution).filter((ref) => ref.resolved);
			if (items.length === 0) {
				const raw = extractPaths(args, resolution)[0]?.raw ?? args.trim();
				ctx.ui.notify(`quick-peek: no such file or directory: ${raw}`, "error");
				return;
			}
		} else {
			items = collectSessionRefs(ctx);
			if (items.length === 0) {
				ctx.ui.notify("quick-peek: no file paths found in this session yet. Use /peek <path>.", "info");
				return;
			}
		}

		try {
			await ctx.ui.custom<boolean>(
				(tui, theme, kb, done) =>
					new QuickPeekOverlay(tui, theme, kb, items, done, (message, type) => ctx.ui.notify(message, type)),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "85%", minWidth: 60, maxHeight: "80%" },
					onHandle: (handle) => {
						activeHandle = handle;
					},
				},
			);
		} finally {
			activeHandle = null;
		}
	}

	pi.registerCommand("peek", {
		description: "Peek at a file (or a path found in this session) without opening it",
		handler: async (args, ctx) => {
			await openPeek(args, ctx);
		},
	});

	pi.registerShortcut(PEEK_SHORTCUT, {
		description: "Quick peek: preview a session file path in an overlay",
		handler: async (ctx) => {
			await openPeek("", ctx);
		},
	});

	// Nothing long-lived is held; the only cleanup is a still-open overlay.
	pi.on("session_shutdown", () => {
		if (!activeHandle) return;
		try {
			activeHandle.hide();
		} catch {
			// The overlay may already be gone.
		}
		activeHandle = null;
	});
}
