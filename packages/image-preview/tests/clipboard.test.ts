import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isWsl,
	parseCopiedFilePaths,
	quoteForShell,
	readClipboard,
	type ClipboardContent,
	type CommandResult,
	type CommandRunner,
} from "../lib/clipboard.ts";
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

/** Fake runner: every answer comes from `handle`, keyed by command + argv. */
function fakeRunner(handle: (cmd: string, args: string[]) => CommandResult | null): CommandRunner & { calls: string[] } {
	const calls: string[] = [];
	const run: CommandRunner = (cmd, args) => {
		calls.push([cmd, ...args].join(" "));
		return handle(cmd, args);
	};
	return Object.assign(run, { calls });
}

const ok = (stdout: Buffer | string): CommandResult => ({ status: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout) });

/** True when the PowerShell command line contains the given fragment. */
const ps = (fragment: string) => (cmd: string, args: string[]) =>
	cmd === "powershell.exe" && args.some((arg) => arg.includes(fragment));

type ClipboardBranch = "image" | "files" | "text";

interface Scenario {
	/** Injected platform; the test host's real platform is never consulted. */
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** Clipboard command handlers per branch of this scenario. */
	branch: Record<ClipboardBranch, (cmd: string, args: string[]) => CommandResult | null>;
	/** Every clipboard command fails: the empty / broken clipboard case. */
	failing: (cmd: string, args: string[]) => CommandResult | null;
	/** Clipboard whose only image payload is garbage: must fall through to text. */
	garbageThenText: (cmd: string, args: string[]) => CommandResult | null;
}

interface LinuxBranch {
	/** What the clipboard advertises. */
	types: string;
	/** Bytes per advertised type. */
	reads: Record<string, Buffer | string>;
}

function linuxRunner(branch: LinuxBranch): (cmd: string, args: string[]) => CommandResult | null {
	return (cmd, args) => {
		if (cmd === "wl-paste") {
			if (args.includes("--list-types")) return ok(branch.types);
			const type = args[args.indexOf("--type") + 1];
			const read = type === undefined ? null : branch.reads[type];
			return read === undefined || read === null ? null : ok(read);
		}
		return null;
	};
}

function xclipRunner(branch: LinuxBranch): (cmd: string, args: string[]) => CommandResult | null {
	return (cmd, args) => {
		if (cmd !== "xclip") return null;
		if (args.includes("TARGETS")) return ok(branch.types);
		const index = args.indexOf("-t");
		const type = index === -1 ? undefined : args[index + 1];
		const read = type === undefined || type === "TARGETS" ? null : branch.reads[type];
		return read === undefined || read === null ? null : ok(read);
	};
}

