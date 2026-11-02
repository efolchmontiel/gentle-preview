/**
 * gentle-image-preview — pasted images become `[Image #N]` tokens.
 *
 * - Paste shortcut (default ctrl+shift+v) saves the clipboard image to a
 *   bounded temp cache, allocates the next image number for the session and
 *   inserts `[Image #N]` in the editor instead of a long path.
 * - The number→file mapping is persisted with `pi.appendEntry()` and rebuilt
 *   from the session branch on `session_start`, so tokens survive reloads.
 * - Before the text reaches the model, a trailing `[Image refs]` block maps
 *   every known token to its absolute path. Unknown tokens pass through
 *   untouched; the user's own body text is never dropped or rewritten.
 * - A chip band above the editor shows one chip per `[Image #N]` in the
 *   current draft. Hovering a chip reveals its real path (and an inline
 *   preview when the terminal supports images); clicking opens the file in
 *   the system viewer. Mouse input reaches the band only when Pi runs
 *   fullscreen — `/image-paths` is the always-available keyboard path.
 *
 * Clipboard reading degrades gracefully: when no platform backend can read an
 * image, the shortcut does nothing and Pi's own paste stays available.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { detectCapabilities, Image, MouseRegion, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, KeyId, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { readClipboardImage, type CommandRunner } from "../lib/clipboard.ts";
import { extensionForMime, savePasteToCache, sniffImage } from "../lib/images.ts";
import { buildOpenArgv, buildWslPathArgv, resolveOpenPlatform } from "../lib/open.ts";
import {
	IMAGE_REGISTRY_ENTRY_TYPE,
	ImageRegistry,
	rebuildSnapshotFromBranch,
	type ImageRef,
	type RegistrySnapshot,
} from "../lib/registry.ts";
import { appendImageRefs, formatToken, parseTokenNumbers } from "../lib/tokens.ts";

const DEFAULT_SHORTCUT = "ctrl+shift+v";
const OPEN_TIMEOUT_MS = 5000;
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const WIDGET_KEY = "gentle-image-preview";

/** Command runner handed to the clipboard reader; only runs on user actions. */
const runCommand: CommandRunner = (cmd, args, options) => {
	const result = spawnSync(cmd, args, { timeout: options.timeoutMs, maxBuffer: options.maxBuffer, windowsHide: true });
	if (result.error || result.status !== 0) return null;
	return { status: result.status, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0) };
};

interface Chip {
	ref: ImageRef;
	/** Visible-column range of the chip on the chip line. */
	start: number;
	end: number;
}

interface HoverInfo {
	ref: ImageRef;
	width: number;
	height: number;
	preview: Image | undefined;
}

function readBytes(path: string, maxBytes: number): Buffer | null {
	try {
		const bytes = readFileSync(path);
		return bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
	} catch {
		return null;
	}
}

/**
 * The chip band content: one chip per `[Image #N]` in the current draft, plus
 * the hovered chip's path and (when the terminal supports images) an inline
 * preview. Rendering is a pure function of the draft and the hover state.
 */
