/**
 * `[Image #N]` token helpers.
 *
 * Tokens are the compact, human-identifiable placeholders the editor keeps in
 * place of a full pasted-image path. The mapping from N to the real file lives
 * in `registry.ts`; this module only knows the token syntax.
 */

/** Matches every `[Image #N]` occurrence in a text. */
const TOKEN_PATTERN = /\[Image #(\d+)\]/g;

/** Header of the trailing block appended before the text reaches the model. */
export const IMAGE_REFS_HEADER = "[Image refs]";

/** Formats a token for the given image number, e.g. `[Image #3]`. */
export function formatToken(number: number): string {
	return `[Image #${number}]`;
}

/**
 * Number for a fresh paste in the current draft: 1 when the draft holds no
 * image, otherwise one above the highest token already there. A number belongs
 * to the draft it was written in, so emptying the draft starts again at 1.
 */
export function nextDraftNumber(numbers: readonly number[]): number {
	return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

/**
 * Returns the image numbers appearing in `text`, in order of first appearance,
 * deduplicated. Unknown or malformed text around tokens is irrelevant here;
 * only exact `[Image #N]` sequences match.
 */
export function parseTokenNumbers(text: string): number[] {
	const seen = new Set<number>();
	const result: number[] = [];
	for (const match of text.matchAll(TOKEN_PATTERN)) {
		const raw = match[1];
		if (raw === undefined) continue;
		const n = Number.parseInt(raw, 10);
		if (Number.isNaN(n) || seen.has(n)) continue;
		seen.add(n);
		result.push(n);
	}
	return result;
}

export interface TokenRef {
	/** Image number, e.g. 1 for `[Image #1]`. */
	number: number;
	/** Absolute path of the image file. */
	path: string;
}

/**
 * Builds the trailing `[Image refs]` block, one line per ref, in ascending
 * number order. Returns an empty string when there are no refs.
 */
export function buildImageRefsBlock(refs: readonly TokenRef[]): string {
	if (refs.length === 0) return "";
	const sorted = [...refs].sort((a, b) => a.number - b.number);
	const lines = sorted.map((ref) => `${formatToken(ref.number)} = ${ref.path}`);
	return [IMAGE_REFS_HEADER, ...lines].join("\n");
}

/**
 * Appends the `[Image refs]` block to `text`, preserving the user's body
 * verbatim. With no refs the original text is returned unchanged.
 */
export function appendImageRefs(text: string, refs: readonly TokenRef[]): string {
	const block = buildImageRefsBlock(refs);
	if (block === "") return text;
	return `${text}\n\n${block}`;
}
