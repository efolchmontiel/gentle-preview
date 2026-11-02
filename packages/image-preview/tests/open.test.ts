import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpenArgv, buildWslPathArgv, resolveOpenPlatform } from "../lib/open.ts";

test("resolveOpenPlatform per platform and WSL env", () => {
	assert.equal(resolveOpenPlatform("darwin", {}), "macos");
	assert.equal(resolveOpenPlatform("win32", {}), "windows");
	assert.equal(resolveOpenPlatform("linux", { WSL_DISTRO_NAME: "Ubuntu" }), "wsl");
	assert.equal(resolveOpenPlatform("linux", { WSL_INTEROP: "/run/WSL" }), "wsl");
	assert.equal(resolveOpenPlatform("linux", {}), "linux");
});

test("buildOpenArgv per platform", () => {
	assert.deepEqual(buildOpenArgv("macos", "/a/b.png"), { cmd: "open", args: ["/a/b.png"] });
	assert.deepEqual(buildOpenArgv("windows", "C:\\a\\b.png"), { cmd: "cmd", args: ["/c", "start", "", "C:\\a\\b.png"] });
	assert.deepEqual(buildOpenArgv("linux", "/a/b.png"), { cmd: "xdg-open", args: ["/a/b.png"] });
});

test("buildOpenArgv for WSL requires the converted Windows path", () => {
	assert.equal(buildOpenArgv("wsl", "/a/b.png"), null);
	assert.equal(buildOpenArgv("wsl", "/a/b.png", ""), null);
	assert.deepEqual(buildOpenArgv("wsl", "/a/b.png", "C:\\a\\b.png"), {
		cmd: "cmd.exe",
		args: ["/c", "start", "", "C:\\a\\b.png"],
	});
});

test("buildWslPathArgv shape", () => {
	assert.deepEqual(buildWslPathArgv("/mnt/c/a b.png"), { cmd: "wslpath", args: ["-w", "/mnt/c/a b.png"] });
});
