import antfu, { GLOB_SRC, GLOB_TS } from "@antfu/eslint-config";
import js from "@eslint/js";
import { builtinRules } from "eslint/use-at-your-own-risk";
import tseslint from "typescript-eslint";

// --- L4: Brian's own preferences. The ONLY hand-maintained layer — accumulate overrides here (antfu's
//     rule ids: ts/*, style/*, or core). ---

// error = a human must fix it by hand. These are the NON-fixable rules Brian enforces (the severity pass
// below can't downgrade them — there's nothing to auto-fix).
const errors = {
	"ts/naming-convention": ["error", { "selector": "default", "format": ["camelCase"] }, { "selector": "import", "format": ["camelCase", "PascalCase"] }, { "selector": ["function", "variable"], "format": ["camelCase", "PascalCase", "UPPER_CASE"], "leadingUnderscore": "allowSingleOrDouble" }, { "selector": ["parameter", "variable"], "modifiers": ["destructured"], "format": null }, { "selector": "objectLiteralProperty", "format": null }, { "selector": ["classProperty", "parameter"], "format": ["camelCase", "PascalCase"], "leadingUnderscore": "allow" }, { "selector": ["typeLike", "enumMember"], "format": ["PascalCase"] }],
	"func-style": ["error", "declaration", { "allowArrowFunctions": true }],
	"id-length": ["error", { "exceptions": ["$", "_", "x", "y", "z"], "properties": "never" }],
	"no-plusplus": ["error", { "allowForLoopAfterthoughts": true }],
	"style/no-tabs": ["error", { "allowIndentationTabs": true }],
	"node/prefer-global/buffer": ["error", "always"], // prefer the global `Buffer` over importing it — flags imports, not global use
	"node/prefer-global/process": ["error", "always"], // same for `process` — prefer the global, flag imports
	"ts/no-misused-promises": ["error", { "checksConditionals": true, "checksSpreads": true, "checksVoidReturn": false }], // keep the real-bug checks (promise-in-conditional = forgotten await; spread-promise) loud; drop void-return (unavoidable async handlers; the one real case — async Promise executor — is covered by no-async-promise-executor)
	// Brian imports node:path / node:url as `* as path` / `* as url` (namespace) and calls `path.join`, `url.fileURLToPath`.
	// extendDefaultStyles:false drops unicorn's built-in opinions (it wants `default` for path). NOT auto-fixable — flags named imports, convert by hand.
	"unicorn/import-style": ["error", { "extendDefaultStyles": false, "styles": { "node:path": { "namespace": true }, "path": { "namespace": true }, "node:url": { "namespace": true }, "url": { "namespace": true } } }],
	// Categorically ban node fs — Brian uses his own wrapper (@brianjenkins94/util/fs; locally util/fs) that wraps
	// node fs with utf8 defaults + async helpers. allowTypeImports lets `import type` through (types have no wrapper
	// equivalent). NOT auto-fixable — convert by hand. The wrapper itself + sync-bound files are exempted in lib's eslint.config.ts.
	"ts/no-restricted-imports": ["error",
{ "paths": [
		{ "name": "fs", "message": "Use the fs wrapper: @brianjenkins94/util/fs (locally util/fs).", "allowTypeImports": true },
		{ "name": "node:fs", "message": "Use the fs wrapper: @brianjenkins94/util/fs (locally util/fs).", "allowTypeImports": true },
		{ "name": "fs/promises", "message": "Use the fs wrapper: @brianjenkins94/util/fs (locally util/fs).", "allowTypeImports": true },
		{ "name": "node:fs/promises", "message": "Use the fs wrapper: @brianjenkins94/util/fs (locally util/fs).", "allowTypeImports": true }
	] }]
};

