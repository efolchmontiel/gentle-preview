/**
 * Minimal regex-based, dependency-free syntax highlighter.
 *
 * Produces styled spans (keyword/string/comment/number/plain) per line.
 * State is per-line: a block comment opened on one line is styled only to the
 * end of that line (documented limitation for a peek preview).
 */

export type SpanStyle = "keyword" | "string" | "comment" | "number" | "plain";

export interface Span {
	text: string;
	style: SpanStyle;
}

interface LanguageConfig {
	keywords: ReadonlySet<string>;
	/** Line comment prefixes. */
	lineComments: readonly string[];
	/** Block comment delimiters: [open, close]. */
	blockComments: readonly (readonly [string, string])[];
	/** String delimiters; backtick is always supported for template literals. */
	stringDelims: readonly string[];
}

const TS_KEYWORDS = new Set([
	"abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
	"continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
	"export", "extends", "false", "finally", "for", "from", "function", "get",
	"if", "implements", "import", "in", "instanceof", "interface", "is", "keyof",
	"let", "namespace", "new", "null", "private", "protected", "public", "readonly",
	"return", "satisfies", "set", "static", "super", "switch", "this", "throw",
	"true", "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
]);

const PY_KEYWORDS = new Set([
	"and", "as", "assert", "async", "await", "break", "class", "continue", "def",
	"del", "elif", "else", "except", "False", "finally", "for", "from", "global",
	"if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass",
	"raise", "return", "True", "try", "while", "with", "yield",
]);

const JSON_KEYWORDS = new Set(["true", "false", "null"]);

const GENERIC_KEYWORDS = new Set<string>();

const LANGUAGES: Record<string, LanguageConfig> = {
	typescript: {
		keywords: TS_KEYWORDS,
		lineComments: ["//"],
		blockComments: [["/*", "*/"]],
		stringDelims: ['"', "'"],
	},
	python: {
		keywords: PY_KEYWORDS,
		lineComments: ["#"],
		blockComments: [['"""', '"""']],
		stringDelims: ['"', "'"],
	},
	json: {
		keywords: JSON_KEYWORDS,
		lineComments: [],
		blockComments: [],
		stringDelims: ['"'],
	},
};

/** Map a display language (from languageForPath) to a highlighter config. */
function configFor(language: string): LanguageConfig {
	const key = language.toLowerCase().replace(/[^a-z0-9+#]/g, "");
	if (key.includes("typescript") || key.includes("javascript") || key.includes("vue") || key.includes("svelte")) {
		return LANGUAGES.typescript!;
	}
	if (key.includes("python")) return LANGUAGES.python!;
	if (key.includes("json")) return LANGUAGES.json!;
	return {
		keywords: GENERIC_KEYWORDS,
		lineComments: ["#", "//"],
		blockComments: [["/*", "*/"]],
		stringDelims: ['"', "'"],
	};
}

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER = /[A-Za-z0-9_$]/;
const DIGIT_START = /[0-9]/;

/** Highlight one line into styled spans. Output spans always join back to the input. */
export function highlightLine(line: string, language: string): Span[] {
	const config = configFor(language);
	const spans: Span[] = [];
	let plain = "";

	const flushPlain = (): void => {
		if (plain.length === 0) return;
		const last = spans.at(-1);
		if (last && last.style === "plain") {
			last.text += plain;
		} else {
			spans.push({ text: plain, style: "plain" });
		}
		plain = "";
	};
	const emit = (text: string, style: SpanStyle): void => {
		if (text.length === 0) return;
		flushPlain();
		const last = spans.at(-1);
		if (last && last.style === style) {
			last.text += text;
		} else {
			spans.push({ text, style });
		}
	};

	let i = 0;
	while (i < line.length) {
		const rest = line.slice(i);

		// Line comments.
		const lineComment = config.lineComments.find((prefix) => rest.startsWith(prefix));
		if (lineComment) {
			emit(rest, "comment");
			return spans;
		}

		// Block comments (open and close within this line; see file note).
		let blockHandled = false;
		for (const [open, close] of config.blockComments) {
			if (!rest.startsWith(open)) continue;
			blockHandled = true;
			const end = line.indexOf(close, i + open.length);
			if (end === -1) {
				emit(rest, "comment");
				return spans;
			}
			emit(line.slice(i, end + close.length), "comment");
			i = end + close.length;
			break;
		}
		if (blockHandled) continue;

		const ch = line[i]!;

		// Strings.
		if (config.stringDelims.includes(ch) || ch === "`") {
			const end = findStringEnd(line, i, ch);
			emit(line.slice(i, end), "string");
			i = end;
			continue;
		}

		// Numbers (decimal, hex, floats).
		if (DIGIT_START.test(ch)) {
			const match = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
			const text = match?.[0] ?? ch;
			emit(text, "number");
			i += text.length;
			continue;
		}

		// Identifiers and keywords.
		if (IDENTIFIER_START.test(ch)) {
			let j = i + 1;
			while (j < line.length && IDENTIFIER.test(line[j]!)) j += 1;
			const word = line.slice(i, j);
			emit(word, config.keywords.has(word) ? "keyword" : "plain");
			i = j;
			continue;
		}

		plain += ch;
		i += 1;
	}

	flushPlain();
	return spans;
}

/** Find the index after the closing delimiter, honouring backslash escapes and unterminated strings. */
function findStringEnd(line: string, start: number, delim: string): number {
	for (let i = start + 1; i < line.length; i += 1) {
		const ch = line[i]!;
		if (ch === "\\" && i + 1 < line.length) {
			i += 1; // skip the escaped character
			continue;
		}
		if (ch === delim) return i + 1;
	}
	return line.length;
}