class ChipBand implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private chips: Chip[] = [];
	private hover: HoverInfo | undefined;
	private readonly theme: Theme;
	private readonly getRefs: () => ImageRef[];
	hoveredNumber: number | undefined;

	// Assigning in the body instead of using parameter properties keeps the file
	// loadable by strip-only TypeScript loaders, not just by Pi's jiti.
	constructor(theme: Theme, getRefs: () => ImageRef[]) {
		this.theme = theme;
		this.getRefs = getRefs;
	}

	/** Chip under the given band column, if any. */
	chipAt(x: number, y: number): Chip | undefined {
		if (y !== 0) return undefined;
		return this.chips.find((chip) => x >= chip.start && x < chip.end);
	}

	/** Recomputes the hover info (path, dimensions, optional preview) once per hover change. */
	setHover(ref: ImageRef | undefined): void {
		if (ref === undefined) {
			this.hover = undefined;
			return;
		}
		if (this.hover?.ref.number === ref.number) return;
		const bytes = readBytes(ref.path, PREVIEW_MAX_BYTES);
		const sniffed = bytes === null ? null : sniffImage(bytes);
		if (sniffed === null) {
			this.hover = { ref, width: 0, height: 0, preview: undefined };
			return;
		}
		const supportsImages = detectCapabilities().images !== null && bytes !== null;
		this.hover = {
			ref,
			width: sniffed.width,
			height: sniffed.height,
			preview: supportsImages
				? new Image(
						bytes.toString("base64"),
						ref.mimeType,
						{ fallbackColor: (s) => this.theme.fg("dim", s) },
						{ maxWidthCells: 40, maxHeightCells: 8, filename: basename(ref.path) },
					)
				: undefined,
		};
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		const refs = this.getRefs();
		if (refs.length === 0) {
			this.chips = [];
			this.cachedLines = [];
			this.cachedWidth = width;
			return [];
		}
		const th = this.theme;
		const chips: Chip[] = [];
		let chipLine = "";
		let column = 0;
		for (const ref of refs) {
			const token = formatToken(ref.number);
			const name = basename(ref.path);
			const start = column;
			chipLine += `${th.fg("accent", token)} ${th.fg("muted", name)}  `;
			column += token.length + 1 + name.length;
			chips.push({ ref, start, end: column });
			column += 2; // separator
		}
		this.chips = chips;

		const lines = [truncateToWidth(chipLine.trimEnd(), width)];
		const hover = this.hover;
		if (hover !== undefined) {
			const dims = hover.width > 0 ? ` (${hover.width}x${hover.height} px)` : "";
			lines.push(
				truncateToWidth(`  ${th.fg("dim", `${formatToken(hover.ref.number)} = ${hover.ref.path}${dims}`)}`, width),
			);
			const preview = hover.preview;
			if (preview !== undefined) lines.push(...preview.render(width));
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const registry = new ImageRegistry();
	const activeChildren = new Set<ReturnType<typeof spawn>>();

	/** Opens an image in the system viewer; only ever runs on an explicit click. */
	const openInViewer = (ctx: ExtensionContext, ref: ImageRef): void => {
		const platform = resolveOpenPlatform(process.platform, process.env);
		let windowsPath: string | undefined;
		if (platform === "wsl") {
			const conversion = buildWslPathArgv(ref.path);
			const result = runCommand(conversion.cmd, conversion.args, { timeoutMs: 2000, maxBuffer: 64 * 1024 });
			if (result === null) {
				ctx.ui.notify(`Could not convert ${ref.path} to a Windows path`, "warning");
				return;
			}
			windowsPath = result.stdout.toString("utf8").trim();
		}
		const command = buildOpenArgv(platform, ref.path, windowsPath);
		if (command === null) {
			ctx.ui.notify(`No image viewer available for ${ref.path}`, "warning");
			return;
		}
		try {
			// Launcher commands (open / start / xdg-open) exit immediately after
			// handing off to the system viewer. Bounded timeout, tracked for cleanup.
			const child = spawn(command.cmd, command.args, { stdio: "ignore", timeout: OPEN_TIMEOUT_MS });
			activeChildren.add(child);
			child.once("exit", () => activeChildren.delete(child));
			child.once("error", () => activeChildren.delete(child));
		} catch (error) {
			ctx.ui.notify(`Could not open ${ref.path}: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	/** Reads the clipboard image and pastes a token; does nothing when unreadable. */
	const pasteFromClipboard = (ctx: ExtensionContext): void => {
		const image = readClipboardImage(runCommand, process.platform, process.env);
		if (image === null) return;
		const extension = extensionForMime(image.mimeType) ?? "png";
		const path = savePasteToCache(image.bytes, extension);
		if (path === null) {
			ctx.ui.notify("gentle-image-preview: could not save the pasted image", "error");
			return;
		}
		const ref = registry.allocate(path, image.mimeType);
		pi.appendEntry(IMAGE_REGISTRY_ENTRY_TYPE, registry.snapshot());
		ctx.ui.pasteToEditor(formatToken(ref.number));
	};

	pi.on("session_start", async (_event, ctx) => {
		// Rebuild from the branch: only our own entries, newest valid snapshot wins.
		registry.resetFrom(ImageRegistry.fromSnapshot(rebuildSnapshotFromBranch(ctx.sessionManager.getBranch())));

		// Shortcut override is read once per session start. Pointing the
		// shortcut at ctrl+v opts into replacing Pi's built-in paste.
		const configured = process.env.GENTLE_IMAGE_PREVIEW_SHORTCUT?.trim();
		const shortcut = (configured !== undefined && configured !== "" ? configured : DEFAULT_SHORTCUT) as KeyId;
		pi.registerShortcut(shortcut, {
			description: "Paste clipboard image as [Image #N] (gentle-image-preview)",
			handler: (shortcutCtx) => pasteFromClipboard(shortcutCtx),
		});

		if (ctx.mode !== "tui") return;

		const inner = new ChipBand(ctx.ui.theme, () => currentDraftRefs(ctx, registry));
		const onMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
			if (event.type === "move" || event.type === "drag") {
				const chip = inner.chipAt(event.x, event.y);
				inner.setHover(chip?.ref);
				const changed = inner.hoveredNumber !== chip?.ref?.number;
				inner.hoveredNumber = chip?.ref?.number;
				inner.invalidate();
				return { handled: true, render: changed };
			}
			if (event.type === "click" && event.button === "left") {
				const chip = inner.chipAt(event.x, event.y);
				if (chip === undefined) return undefined;
				openInViewer(ctx, chip.ref);
				return { handled: true };
			}
			return undefined;
		};
		ctx.ui.setWidget(
			WIDGET_KEY,
			() => new MouseRegion(inner, onMouse),
			{ placement: "aboveEditor" },
		);
	});

	pi.on("input", (event) => {
		if (event.source === "extension") return { action: "continue" };
		const numbers = parseTokenNumbers(event.text);
		if (numbers.length === 0) return { action: "continue" };
		const refs: Array<{ number: number; path: string }> = [];
		for (const n of numbers) {
			const ref = registry.get(n);
			if (ref !== undefined) refs.push({ number: n, path: ref.path });
		}
		if (refs.length === 0) return { action: "continue" };
		return { action: "transform", text: appendImageRefs(event.text, refs) };
	});

	// Keyboard path when the mouse band is unavailable (regular mode).
	pi.registerCommand("image-paths", {
		description: "List every [Image #N] token and its file path",
		handler: async (_args, ctx) => {
			const refs = registry.all();
			if (refs.length === 0) {
				ctx.ui.notify("No images pasted in this session yet", "info");
				return;
			}
			ctx.ui.notify(refs.map((ref) => `${formatToken(ref.number)} = ${ref.path}`).join("\n"), "info");
		},
	});

	// Transcript rendering for the persisted registry snapshots.
	pi.registerEntryRenderer<RegistrySnapshot>(IMAGE_REGISTRY_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const images = entry.data?.images ?? [];
		if (images.length === 0) {
			return new Text(theme.fg("dim", "[image-preview] empty registry"), 0, 0);
		}
		const text = images
			.map((ref) => `${formatToken(ref.number)} ${basename(ref.path)}${expanded ? ` — ${ref.path}` : ""}`)
			.join("\n");
		return new Text(theme.fg("muted", text), 0, 0);
	});

	pi.on("session_shutdown", async () => {
		// Idempotent cleanup: kill() on an exited child is a no-op.
		for (const child of activeChildren) {
			try {
				child.kill();
			} catch {
				// Already gone.
			}
		}
		activeChildren.clear();
	});
}

/** Refs for the tokens present in the current editor draft, in draft order. */
function currentDraftRefs(ctx: ExtensionContext, registry: ImageRegistry): ImageRef[] {
	let draft: string;
	try {
		draft = ctx.ui.getEditorText();
	} catch {
		return [];
	}
	const refs: ImageRef[] = [];
	for (const n of parseTokenNumbers(draft)) {
		const ref = registry.get(n);
		if (ref !== undefined) refs.push(ref);
	}
	return refs;
}