// warn = the formatter handles it (auto-fixed on save, hidden in the IDE) OR it's a deliberate FYI. The
// severity pass already downgrades fixable rules automatically; the fixable style rules live here only
// because they carry Brian's custom OPTIONS — the `warn` severity keeps them consistent with that pass.
const warnings = {
	"ts/no-use-before-define": ["warn", { "functions": false }],
	"max-depth": ["warn", { "max": 5 }],
	"curly": ["warn", "all"], // require braces on ALL control statements. The unbraced beside one-liners in the existing source are AI artifacts, not Brian's style. Conflict-free now that antfu/if-newline is disabled (it was the rule that split one-liners onto a new line, oscillating with nonblock-statement-body-position:beside)
	"style/no-multi-spaces": ["warn", { "ignoreEOLComments": true }], // clean stray runs (merge artifacts, accidental double-spaces) but leave aligned trailing // comments alone
	"object-shorthand": ["warn", "never"], // always long-form — `{ foo: foo }` not `{ foo }`, `key: function() {}` not `key() {}` — for properties AND methods alike

	// fixable style rules — warn (auto-fixed on save, hidden in IDE) but carrying Brian's custom options:
	"style/array-bracket-newline": ["warn", "consistent"],
	"style/array-element-newline": ["warn", { "consistent": true, "multiline": true }],
	"style/function-call-argument-newline": ["warn", "consistent"],
	"style/function-paren-newline": ["warn", "consistent"],
	"style/space-before-function-paren": ["warn", { "anonymous": "never", "named": "never", "asyncArrow": "always" }], // object form (not the string "never") so it only touches the 3 function types — leaves `catch (error)` spacing to Brian. asyncArrow "always" → `async (range) =>` keeps the space between `async` and the paren
	"style/quote-props": ["warn", "always"],
	"style/comma-dangle": ["warn", "never"],
	"style/brace-style": ["warn", "1tbs", { "allowSingleLine": true }], // `} else {` on one line, not antfu's stroustrup (else on its own line)
	"style/arrow-parens": ["warn", "always"], // keep parens around single arrow params — don't strip them (antfu's as-needed)
	"style/operator-linebreak": ["warn", "before", { "overrides": { "=": "after" } }], // keep antfu's break-before for most operators, but assignment `=` stays at the END of the line, not the start of the next
	"style/object-property-newline": ["warn", { "allowAllPropertiesOnSameLine": true }],
	"style/padding-line-between-statements": ["warn", { "blankLine": "always", "prev": "*", "next": "return" }, { "blankLine": "always", "prev": ["const", "let", "var"], "next": "*" }, { "blankLine": "any", "prev": ["const", "let", "var"], "next": ["const", "let", "var"] }, { "blankLine": "always", "prev": "directive", "next": "*" }, { "blankLine": "always", "prev": "import", "next": "*" }, { "blankLine": "any", "prev": "import", "next": "import" }, { "blankLine": "always", "prev": "multiline-block-like", "next": "*" }],
	"prefer-destructuring": ["warn", { "AssignmentExpression": { "array": false, "object": false } }]
};

// downgrades = a plain error→warn severity flip and NOTHING else (no options). Just "I don't want this loud."
// Bin new rules here as you meet them. (Rules that ALSO carry options live in `warnings`.)
const downgrades = {
	"ts/no-loop-func": "warn",
	"ts/no-explicit-any": "warn",
	"no-nested-ternary": "warn", // nested ternaries are sometimes fine
	"no-continue": "warn",
	"sort-vars": "warn"
};

const unsure = {
	// rules we're still deciding on — parked here while we live with them
	"ts/explicit-module-boundary-types": "off", // off for now — prefer functions whose return types trivially infer; but there are surely cases worth revisiting
	// whole no-unsafe-* family off: Brian uses `any` implicitly (dynamic data) and doesn't care to correct it right
	// now. Real signal though — REVISIT if/when tightening any-safety (esp. the "any leaking into types" trio).
	"ts/no-unsafe-member-access": "off",
	"ts/no-unsafe-call": "off",
	"ts/no-unsafe-assignment": "off",
	"ts/no-unsafe-argument": "off",
	"ts/no-unsafe-return": "off",
	"ts/no-unsafe-type-assertion": "off"
};

