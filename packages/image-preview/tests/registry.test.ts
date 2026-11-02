import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IMAGE_REGISTRY_ENTRY_TYPE,
	ImageRegistry,
	rebuildSnapshotFromBranch,
	type BranchEntryLike,
} from "../lib/registry.ts";

test("allocate numbers incrementally and never reuse within a session", () => {
	const registry = new ImageRegistry();
	const a = registry.allocate("/a.png", "image/png");
	const b = registry.allocate("/b.png", "image/jpeg");
	const c = registry.allocate("/c.png", "image/gif");
	assert.deepEqual([a.number, b.number, c.number], [1, 2, 3]);
	assert.equal(registry.get(1)?.path, "/a.png");
	assert.equal(registry.get(3)?.path, "/c.png");
	assert.equal(registry.get(4), undefined);
});

test("snapshot round-trips through fromSnapshot", () => {
	const registry = new ImageRegistry();
	registry.allocate("/a.png", "image/png", "2026-01-01T00:00:00.000Z");
	registry.allocate("/b.png", "image/webp", "2026-01-01T00:00:01.000Z");
	const snap = registry.snapshot();
	const restored = ImageRegistry.fromSnapshot(snap);
	assert.deepEqual(restored.snapshot(), snap);
	assert.equal(restored.all().length, 2);
});

test("allocate after restore continues above every previous number", () => {
	const registry = new ImageRegistry();
	registry.allocate("/a.png", "image/png");
	registry.allocate("/b.png", "image/png");
	const restored = ImageRegistry.fromSnapshot(registry.snapshot());
	const next = restored.allocate("/c.png", "image/png");
	assert.equal(next.number, 3);
});

test("fromSnapshot ignores invalid payloads", () => {
	for (const bad of [undefined, null, 42, {}, { version: 1, nextNumber: 1 }, { version: 2, nextNumber: 1, images: [] }]) {
		assert.equal(ImageRegistry.fromSnapshot(bad).all().length, 0);
	}
	// nextNumber must stay above every stored number.
	assert.equal(
		ImageRegistry.fromSnapshot({
			version: 1,
			nextNumber: 1,
			images: [{ number: 5, path: "/x.png", mimeType: "image/png", addedAt: "x" }],
		}).allocate("/y.png", "image/png").number,
		6,
	);
});

test("fromSnapshot repairs a stale nextNumber and discards garbage images", () => {
	for (const bad of [undefined, null, 42, {}, { version: 1, nextNumber: 1 }, { version: 2, nextNumber: 1, images: [] }]) {
		assert.equal(ImageRegistry.fromSnapshot(bad).all().length, 0);
	}
	// Stale nextNumber: the registry clamps it above every stored number.
	const repaired = ImageRegistry.fromSnapshot({
		version: 1,
		nextNumber: 1,
		images: [{ number: 5, path: "/x.png", mimeType: "image/png", addedAt: "x" }],
	});
	assert.equal(repaired.get(5)?.path, "/x.png");
	assert.equal(repaired.allocate("/y.png", "image/png").number, 6);
});

function entry(data: unknown): BranchEntryLike {
	return { type: "custom", customType: IMAGE_REGISTRY_ENTRY_TYPE, data };
}

test("rebuildSnapshotFromBranch picks the newest valid snapshot of our custom type only", () => {
	const first = new ImageRegistry();
	first.allocate("/a.png", "image/png");
	const second = new ImageRegistry();
	second.allocate("/a.png", "image/png");
	second.allocate("/b.png", "image/png");

	const branch: BranchEntryLike[] = [
		{ type: "message" },
		{ type: "custom", customType: "other.extension", data: { version: 1, nextNumber: 99, images: [] } },
		entry(first.snapshot()),
		{ type: "custom", customType: IMAGE_REGISTRY_ENTRY_TYPE, data: { junk: true } },
		entry(second.snapshot()),
	];

	const rebuilt = rebuildSnapshotFromBranch(branch);
	assert.deepEqual(rebuilt.snapshot(), second.snapshot());
});

test("rebuildSnapshotFromBranch never reuses a number seen in older snapshots", () => {
	const older = new ImageRegistry();
	older.allocate("/a.png", "image/png");
	older.allocate("/b.png", "image/png");
	older.allocate("/c.png", "image/png");
	const newer = new ImageRegistry();
	newer.allocate("/d.png", "image/png");

	const rebuilt = rebuildSnapshotFromBranch([entry(older.snapshot()), entry(newer.snapshot())]);
	// Content comes from the newest snapshot; the older numbers only reserve the counter.
	assert.equal(rebuilt.get(1)?.path, "/d.png");
	assert.equal(rebuilt.get(3), undefined);
	assert.equal(rebuilt.allocate("/e.png", "image/png").number, 4);
});

test("rebuildSnapshotFromBranch without valid entries starts fresh", () => {
	assert.equal(rebuildSnapshotFromBranch([]).all().length, 0);
	assert.equal(rebuildSnapshotFromBranch([{ type: "message" }]).allocate("/a.png", "image/png").number, 1);
});

test("resetFrom replaces the live state", () => {
	const live = new ImageRegistry();
	live.allocate("/a.png", "image/png");
	const fresh = new ImageRegistry();
	fresh.allocate("/b.png", "image/png");
	fresh.allocate("/c.png", "image/png");
	live.resetFrom(fresh);
	assert.equal(live.get(1)?.path, "/b.png");
	assert.equal(live.allocate("/d.png", "image/png").number, 3);
});
