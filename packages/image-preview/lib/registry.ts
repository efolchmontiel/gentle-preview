/**
 * Session-scoped registry mapping image numbers to pasted image files.
 *
 * The registry is persisted through `pi.appendEntry()` as a full snapshot per
 * write, and rebuilt on `session_start` from the current session branch.
 * A number belongs to the prompt draft that used it: a draft with no images
 * starts again at 1, so a number is reused rather than reserved for a whole
 * session. Every sent prompt carries its own `[Image refs]` block, so the
 * history stays unambiguous even when a number is used again later.
 */

/** `customType` used for the persisted registry entries. */
export const IMAGE_REGISTRY_ENTRY_TYPE = "gentle-image-preview.registry";

export interface ImageRef {
	/** Image number, 1-based, scoped to the prompt draft that used it. */
	number: number;
	/** Absolute path of the image file on disk. */
	path: string;
	/** MIME type of the image file. */
	mimeType: string;
	/** ISO timestamp of when the image was pasted. */
	addedAt: string;
}

/** Serialisation shape stored in a `CustomEntry`. */
export interface RegistrySnapshot {
	version: 1;
	/** Next number a draft would use; never below any stored number. */
	nextNumber: number;
	images: ImageRef[];
}

function isValidRef(value: unknown): value is ImageRef {
	if (typeof value !== "object" || value === null) return false;
	const ref = value as Record<string, unknown>;
	return (
		typeof ref.number === "number" &&
		Number.isInteger(ref.number) &&
		ref.number >= 1 &&
		typeof ref.path === "string" &&
		ref.path.length > 0 &&
		typeof ref.mimeType === "string" &&
		typeof ref.addedAt === "string"
	);
}

function isValidSnapshot(value: unknown): value is RegistrySnapshot {
	if (typeof value !== "object" || value === null) return false;
	const snap = value as Record<string, unknown>;
	if (snap.version !== 1) return false;
	// A stale nextNumber is repaired by ImageRegistry (clamped above every
	// stored number) rather than discarding the images.
	if (typeof snap.nextNumber !== "number" || !Number.isInteger(snap.nextNumber) || snap.nextNumber < 1) {
		return false;
	}
	if (!Array.isArray(snap.images) || !snap.images.every(isValidRef)) return false;
	return true;
}

export class ImageRegistry {
	private images: ImageRef[];
	private nextNumber: number;

	constructor(images: ImageRef[] = [], nextNumber?: number) {
		const maxStored = images.reduce((max, ref) => Math.max(max, ref.number), 0);
		this.images = [...images].sort((a, b) => a.number - b.number);
		this.nextNumber = Math.max(nextNumber ?? 1, maxStored + 1);
	}

	/**
	 * Records `path` under `number`, replacing any earlier ref for that number.
	 * The caller picks the number from the current draft, not from a session
	 * counter.
	 */
	set(number: number, path: string, mimeType: string, addedAt: string = new Date().toISOString()): ImageRef {
		const ref: ImageRef = { number, path, mimeType, addedAt };
		const index = this.images.findIndex((existing) => existing.number === number);
		if (index === -1) {
			this.images.push(ref);
			this.images.sort((a, b) => a.number - b.number);
		} else {
			this.images[index] = ref;
		}
		this.nextNumber = Math.max(this.nextNumber, number + 1);
		return ref;
	}

	/** Returns the ref for `number`, or undefined when the token is unknown. */
	get(number: number): ImageRef | undefined {
		return this.images.find((ref) => ref.number === number);
	}

	/** All refs, ascending by number. */
	all(): ImageRef[] {
		return [...this.images];
	}

	/** Serialisable snapshot for `pi.appendEntry()`. */
	snapshot(): RegistrySnapshot {
		return { version: 1, nextNumber: this.nextNumber, images: this.all() };
	}

	/** Replaces this registry's state with another's (used on session reload). */
	resetFrom(other: ImageRegistry): void {
		const snap = other.snapshot();
		this.images = snap.images;
		this.nextNumber = snap.nextNumber;
	}

	/** Restores a registry from a persisted snapshot, ignoring invalid data. */
	static fromSnapshot(value: unknown): ImageRegistry {
		if (!isValidSnapshot(value)) return new ImageRegistry();
		return new ImageRegistry(value.images, value.nextNumber);
	}
}

export interface BranchEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Rebuilds the registry state from the session branch.
 *
 * Not a blind replay: only the entries of our own `customType` are inspected,
 * the newest valid snapshot wins, and `nextNumber` is clamped above every number
 * ever seen so a restored snapshot never disagrees with the data it holds.
 */
export function rebuildSnapshotFromBranch(entries: readonly BranchEntryLike[]): ImageRegistry {
	let latest: RegistrySnapshot | undefined;
	let maxNumberSeen = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== IMAGE_REGISTRY_ENTRY_TYPE) continue;
		if (!isValidSnapshot(entry.data)) continue;
		latest = entry.data;
		for (const ref of entry.data.images) {
			maxNumberSeen = Math.max(maxNumberSeen, ref.number);
		}
		maxNumberSeen = Math.max(maxNumberSeen, entry.data.nextNumber - 1);
	}
	if (latest === undefined) return new ImageRegistry();
	return new ImageRegistry(latest.images, Math.max(latest.nextNumber, maxNumberSeen + 1));
}