const disabled = {
	// rules we've turned off
	"style/max-len": "off", // line length is a judgment call, not a hard limit — and tabs make the column math lie
	"jsonc/sort-keys": "off", // like alphabetized keys in principle, but if it ever happens it should be a separate deliberate pass
	"sort-imports": "off", // TWO import sorters can't coexist — core sort-imports and antfu's perfectionist/sort-imports disagree on order and undo each other every --fix pass (circular fixes → non-deterministic import order on save). Defer to perfectionist (antfu's choice; the refill re-added this core one on top)
	"sort-keys": "off", // same as jsonc/sort-keys — not a nag; a deliberate pass if ever
	"ts/no-magic-numbers": "off", // flags every literal number (indexes, small constants, status codes) — more noise than signal
	"no-ternary": "off", // ternaries are fine
	"antfu/no-top-level-await": "off", // top-level await is wanted (this very config is built on it)
	"no-console": "off", // would like better console discipline, but blanket-flagging every console.* doesn't get there
	"max-statements": "off", // raw statement count is a weak signal — `complexity` (kept on) is the better measure
	"max-lines-per-function": "off", // function length isn't the signal — `complexity` is
	"max-lines": "off", // whole-file line count isn't a meaningful cap either
	"ts/max-params": "off",
	"max-params": "off", // param count isn't a limit Brian wants (both ts + core off)
	"radix": "off", // don't require the parseInt radix argument
	"no-fallthrough": "off", // uses intentional switch fall-through as a pattern (see hyperformula.ts) — don't want to annotate every case
	"no-param-reassign": "off", // reassigning parameters is fine (e.g. `input = input.replace(...)`)
	"unused-imports/no-unused-vars": "off", // don't nag on unused variables (unused-imports/no-unused-imports stays on, so unused imports still auto-remove)
	"no-control-regex": "off", // intentional control characters in regexes are fine
	"no-await-in-loop": "off", // sequential awaits in a loop are often intentional (order/rate), not always a Promise.all case
	"antfu/if-newline": "off", // forces a newline after `if (cond)` for non-block bodies — conflicts with Brian's beside one-liners AND with style/nonblock-statement-body-position:beside (the two oscillate, producing broken half-fixed saves)
	"ts/no-shadow": "off", // intentional shadowing is fine (e.g. resolve/reject in a Promise executor, reused callback params); the option that might've trimmed it (ignoreFunctionTypeParameterNameValueShadow) is already the default. (core no-shadow is already off everywhere — antfu-off on JS, superseded off on TS)
	"arrow-body-style": "off", // has no "allow both" mode (only always/as-needed/never); "as-needed" collapses block-body arrows to concise. Off so a deliberate `(row) => { return … }` (e.g. forced into an arrow by `this` but wanted on its own line) is left alone
	"no-underscore-dangle": "off", // can't distinguish leading vs trailing (its only unique effect here is banning the LEADING `_` Brian wants). ts/naming-convention already does exactly what he wants: leadingUnderscore allowed, trailing forbidden via camelCase format-fail
	"ts/consistent-return": "off", // inconsistent returns (value in some branches, nothing in others) are fine
	"consistent-return": "off",
	"ts/prefer-readonly-parameter-types": "off", // readonly-everywhere isn't Brian's style; `treatMethodsAsReadonly` only cut 178→171 (his params are mutable data, not method-bearing types)
	"no-undefined": "off", // using the `undefined` literal is fine
	"no-negated-condition": "off", // negated if/else conditions are fine
	"capitalized-comments": "off", // don't force-capitalize the first letter of comments
	"prefer-template": "off", // use both string concatenation and template literals — don't force one
	"no-else-return": "off", // keep `else` blocks even when the `if` returns — don't strip them
	"ts/promise-function-async": "off", // don't auto-add `async` to functions that return a promise
	// dot vs bracket is INTENT: obj["key"] = "not sure the key exists", obj.key = "confident it's there". A linter
	// can't read that confidence — tried `allowIndexSignaturePropertyAccess` and it helped 0 of 146 (every hedge is
	// on a statically-KNOWN key, not an index signature). So both variants off.
	"ts/dot-notation": "off",
	"dot-notation": "off",
	"func-names": "off", // no opinion on named vs anonymous function expressions — use both
	"prefer-arrow-callback": "off", // no opinion — use both; and being fixable it'd auto-rewrite callbacks to arrows on save
	"max-classes-per-file": "off", // one-class-per-file is an arbitrary limit
	"no-warning-comments": "off", // TODO/FIXME comments are fine
	"style/spaced-comment": "off", // don't care about the space after // or /*
	"style/wrap-regex": "off", // don't need regex literals wrapped in parens
	"regexp/sort-flags": "off", // don't care about regex flag order
	"no-inline-comments": "off", // inline comments on the same line as code are fine
	"style/line-comment-position": "off", // same "where do comments go" call as no-inline-comments
	"style/lines-around-comment": "off", // don't force blank lines before/after comments (was gapping every interface member) — Brian places his own
	"style/multiline-comment-style": "off", // leave comment style alone — don't merge //-runs into /* */ or reflow block comments
	"jsdoc/multiline-blocks": "off", // don't force /** and */ onto their own lines in JSDoc
	"style/newline-per-chained-call": "off", // don't force method chains onto separate lines (and its autofix even left them un-indented)
	"prefer-named-capture-group": "off", // no opinion — don't need named groups on every regex
	"ts/strict-void-return": "off", // mostly benign "returned a value that's ignored" idioms; the one real case (async fn in void context) is already covered by ts/no-misused-promises
	// require `strictNullChecks` (off in tsconfig) to function — each emits "requires strictNullChecks" and can't
	// work reliably without it, so they're just noise here. RE-ENABLE these if strictNullChecks is ever turned on:
	"ts/strict-boolean-expressions": "off",
	"ts/no-unnecessary-condition": "off",
	"ts/no-unnecessary-boolean-literal-compare": "off",
	"ts/no-useless-default-assignment": "off",
	"ts/prefer-nullish-coalescing": "off"
};

