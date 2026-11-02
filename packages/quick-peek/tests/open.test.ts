import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
	detectPlatform,
	revealPlan,
	reveal,
	windowsPathViaWsl,
	type RevealDeps,
	type Spawned,
} from "../lib/open.ts";

describe("detectPlatform", () => {
	it("detects WSL from WSL_DISTRO_NAME on linux", () => {
		assert.equal(
			detectPlatform({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } }),
			"wsl",
		);
	});

	it("detects WSL from WSL_INTEROP on linux", () => {
		assert.equal(
			detectPlatform({ platform: "linux", env: { WSL_INTEROP: "/run/WSL/123" } }),
			"wsl",
		);
	});

	it("returns plain linux without WSL markers (omarchy included)", () => {
		assert.equal(detectPlatform({ platform: "linux", env: {} }), "linux");
	});

	it("returns win32 and darwin verbatim", () => {
		assert.equal(detectPlatform({ platform: "win32", env: {} }), "win32");
		assert.equal(detectPlatform({ platform: "darwin", env: {} }), "darwin");
	});
});

describe("revealPlan", () => {
	it("uses open -R to reveal a file on macOS", () => {
		assert.deepEqual(revealPlan("darwin", { path: "/a/b.txt", isDirectory: false }), {
			command: "open",
			args: ["-R", "/a/b.txt"],
		});
	});

	it("uses open for a directory on macOS", () => {
		assert.deepEqual(revealPlan("darwin", { path: "/a/b", isDirectory: true }), {
			command: "open",
			args: ["/a/b"],
		});
	});

	it("uses explorer /select, for a file on Windows", () => {
		assert.deepEqual(
			revealPlan("win32", { path: "C:\\a\\b.txt", isDirectory: false }),
			{ command: "explorer", args: ["/select,C:\\a\\b.txt"] },
		);
	});

	it("uses explorer for a directory on Windows", () => {
		assert.deepEqual(revealPlan("win32", { path: "C:\\a\\b", isDirectory: true }), {
			command: "explorer",
			args: ["C:\\a\\b"],
		});
	});

	it("uses explorer.exe with the converted Windows path under WSL", () => {
		assert.deepEqual(
			revealPlan("wsl", {
				path: "/home/dev/b.txt",
				isDirectory: false,
				windowsPath: "\\\\wsl$\\Ubuntu\\home\\dev\\b.txt",
			}),
			{
				command: "explorer.exe",
				args: ["/select,\\\\wsl$\\Ubuntu\\home\\dev\\b.txt"],
			},
		);
	});

	it("requires a Windows path under WSL", () => {
		assert.equal(revealPlan("wsl", { path: "/home/dev/b.txt", isDirectory: false }), null);
	});

	it("opens the containing directory with xdg-open on Linux (documented fallback)", () => {
		assert.deepEqual(revealPlan("linux", { path: "/a/b/c.txt", isDirectory: false }), {
			command: "xdg-open",
			args: ["/a/b"],
		});
		assert.deepEqual(revealPlan("linux", { path: "/a/b", isDirectory: true }), {
			command: "xdg-open",
			args: ["/a/b"],
		});
	});
});

describe("reveal runner", () => {
	function fakeSpawned(): Spawned & { emitter: EventEmitter } {
		const emitter = new EventEmitter();
		const spawned = emitter as unknown as Spawned & { emitter: EventEmitter };
		spawned.emitter = emitter;
		return spawned;
	}

	it("resolves ok when the process exits with code 0", async () => {
		const spawned = fakeSpawned();
		const calls: string[][] = [];
		const deps: RevealDeps = {
			spawn: (command, args) => {
				calls.push([command, ...args]);
				queueMicrotask(() => spawned.emitter.emit("close", 0));
				return spawned;
			},
		};
		const result = await reveal({ command: "open", args: ["-R", "/a"] }, deps, { timeoutMs: 1_000 });
		assert.deepEqual(result, { ok: true });
		assert.deepEqual(calls, [["open", "-R", "/a"]]);
	});

	it("reports a non-zero exit instead of throwing", async () => {
		const spawned = fakeSpawned();
		const deps: RevealDeps = {
			spawn: () => {
				queueMicrotask(() => spawned.emitter.emit("close", 1));
				return spawned;
			},
		};
		const result = await reveal({ command: "xdg-open", args: ["/a"] }, deps, { timeoutMs: 1_000 });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /exit code 1/);
	});

	it("reports spawn errors instead of throwing", async () => {
		const spawned = fakeSpawned();
		const deps: RevealDeps = {
			spawn: () => {
				queueMicrotask(() => spawned.emitter.emit("error", new Error("ENOENT")));
				return spawned;
			},
		};
		const result = await reveal({ command: "explorer", args: ["C:\\a"] }, deps, { timeoutMs: 1_000 });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /ENOENT/);
	});

	it("kills the process and reports when the timeout fires", async () => {
		const spawned = fakeSpawned();
		let killed = false;
		(spawned as unknown as { kill: () => boolean }).kill = () => {
			killed = true;
			return true;
		};
		const deps: RevealDeps = {
			spawn: () => spawned,
		};
		const result = await reveal({ command: "open", args: ["/a"] }, deps, { timeoutMs: 20 });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /timed out|timeout/i);
		assert.equal(killed, true);
	});
});

describe("windowsPathViaWsl", () => {
	it("trims the wslpath -w output", async () => {
		const deps = {
			exec: async (command: string, args: string[]) => {
				assert.equal(command, "wslpath");
				assert.deepEqual(args, ["-w", "/home/dev/b.txt"]);
				return { stdout: "  \\\\wsl$\\Ubuntu\\home\\dev\\b.txt\n", stderr: "" };
			},
		};
		const result = await windowsPathViaWsl("/home/dev/b.txt", deps);
		assert.equal(result, "\\\\wsl$\\Ubuntu\\home\\dev\\b.txt");
	});

	it("returns null when wslpath fails", async () => {
		const deps = {
			exec: async () => {
				throw new Error("wslpath: no such file");
			},
		};
		assert.equal(await windowsPathViaWsl("/missing", deps), null);
	});
});