/** A real local file so the Windows image backend can read the emitted path. */
function tempPng(): string {
	const path = join(tmpdir(), `gentle-preview-clipboard-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
	writeFileSync(path, PNG);
	return path;
}

const darwinImage = (cmd: string) => (cmd === "pngpaste" ? ok(PNG) : null);
const darwinText = (cmd: string) => (cmd === "pngpaste" ? null : cmd === "pbpaste" ? ok("hello from darwin") : null);
const darwinEmpty = (cmd: string) => (cmd === "pbpaste" ? ok("") : null);
const darwinFailing = () => null;

function windowsFiles(): (cmd: string, args: string[]) => CommandResult | null {
	return (cmd, args) => {
		if (ps("FileDropList")(cmd, args)) return ok("C:\\Users\\me\\a.png\nC:\\Users\\me\\b.png");
		return null;
	};
}

function windowsImage(): (cmd: string, args: string[]) => CommandResult | null {
	const temp = tempPng();
	return (cmd, args) => {
		if (ps("FileDropList")(cmd, args)) return null;
		if (ps("GetImage")(cmd, args)) return ok(`${temp}\n`);
		return null;
	};
}

function windowsText(): (cmd: string, args: string[]) => CommandResult | null {
	return (cmd, args) => {
		if (ps("FileDropList")(cmd, args)) return null;
		if (ps("GetImage")(cmd, args)) return null;
		if (ps("Get-Clipboard -Raw")(cmd, args)) return ok("hello from windows\n");
		return null;
	};
}

const windowsFailing = (): ((cmd: string, args: string[]) => CommandResult | null) => () => null;

/** WSL: PowerShell answers, and every emitted Windows path goes through wslpath. */
function wslConvert(converts: boolean): (cmd: string, args: string[]) => CommandResult | null {
	return (cmd, args) => {
		if (cmd === "wslpath") {
			if (!converts) return null;
			const path = args[args.indexOf("-u") + 1] ?? "";
			// Real `wslpath -u` output: POSIX separators, /mnt/c prefix.
			return ok(path.replaceAll("\\", "/").replace("C:/Users/me", "/mnt/c/Users/me"));
		}
		return null;
	};
}

function withWslConversion(
	viaInterop: (cmd: string, args: string[]) => CommandResult | null,
): (cmd: string, args: string[]) => CommandResult | null {
	const convert = wslConvert(true);
	return (cmd, args) => viaInterop(cmd, args) ?? convert(cmd, args);
}

const SCENARIOS: Record<string, Scenario> = {
	"linux-wayland": {
		platform: "linux",
		env: { WAYLAND_DISPLAY: "wayland-0" },
		branch: {
			image: linuxRunner({
				types: "image/png\ntext/plain;charset=utf-8",
				reads: { "image/png": PNG },
			}),
			files: linuxRunner({
				types: "x-special/gnome-copied-files\ntext/plain;charset=utf-8",
				reads: { "x-special/gnome-copied-files": "copy\nfile:///home/me/a%20b.png\nfile:///home/me/b.png" },
			}),
			text: linuxRunner({
				types: "text/plain;charset=utf-8",
				reads: { "text/plain;charset=utf-8": "hello from wayland" },
			}),
		},
		failing: () => null,
		garbageThenText: linuxRunner({
			types: "image/png\ntext/plain;charset=utf-8",
			reads: { "image/png": "not an image", "text/plain;charset=utf-8": "plain after garbage" },
		}),
	},
	"linux-x11": {
		platform: "linux",
		env: { DISPLAY: ":0" },
		branch: {
			image: xclipRunner({
				types: "image/png\ntext/plain;charset=utf-8",
				reads: { "image/png": PNG },
			}),
			files: xclipRunner({
				types: "x-special/gnome-copied-files\ntext/plain;charset=utf-8",
				reads: { "x-special/gnome-copied-files": "copy\nfile:///home/me/a%20b.png\nfile:///home/me/b.png" },
			}),
			text: xclipRunner({
				types: "text/plain;charset=utf-8",
				reads: { "text/plain;charset=utf-8": "hello from x11" },
			}),
		},
		failing: () => null,
		garbageThenText: xclipRunner({
			types: "image/png\ntext/plain;charset=utf-8",
			reads: { "image/png": "not an image", "text/plain;charset=utf-8": "plain after garbage" },
		}),
	},
	darwin: {
		platform: "darwin",
		env: {},
		branch: {
			image: darwinImage,
			// Copied files are not covered on macOS: the clipboard reads as text.
			files: darwinText,
			text: darwinText,
		},
		failing: darwinFailing,
		garbageThenText: darwinText,
	},
	win32: {
		platform: "win32",
		env: {},
		branch: {
			image: windowsImage(),
			files: windowsFiles(),
			text: windowsText(),
		},
		failing: windowsFailing(),
		garbageThenText: windowsText(),
	},
	wsl: {
		platform: "linux",
		env: { WSL_DISTRO_NAME: "Ubuntu" },
		branch: {
			image: withWslConversion(windowsImage()),
			files: withWslConversion(windowsFiles()),
			text: withWslConversion(windowsText()),
		},
		failing: windowsFailing(),
		garbageThenText: withWslConversion(windowsText()),
	},
};

function read(scenario: Scenario, run: CommandRunner): ClipboardContent | null {
	return readClipboard(run, scenario.platform, scenario.env);
}

for (const [name, scenario] of Object.entries(SCENARIOS)) {
	// Every branch below runs for every scenario on every host platform: the
	// platform is injected, nothing is skipped and process.platform is unused.

	test(`[${name}] image payload is read and sniffed`, () => {
		const run = fakeRunner(scenario.branch.image);
		const content = read(scenario, run);
		assert.equal(content?.kind, "image");
		if (content?.kind !== "image") return;
		assert.equal(content.image.mimeType, "image/png");
		assert.deepEqual(parsePngSize(content.image.bytes), { width: 4, height: 3 });
	});

	test(`[${name}] copied file paths are returned one per line`, () => {
		const run = fakeRunner(scenario.branch.files);
		const content = read(scenario, run);
		if (scenario.platform === "darwin") {
			// macOS has no covered file-path route: the clipboard reads as text.
			assert.equal(content?.kind, "text");
			return;
		}
		assert.equal(content?.kind, "files");
		if (content?.kind !== "files") return;
		const expected = scenario.platform === "win32"
			? ["C:\\Users\\me\\a.png", "C:\\Users\\me\\b.png"]
			: scenario.platform === "linux" && scenario.env.WSL_DISTRO_NAME !== undefined
				? ["/mnt/c/Users/me/a.png", "/mnt/c/Users/me/b.png"]
				: ["/home/me/a b.png", "/home/me/b.png"];
		assert.deepEqual(content.paths, expected);
	});

	test(`[${name}] plain text is the fallback`, () => {
		const run = fakeRunner(scenario.branch.text);
		const content = read(scenario, run);
		assert.equal(content?.kind, "text");
		if (content?.kind !== "text") return;
		assert.ok(content.text.startsWith("hello from "));
	});

	test(`[${name}] unreadable or empty clipboard yields null`, () => {
		const run = fakeRunner(scenario.failing);
		assert.equal(read(scenario, run), null);
	});

	test(`[${name}] empty payloads never paste anything`, () => {
		const run = fakeRunner(scenario.failing);
		assert.equal(read(scenario, run), null);
		if (scenario.platform === "darwin") {
			// pbpaste succeeds with empty stdout: still nothing to paste.
			const empty = fakeRunner(darwinEmpty);
			assert.equal(readClipboard(empty, "darwin", {}), null);
		}
	});

	test(`[${name}] a failing command degrades to null`, () => {
		const run = fakeRunner(scenario.failing);
		assert.equal(read(scenario, run), null);
		assert.ok(run.calls.length > 0);
	});

	test(`[${name}] garbage image bytes fall through to text`, () => {
		const run = fakeRunner(scenario.garbageThenText);
		const content = read(scenario, run);
		assert.equal(content?.kind, "text");
	});
}

// --- Platform specifics ------------------------------------------------------

test("linux/Wayland reads the advertised image type via wl-paste", () => {
	const run = fakeRunner((cmd, args) => {
		if (cmd !== "wl-paste") return null;
		if (args.includes("--list-types")) return ok("text/plain;charset=utf-8\nimage/png");
		if (args.includes("image/png")) return ok(PNG);
		return null;
	});
	const content = readClipboard(run, "linux", { WAYLAND_DISPLAY: "wayland-0" });
	assert.equal(content?.kind, "image");
	assert.ok(run.calls.some((call) => call.startsWith("wl-paste --list-types")));
	assert.ok(run.calls.some((call) => call.includes("--type image/png")));
});

test("linux/Wayland prefers file lists over text and images over files", () => {
	const order: string[] = [];
	const run = fakeRunner((cmd, args) => {
		if (cmd !== "wl-paste") return null;
		if (args.includes("--list-types")) {
			return ok("text/plain\nx-special/gnome-copied-files\nimage/png");
		}
		const type = args[args.indexOf("--type") + 1] ?? "";
		order.push(type);
		if (type === "image/png") return ok(PNG);
		if (type === "x-special/gnome-copied-files") return ok("copy\nfile:///home/me/x.png");
		return ok("some text");
	});
	const content = readClipboard(run, "linux", { WAYLAND_DISPLAY: "wayland-0" });
	assert.equal(content?.kind, "image");
	assert.deepEqual(order, ["image/png"]);
});

test("linux/Wayland WL_DISPLAY alone selects the Wayland backend", () => {
	const run = fakeRunner((cmd, args) => {
		if (cmd !== "wl-paste") return null;
		if (args.includes("--list-types")) return ok("text/plain");
		return ok("hello");
	});
	const content = readClipboard(run, "linux", { WL_DISPLAY: "wayland-1" });
	assert.equal(content?.kind, "text");
});

test("linux/X11 uses xclip TARGETS and reads by type", () => {
	const run = fakeRunner((cmd, args) => {
		if (cmd !== "xclip") return null;
		if (args.includes("TARGETS")) return ok("image/png");
		if (args.includes("image/png")) return ok(PNG);
		return null;
	});
	const content = readClipboard(run, "linux", { DISPLAY: ":0" });
	assert.equal(content?.kind, "image");
	assert.ok(run.calls.some((call) => call.startsWith("xclip -selection clipboard -t TARGETS -o")));
});

test("linux/X11 gnome-copied-files yields decoded paths", () => {
	const run = fakeRunner((cmd, args) => {
		if (cmd !== "xclip") return null;
		if (args.includes("TARGETS")) return ok("x-special/gnome-copied-files");
		if (args.includes("x-special/gnome-copied-files")) return ok("copy\nfile:///home/me/a%20b.png");
		return null;
	});
	const content = readClipboard(run, "linux", { DISPLAY: ":0" });
	assert.deepEqual(content, { kind: "files", paths: ["/home/me/a b.png"] });
});

test("linux with no display spawns nothing", () => {
	const run = fakeRunner(() => null);
	assert.equal(readClipboard(run, "linux", {}), null);
	assert.equal(run.calls.length, 0);
});

test("darwin reads an image through pngpaste and text through pbpaste", () => {
	const image = fakeRunner(darwinImage);
	assert.equal(readClipboard(image, "darwin", {})?.kind, "image");
	const text = fakeRunner(darwinText);
	const content = readClipboard(text, "darwin", {});
	assert.equal(content?.kind, "text");
	if (content?.kind === "text") assert.equal(content.text, "hello from darwin");
});

test("darwin empty pbpaste pastes nothing", () => {
	const run = fakeRunner(darwinEmpty);
	assert.equal(readClipboard(run, "darwin", {}), null);
});

test("windows orders FileDropList, then image, then text", () => {
	const run = fakeRunner(windowsText());
	readClipboard(run, "win32", {});
	const order = run.calls.map((call) =>
		call.includes("FileDropList") ? "files" : call.includes("GetImage") ? "image" : "text",
	);
	assert.deepEqual(order, ["files", "image", "text"]);
});

test("windows text read strips the trailing PowerShell newline", () => {
	const run = fakeRunner(windowsText());
	const content = readClipboard(run, "win32", {});
	assert.deepEqual(content, { kind: "text", text: "hello from windows" });
});

test("windows file paths are not converted when the platform is win32", () => {
	const run = fakeRunner(windowsFiles());
	const content = readClipboard(run, "win32", {});
	assert.deepEqual(content, { kind: "files", paths: ["C:\\Users\\me\\a.png", "C:\\Users\\me\\b.png"] });
	assert.ok(run.calls.every((call) => !call.startsWith("wslpath")));
});

test("wsl converts file paths through wslpath -u", () => {
	const interop = windowsFiles();
	const run = fakeRunner((cmd, args) => interop(cmd, args) ?? wslConvert(true)(cmd, args));
	const content = readClipboard(run, "linux", { WSL_DISTRO_NAME: "Ubuntu" });
	assert.deepEqual(content, { kind: "files", paths: ["/mnt/c/Users/me/a.png", "/mnt/c/Users/me/b.png"] });
	assert.ok(run.calls.some((call) => call.startsWith("wslpath -u")));
});

test("wsl keeps the raw Windows path when wslpath fails, instead of swallowing the paste", () => {
	const interop = windowsFiles();
	const run = fakeRunner((cmd, args) => interop(cmd, args) ?? wslConvert(false)(cmd, args));
	const content = readClipboard(run, "linux", { WSL_DISTRO_NAME: "Ubuntu" });
	assert.deepEqual(content, { kind: "files", paths: ["C:\\Users\\me\\a.png", "C:\\Users\\me\\b.png"] });
});

test("wsl image route converts the emitted temp path before reading", () => {
	const temp = join(tmpdir(), `gentle-preview-clipboard-${process.pid}-wsl.png`);
	writeFileSync(temp, PNG);
	try {
		const run = fakeRunner((cmd, args) => {
			if (cmd === "powershell.exe") {
				if (args.some((arg) => arg.includes("FileDropList"))) return null;
				return ok("C:\\Users\\x\\img.png\n");
			}
			if (cmd === "wslpath") return ok(`${temp}\n`);
			return null;
		});
		const content = readClipboard(run, "linux", { WSL_DISTRO_NAME: "Ubuntu" });
		assert.equal(content?.kind, "image");
		assert.deepEqual(parsePngSize(content?.kind === "image" ? content.image.bytes : Buffer.alloc(0)), { width: 4, height: 3 });
		assert.ok(run.calls.some((call) => call.startsWith("wslpath -u")));
	} finally {
		rmSync(temp, { force: true });
	}
});

test("wsl with no reachable PowerShell degrades to null", () => {
	const run = fakeRunner(() => null);
	assert.equal(readClipboard(run, "linux", { WSL_DISTRO_NAME: "Ubuntu" }), null);
});

// --- Unit helpers ------------------------------------------------------------

test("isWsl detects WSL through env and /proc/version", () => {
	assert.equal(isWsl("linux", { WSL_DISTRO_NAME: "Ubuntu" }), true);
	assert.equal(isWsl("linux", { WSL_INTEROP: "/run/WSL" }), true);
	assert.equal(isWsl("win32", {}), false);
	assert.equal(isWsl("darwin", {}), false);
	// On real Linux without env hints, the /proc/version probe decides.
	assert.equal(isWsl("linux", {}), isWsl("linux", {}));
});

test("parseCopiedFilePaths decodes file URIs and drops the copy marker", () => {
	assert.deepEqual(
		parseCopiedFilePaths("copy\nfile:///home/me/a%20b.png\nfile:///home/me/b.png"),
		["/home/me/a b.png", "/home/me/b.png"],
	);
});

test("parseCopiedFilePaths skips non-file URIs, comments and control characters", () => {
	assert.deepEqual(parseCopiedFilePaths("# header\nhttps://example.com/x"), []);
	assert.deepEqual(parseCopiedFilePaths("copy\nfile://server/share/x.png"), []);
	// A control character means the payload is not a plain path list: refuse it all.
	assert.deepEqual(parseCopiedFilePaths("file:///home/me/a.png\n\u0000"), []);
	assert.deepEqual(parseCopiedFilePaths(""), []);
});

test("quoteForShell quotes only what a shell would mangle", () => {
	assert.equal(quoteForShell("/home/me/pic.png"), "/home/me/pic.png");
	assert.equal(quoteForShell("/home/me/a b.png"), "'/home/me/a b.png'");
	assert.equal(quoteForShell("/home/me/it's.png"), "'/home/me/it'\\''s.png'");
});

test("files read from the real tmpdir keep the gentle-preview prefix discipline", () => {
	// The Windows image backend reads the temp file it is told about; this only
	// asserts the test fixture itself stays under os.tmpdir()/gentle-preview-*.
	const temp = tempPng();
	try {
		assert.ok(temp.startsWith(tmpdir()));
		assert.ok(temp.includes("gentle-preview-"));
		assert.notEqual(parsePngSize(readFileSync(temp)), null);
	} finally {
		rmSync(temp, { force: true });
	}
});