/**
 * Brian's shared ESLint config, generated live:
 *   - antfu is the BASE, composed as-is — all its plugins, decisions and file-scoping come along
 *     untouched (unicorn / perfectionist / node / import / jsdoc / yaml / jsonc / markdown / toml), plus
 *     Brian's style pinned (tabs / double quotes / semicolons) and type-aware rules on.
 *   - Then we FILL the maximalist base antfu curates away — EVERYTHING-ON: `js.configs.all` +
 *     `tseslint.configs.all` + `@stylistic` ALL — restoring every rule they turn on that antfu leaves
 *     UNSET. antfu's own enables/disables win (we skip anything antfu already decided), so this refills
 *     the ~150 core+ts+stylistic rules antfu is silent on. No native plugins registered: the rules apply
 *     under antfu's own `ts/` + `style/` prefixes (the `all` catalogs are read only for their ids).
 *   - A SEVERITY pass: every auto-fixable rule → `warn` (silently fixed on save, hidden in the IDE via
 *     `eslint.quiet`), every non-fixable rule → `error` (a human must act). error/warn encodes "do I have
 *     to touch this?", derived from `meta.fixable` — no hand-maintained severity list.
 *   - Then Brian's L4 buckets — where the famously-unlivable `all` rules (no-magic-numbers,
 *     prefer-readonly-parameter-types, no-ternary, no-undefined, …) get triaged into `disabled`. L4 is
 *     authoritative: it runs after the severity pass, so anything pinned here keeps its given severity.
 * Bumping @antfu/eslint-config re-derives everything automatically — nothing to maintain but L4.
 *
 *   // eslint.config.js (downstream)
 *   import config from "@brianjenkins94/util/eslint";
 *   export default [...config, { ignores: ["dist/**"] }];
 */
const configs = await antfu({
	"typescript": { "tsconfigPath": "tsconfig.json" },
	"stylistic": { "indent": "tab", "quotes": "double", "semi": true }
}).toConfigs();

// What antfu already decided (enabled OR disabled) + its registered plugin catalogs (for the @stylistic
// ALL list and to guard the ts/ refill against version skew — only refill rules antfu's plugins actually ship).
const antfuRules: Record<string, unknown> = {};
const plugins: Record<string, { "rules"?: Record<string, { "meta"?: { "deprecated"?: unknown; "fixable"?: unknown } }> }> = {};
let stylePlugin: { "rules"?: Record<string, unknown> } | undefined;
let tsPlugin: { "rules"?: Record<string, unknown> } | undefined;

for (const config of configs) {
	Object.assign(antfuRules, config.rules ?? {});
	Object.assign(plugins, config.plugins ?? {});
	stylePlugin ??= config.plugins?.["style"] as typeof stylePlugin;
	tsPlugin ??= config.plugins?.["ts"] as typeof tsPlugin;
}

// The maximalist "everything on" target, keyed by antfu's rule ids (core stays; @typescript-eslint/* → ts/*;
// every @stylistic rule → style/*). Later sources override earlier, matching how the base configs layer.
const want: Record<string, unknown> = {};

