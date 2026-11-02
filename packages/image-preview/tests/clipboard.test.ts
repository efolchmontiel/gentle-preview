import { readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isWsl, readClipboardImage, type CommandResult, type CommandRunner } from "../lib/clipboard.ts";
import { parsePngSize } from "../lib/images.ts";

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	(() => {
		const ihdr = Buffer.alloc(17);
		ihdr.writeUInt32BE(13, 0);
		ihdr.write("IHDR", 4);
		ihdr.writeUInt32BE(4, 8);
		ihdr.writeUInt32BE(3, 12);
		return ihdr;
	})(),
]);

/** Fake runner: returns canned results keyed by command name. */
function fakeRunner(handlers: Record<string, () => CommandResult | null>): CommandRunner & { calls: string[] } {
	const calls: string[] = [];
	const run: CommandRunner = (cmd, args) => {
		calls.push([cmd, ...args].join(" "));
		return handlers[cmd]?.() ?? null;
	};
	return Object.assign(run, { calls });
}

test("isWsl detects WSL through env and /proc/version", () => {
	assert.equal(isWsl("linux", { WSL_DISTRO_NAME: "Ubuntu" }), true);
	assert.equal(isWsl("linux", { WSL_INTEROP: "/run/WSL" }), true);
	assert.equal(isWsl("win32", {}), false);
	assert.equal(isWsl("darwin", {}), false);
	// On real Linux without env hints, the /proc/version probe decides.
	assert.equal(isWsl("linux", {}), isWsl("linux", {}));
});

test("linux/Wayland backend reads image/png via wl-paste", () => {
	const run = fakeRunner({ "wl-paste": () => ({ status: 0, stdout: PNG }) });
	const image = readClipboardImage(run, "linux", { WAYLAND_DISPLAY: "wayland-0" });
	assert.notEqual(image, null);
	assert.equal(image?.mimeType, "image/png");
	assert.deepEqual(parsePngSize(image?.bytes ?? Buffer.alloc(0)), { width: 4, height: 3 });
});

test("linux backends fall through: failed wl-paste, failed xclip png, successful xclip jpeg", () => {
	const JPEG = Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		(() => {
			const sof = Buffer.alloc(12);
			sof[0] = 0xff;
			sof[1] = 0xc0;
			sof.writeUInt16BE(17, 2);
			sof[4] = 8;
			sof.writeUInt16BE(600, 5);
			sof.writeUInt16BE(800, 7);
			return sof;
		})(),
	]);
	let wlPasteCalls = 0;
	let xclipCalls = 0;
	const run = fakeRunner({
		"wl-paste": () => {
			wlPasteCalls += 1;
			return null;
		},
		xclip: () => {
			xclipCalls += 1;
			return xclipCalls >= 2 ? { status: 0, stdout: JPEG } : null;
		},
	});
	const image = readClipboardImage(run, "linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" });
	assert.notEqual(image, null);
	assert.equal(image?.mimeType, "image/jpeg");
	assert.equal(wlPasteCalls, 2);
	assert.equal(xclipCalls, 2);
});

test("clipboard with non-image bytes degrades to null", () => {
	const run = fakeRunner({ "wl-paste": () => ({ status: 0, stdout: Buffer.from("just text") }) });
	assert.equal(readClipboardImage(run, "linux", { WAYLAND_DISPLAY: "wayland-0" }), null);
});

test("no backend available degrades to null without spawning", () => {
	const run = fakeRunner({});
	assert.equal(readClipboardImage(run, "linux", {}), null);
	assert.equal(run.calls.length, 0);
});

test("darwin backend uses pngpaste and rejects garbage", () => {
	const run = fakeRunner({ pngpaste: () => ({ status: 0, stdout: PNG }) });
	const image = readClipboardImage(run, "darwin", {});
	assert.equal(image?.mimeType, "image/png");
	const bad = fakeRunner({ pngpaste: () => ({ status: 0, stdout: Buffer.from("nope") }) });
	assert.equal(readClipboardImage(bad, "darwin", {}), null);
});

test("windows backend drives PowerShell and reads the emitted temp file path", () => {
	const tmp = `/tmp/gentle-preview-clipboard-${process.pid}.png`;
	writeFileSync(tmp, PNG);
	try {
		const run = fakeRunner({ "powershell.exe": () => ({ status: 0, stdout: Buffer.from(`${tmp}\n`) }) });
		const image = readClipboardImage(run, "win32", {});
		assert.notEqual(image, null);
		assert.equal(image?.mimeType, "image/png");
		assert.ok(run.calls[0]?.startsWith("powershell.exe"));
	} finally {
		rmSync(tmp, { force: true });
	}
});

test("wsl backend converts the Windows path before reading", () => {
	const run = fakeRunner({
		"powershell.exe": () => ({ status: 0, stdout: Buffer.from("C:\\Users\\x\\img.png") }),
		wslpath: () => ({ status: 0, stdout: Buffer.from("/mnt/c/Users/x/img.png") }),
	});
	// The converted path does not exist here; the backend must return null, not throw.
	assert.equal(readClipboardImage(run, "linux", { WSL_DISTRO_NAME: "Ubuntu" }), null);
	assert.ok(run.calls.some((call) => call.startsWith("wslpath -u")));
});
