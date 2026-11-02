import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IMAGE_REGISTRY_ENTRY_TYPE,
	ImageRegistry,
	rebuildSnapshotFromBranch,
	type BranchEntryLike,
} from "../lib/registry.ts";

test("set records the number the draft chose and replaces an earlier ref for it", () => {
	const registry = new ImageRegistry();
	registry.set(1, "/a.png", "image/png", "2026-01-01T00:00:00.000Z");
	registry.set(2, "/b.png", "image/jpeg", "2026-01-01T00:00:01.000Z");
	// A new draft starts at 1 again, so the same number is written twice.
	registry.set(1, "/c.png", "image/gif", "2026-01-01T00:00:02.000Z");

	assert.equal(registry.get(1)?.path, "/c.png");
	assert.equal(registry.get(1)?.mimeType, "image/gif");
	assert.equal(registry.get(2)?.path, "/b.png");
	assert.deepEqual(
		registry.all().map((ref) => ref.number),
		[1, 2],
	);
});

test("set keeps the list ordered by number even when numbers arrive out of order", () => {
	const registry = new ImageRegistry();
	registry.set(2, "/b.png", "image/png");
	registry.set(1, "/a.png", "image/png");

	assert.deepEqual(
		registry.all().map((ref) => ref.number),
		[1, 2],
	);
	assert.equal(registry.snapshot().nextNumber, 3);
});

test("snapshot round-trips through fromSnapshot", () => {
	const registry = new ImageRegistry();
	registry.set(1, "/a.png", "image/png", "2026-01-01T00:00:00.000Z");
	registry.set(2, "/b.png", "image/webp", "2026-01-01T00:00:01.000Z");
	const snap = registry.snapshot();
	const restored = ImageRegistry.fromSnapshot(snap);
	assert.deepEqual(restored.snapshot(), snap);
	assert.equal(restored.all().length, 2);
});

test("fromSnapshot ignores invalid payloads", () => {
	for (const bad of [undefined, null, 42, {}, { version: 1, nextNumber: 1 }, { version: 2, nextNumber: 1, images: [] }]) {
		assert.equal(ImageRegistry.fromSnapshot(bad).all().length, 0);
	}
});

test("fromSnapshot repairs a stale nextNumber from the stored numbers", () => {
	const repaired = ImageRegistry.fromSnapshot({
		version: 1,
		nextNumber: 1,
		images: [{ number: 5, path: "/x.png", mimeType: "image/png", addedAt: "x" }],
	});
	assert.equal(repaired.get(5)?.path, "/x.png");
	assert.equal(repaired.snapshot().nextNumber, 6);
});

function entry(data: unknown): BranchEntryLike {
	return { type: "custom", customType: IMAGE_REGISTRY_ENTRY_TYPE, data };
}

test("rebuildSnapshotFromBranch picks the newest valid snapshot of our custom type only", () => {
	const first = new ImageRegistry();
	first.set(1, "/a.png", "image/png");
	const second = new ImageRegistry();
	second.set(1, "/a.png", "image/png");
	second.set(2, "/b.png", "image/png");

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

test("rebuildSnapshotFromBranch takes content from the newest snapshot and keeps its counter above older numbers", () => {
	const older = new ImageRegistry();
	older.set(1, "/a.png", "image/png");
	older.set(2, "/b.png", "image/png");
	older.set(3, "/c.png", "image/png");
	const newer = new ImageRegistry();
	newer.set(1, "/d.png", "image/png");

	const rebuilt = rebuildSnapshotFromBranch([entry(older.snapshot()), entry(newer.snapshot())]);
	assert.equal(rebuilt.get(1)?.path, "/d.png");
	assert.equal(rebuilt.get(3), undefined);
	// Numbers 2 and 3 were seen in the older snapshot, so the counter stays above them.
	assert.equal(rebuilt.snapshot().nextNumber, 4);
});

test("rebuildSnapshotFromBranch without valid entries starts fresh", () => {
	assert.equal(rebuildSnapshotFromBranch([]).all().length, 0);
	assert.equal(rebuildSnapshotFromBranch([{ type: "message" }]).snapshot().nextNumber, 1);
});

test("resetFrom replaces the live state", () => {
	const live = new ImageRegistry();
	live.set(1, "/a.png", "image/png");
	const fresh = new ImageRegistry();
	fresh.set(1, "/b.png", "image/png");
	fresh.set(2, "/c.png", "image/png");
	live.resetFrom(fresh);
	assert.equal(live.get(1)?.path, "/b.png");
	assert.equal(live.snapshot().nextNumber, 3);
});