for (const [id, value] of Object.entries(js.configs.all?.rules ?? {})) {
	want[id] = value;
}

for (const config of tseslint.configs.all) {
	for (const [id, value] of Object.entries(config.rules ?? {})) {
		want[id.startsWith("@typescript-eslint/") ? `ts/${id.slice(19)}` : id] = value;
	}
}

for (const rule of Object.keys(stylePlugin?.rules ?? {})) {
	want[`style/${rule}`] ??= "error";
}

function isOff(value: unknown): boolean {
	const level = Array.isArray(value) ? value[0] : value;

	return level === "off" || level === 0;
}

// Refill only what antfu leaves unset. Split by scope: type-aware ts/* → TS files only (they error on
// plain JS, which antfu type-checks off there); core + style → all code.
const tsFill: Record<string, unknown> = {};
const srcFill: Record<string, unknown> = {};

for (const [id, value] of Object.entries(want)) {
	if (id in antfuRules || isOff(value) || isDeprecated(id)) {
		continue; // skip antfu's own decisions, disabled defaults, and RETIRED rules (e.g. @stylistic jsx-indent)
	}

	if (id.startsWith("ts/")) {
		if (tsPlugin?.rules?.[id.slice(3)] !== undefined) {
			tsFill[id] = value;
		}
	} else {
		srcFill[id] = value;
	}
}

// typescript-eslint EXTENSION rules supersede their core namesakes: wherever a `ts/*` rule is enabled (by
// antfu OR our refill), the identically-named core rule must be OFF on TS files — else both fire (double
// reports) and some core versions misfire on TS syntax. tseslint's own presets pair every extension enable
// with a base-off correctly; the collision is emergent from the MERGE — antfu may enable a CORE rule and
// skip its ts twin (fine alone), then our `all` refill adds the ts twin (antfu was silent on it), lighting
// both. So we reconcile the two sources here rather than assume either covered it.
const coreNames = new Set(Object.keys(js.configs.all?.rules ?? {}));
const supersede: Record<string, "off"> = {};

for (const rule of Object.keys(tsPlugin?.rules ?? {})) {
	if (!coreNames.has(rule)) {
		continue;
	}

	const tsId = `ts/${rule}`;

	if ((tsId in antfuRules && !isOff(antfuRules[tsId])) || tsId in tsFill) {
		supersede[rule] = "off";
	}
}

// Severity policy: any rule ESLint can auto-fix becomes a WARNING — silently fixed on save + hidden in the
// IDE via `eslint.quiet`, so it never squiggles; everything else stays an ERROR a human must act on. Driven
// off each rule's `meta.fixable` (the exact, automated form of antfu's `style/*`/`*-indent` IDE glob list).
// Applied to antfu + our fills, preserving each rule's options and file-scoping; L4 comes AFTER and wins, so
// a rule Brian pins in L4 keeps whatever severity he gave it.
function ruleMeta(id: string): { "deprecated"?: unknown; "fixable"?: unknown } | undefined {
	const slash = id.indexOf("/");

	if (slash === -1) {
		// eslint-disable-next-line ts/no-deprecated -- `builtinRules` (use-at-your-own-risk) is the only build-time source of core-rule metadata
		return builtinRules.get(id)?.meta;
	}

	return plugins[id.slice(0, slash)]?.rules?.[id.slice(slash + 1)]?.meta;
}

function fixable(id: string): boolean {
	return ruleMeta(id)?.fixable !== undefined;
}

function isDeprecated(id: string): boolean {
	return Boolean(ruleMeta(id)?.deprecated);
}

function hushFixable<T extends { "rules"?: Record<string, unknown> }>(block: T): T {
	if (block.rules === undefined) {
		return block;
	}

	const rules: Record<string, unknown> = {};

	for (const [id, value] of Object.entries(block.rules)) {
		const level = Array.isArray(value) ? value[0] : value;
		const enabled = level !== "off" && level !== 0;

		rules[id] = enabled && fixable(id) ? (Array.isArray(value) ? ["warn", ...value.slice(1)] : "warn") : value;
	}

	return { ...block, "rules": rules };
}

