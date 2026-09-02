/**
 * General-purpose content redaction: detect and mask secrets/PII inside a STRING, and — via
 * {@link redactObjectByContent} — inside every string value of an object. Detection combines a
 * curated, high-precision pattern ruleset (prefix-anchored, so a hit can be named) with a Shannon-
 * entropy pass that catches the unprefixed high-entropy secrets the ruleset can't name. It
 * deliberately over-redacts: a false positive loses a constant, a false negative leaks a secret.
 *
 * The string/content path is dependency-free — silo's extracted review core imports `redactSecrets` as
 * a *pure* function and bundles it into the browser extension. `createRedactor` (known-PATH redaction)
 * needs object-scan, so it's LAZY-imported (`await import`) and loaded only when you actually call it;
 * the string path never triggers it.
 *
 * The entropy heuristic and the collect → overlap-filter → reverse-replace engine are adapted from
 * redactum (MIT, https://github.com/alexwhin/redactum).
 */

const DEFAULT_REPLACEMENT = "«redacted»";

export interface Rule { readonly "label": string; readonly "re": RegExp }

// High-precision, prefix-anchored patterns — these exist for accurate LABELS. Broad coverage comes
// from the entropy pass, not from an exhaustive catalog, so there's no 190-pattern maintenance treadmill.
const RULES: readonly Rule[] = [
	{ "label": "PRIVATE_KEY", "re": /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/gu },
	{ "label": "JWT", "re": /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu },
	{ "label": "AWS_KEY", "re": /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/gu },
	{ "label": "GITHUB_TOKEN", "re": /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/gu },
	{ "label": "SLACK_TOKEN", "re": /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu },
	{ "label": "STRIPE_KEY", "re": /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gu },
	{ "label": "ANTHROPIC_KEY", "re": /\bsk-ant-[A-Za-z0-9_-]{40,}\b/gu },
	{ "label": "OPENAI_KEY", "re": /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/gu },
	{ "label": "DB_URL", "re": /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/]+:[^\s@]+@/gu },
	{ "label": "BEARER", "re": /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gu }
];

// Candidate runs for the entropy pass — spans of secret-ish characters long enough to be worth testing.
const TOKEN_RE = /[A-Za-z0-9+/=_-]{16,}/gu;

/** Shannon entropy in bits/char (0–8); higher = more random. Adapted from redactum (MIT). */
export function entropy(value: string): number {
	if (value.length === 0) { return 0; }

	const counts = new Map<string, number>();

	for (const ch of value) { counts.set(ch, (counts.get(ch) ?? 0) + 1); }

	let bits = 0;

	for (const count of counts.values()) {
		const p = count / value.length;

		bits -= p * Math.log2(p);
	}

	return bits;
}

/** Probably a secret: high entropy, or moderate entropy with ≥3 character classes. Adapted from
 *  redactum (MIT). */
export function looksLikeSecret(token: string, minLength = 16): boolean {
	if (token.length < minLength) { return false; }

	const bits = entropy(token);

	if (bits > 4.5) { return true; }
	if (bits < 3.5) { return false; }

	const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].filter((re) => re.test(token)).length;

	return classes >= 3;
}

export interface RedactOptions {
	/** Mask string, or a function of the detected label. Default `«redacted»`. */
	"replacement"?: string | ((label: string) => string);
	/** Run the entropy pass (catches unprefixed secrets). Default true. */
	"entropy"?: boolean;
	/** Minimum token length the entropy pass considers. Default 16. */
	"minEntropyLength"?: number;
	/** Override the pattern ruleset. Default: the built-in high-precision set. */
	"rules"?: readonly Rule[];
}

interface Span { readonly "start": number; readonly "end": number; readonly "label": string; readonly "priority": number }

/** Detect and mask secrets in a string. Collects ruleset + entropy matches, drops overlaps (ruleset
 *  wins over entropy), then replaces right-to-left so earlier indices stay valid. */
export function redactString(text: string, options: RedactOptions = {}): string {
	const replacement = options.replacement ?? DEFAULT_REPLACEMENT;
	const rules = options.rules ?? RULES;
	const spans: Span[] = [];

	rules.forEach((rule, priority) => {
		for (const match of text.matchAll(rule.re)) {
			const start = match.index ?? 0;

			spans.push({ start, "end": start + match[0].length, "label": rule.label, priority });
		}
	});

	if (options.entropy ?? true) {
		for (const match of text.matchAll(TOKEN_RE)) {
			if (looksLikeSecret(match[0], options.minEntropyLength ?? 16)) {
				const start = match.index ?? 0;

				spans.push({ start, "end": start + match[0].length, "label": "HIGH_ENTROPY", "priority": rules.length });
			}
		}
	}

	if (spans.length === 0) { return text; }

	// Earliest start first; on a tie, higher priority (lower number = ruleset) and the longer span win.
	spans.sort((a, b) => a.start - b.start || a.priority - b.priority || b.end - a.end);

	const kept: Span[] = [];
	let coveredTo = -1;

	for (const span of spans) {
		if (span.start >= coveredTo) { kept.push(span); coveredTo = span.end; }
	}

	let out = text;

	for (let i = kept.length - 1; i >= 0; i--) {
		const span = kept[i];
		const mask = typeof replacement === "function" ? replacement(span.label) : replacement;

		out = out.slice(0, span.start) + mask + out.slice(span.end);
	}

	return out;
}

/** Deep-copy `value` and run {@link redactString} over every string it contains (cycle-safe). */
export function redactObjectByContent<T>(value: T, options: RedactOptions = {}): T {
	const seen = new WeakSet<object>();

	const walk = (node: unknown): unknown => {
		if (typeof node === "string") { return redactString(node, options); }
		if (node === null || typeof node !== "object") { return node; }
		if (seen.has(node)) { return node; }

		seen.add(node);

		if (Array.isArray(node)) { return node.map(walk); }

		const out: Record<string, unknown> = {};

		for (const [key, val] of Object.entries(node)) { out[key] = walk(val); }

		return out;
	};

	return walk(value) as T;
}

/** Back-compat: the pure, over-redacting string scrubber silo's review core imports at its
 *  persistence boundary. Upgraded (ruleset + entropy) but same signature and deterministic behavior. */
export function redactSecrets(source: string): string {
	return redactString(source);
}

/**
 * Known-path redaction — the deterministic complement to the best-guess functions above: censor the
 * object PROPERTIES you name (globs via object-scan), regardless of what the value looks like. Use it
 * for fields you KNOW are sensitive (`password`, `**.token`, PII-by-policy) that content-scanning would
 * miss. object-scan is imported lazily, so importing this module for the string path stays dep-free.
 */
export async function createRedactor(paths: string[], censor: string | ((value: unknown, key: (string | number)[]) => unknown) = DEFAULT_REPLACEMENT) {
	const { "default": objectScan } = await import("object-scan");
	const redact = objectScan(paths, {
		"breakFn": function({ isCircular }) {
			return isCircular;
		},
		"filterFn": function({ parent, property, value, key }) {
			parent[property] = typeof censor === "function" ? censor(value, key) : censor;
		}
	});

	return function(object: unknown) {
		if (object === null || typeof object !== "object") {
			return object;
		}

		const clone = structuredClone(object);

		redact(clone);

		return clone;
	};
}