// antfu sets `style/indent` with `ignoreComments: false`, which is what re-mangles comment indentation inside
// switches / broken method chains on --fix. Flip it to true (live, keeping antfu's other indent options) so
// comment placement is left to the author and never auto-moved.
function ignoreIndentComments<T extends { "rules"?: Record<string, unknown> }>(block: T): T {
	const indent = block.rules?.["style/indent"];

	if (!Array.isArray(indent)) {
		return block;
	}

	const options = typeof indent[2] === "object" && indent[2] !== null ? { ...(indent[2] as Record<string, unknown>), "ignoreComments": true } : { "ignoreComments": true };

	return { ...block, "rules": { ...block.rules, "style/indent": [indent[0], indent[1], options] } };
}

// A disabled rule must be turned off wherever it's currently ENABLED — else the "off" either misses the rule
// (wrong file scope, e.g. jsonc/* only runs on JSON) or errors ("plugin not found" on files where the plugin
// isn't registered). So for each disable, gather the file globs of every block that turns it on (antfu's own
// blocks, narrowly-scoped as they are, plus our GLOB_SRC/GLOB_TS fills) and emit the "off" under exactly those.
function enablingFiles(id: string): unknown[] | null {
	const files: unknown[] = [];

	for (const config of configs) {
		const value = config.rules?.[id];

		if (value !== undefined && !isOff(value)) {
			if (config.files === undefined) {
				return null; // antfu enables it in a GLOBAL (unscoped) block → the disable must be global too (else it misses non-code files like tsconfig.json)
			}

			files.push(...(config.files as unknown[]));
		}
	}

	if (id in srcFill) {
		files.push(GLOB_SRC);
	}

	if (id in tsFill) {
		files.push(GLOB_TS);
	}

	return files.length > 0 ? files : [GLOB_SRC];
}

const disabledBlocks = Object.entries(disabled).map(([id, value]) => {
	const files = enablingFiles(id);

	return files === null ? { "rules": { [id]: value } } : { "files": files, "rules": { [id]: value } };
});

// Brian writes JSON-in-YAML (flow `{ }`/`[ ]`, quoted, inner-spaced) — configure the yaml plugin to ENFORCE
// that style instead of fighting it: flip each rule to the opposite of its default so his code is compliant.
const yamlFiles: unknown[] = [];

for (const config of configs) {
	if (config.files !== undefined && Object.keys(config.rules ?? {}).some((id) => id.startsWith("yaml/"))) {
		for (const file of config.files as unknown[]) {
			if (!yamlFiles.includes(file)) {
				yamlFiles.push(file);
			}
		}
	}
}

const yamlRules = {
	"yaml/plain-scalar": ["warn", "never"], // require quotes, not plain scalars
	"yaml/block-mapping": ["warn", "never"], // require flow `{ }`, not block mappings
	"yaml/block-sequence": ["warn", "never"], // require flow `[ ]`, not block sequences
	"yaml/flow-mapping-curly-spacing": ["warn", "always"], // Brian writes `{ "a": 1 }` WITH inner spaces
	"yaml/flow-sequence-bracket-newline": ["warn", "consistent"],
	"yaml/spaced-comment": "off" // comments hands-off, like everywhere else
};

// JSON/JSONC: Brian wants CONSISTENT indent but not tabs (antfu inherits the global `tab` → forces tabs on
// JSON, where his files are a 2/4-space mix). Pin to 2 spaces (the JSON/package.json convention). Scoped to
// wherever antfu runs jsonc/indent.
const jsoncFiles: unknown[] = [];

for (const config of configs) {
	if (config.files !== undefined && (config.rules ?? {})["jsonc/indent"] !== undefined) {
		for (const file of config.files as unknown[]) {
			if (!jsoncFiles.includes(file)) {
				jsoncFiles.push(file);
			}
		}
	}
}

export default [
	...configs.map(hushFixable).map(ignoreIndentComments),
	hushFixable({ "files": [GLOB_SRC], "rules": srcFill }),
	hushFixable({ "files": [GLOB_TS], "rules": tsFill }),
	{ "files": [GLOB_TS], "rules": supersede },
	{ "files": [GLOB_TS], "rules": { ...errors, ...warnings, ...downgrades, ...unsure } },
	...disabledBlocks,
	...(yamlFiles.length > 0 ? [{ "files": yamlFiles, "rules": yamlRules }] : []),
	...(jsoncFiles.length > 0 ? [{ "files": jsoncFiles, "rules": { "jsonc/indent": ["warn", 2] } }] : [])
];
