/**
 * juvy — a browser-safe config offering, based on convict 6.2.5, stripped to the isomorphic core.
 *
 * One offering, used in portions: config-only (works in the browser), + argv parsing (`.parse()`, via
 * `@pkgjs/parseargs`), + application structure (`.cli()`, via cmd-ts, lazy-loaded — separate module).
 *
 * The bespoke reason nothing off-the-shelf fits: the ENV SOURCE switches by runtime — Node reads
 * `process.env`, a browser/worker reads `globalThis` (so `window.MY_VAR` / `globalThis.MY_VAR`). Override
 * it with `{ env }`. Also folds in the `#379` convention: one canonical camelCase key derives its env var
 * (SCREAMING_SNAKE) and CLI flag (--kebab); minimal specs; `sensitive`. No fs; `.parse()` lazy-loads
 * `node:util` (native parseArgs) only when called, so the config core itself has zero dependencies.
 */
import { pascalCaseToKebabCase, pascalCaseToScreamingSnakeCase } from "@brianjenkins94/util/text"; // browser-safe (pure string ops)
import { getRuntime } from "@brianjenkins94/util/env"; // shared runtime detection (env pulls node:path/url — polyfilled at bundle time)

// ---------------------------------------------------------------------------------------------------------
// Helpers — no hand-rolled deep clone: config DATA uses native structuredClone (handles Date/RegExp/Map/Set),
// the schema (which holds format FUNCTIONS) is copied shallowly where mutated and JSON-projected by getSchema.
// ---------------------------------------------------------------------------------------------------------

function getByPath(object: any, path: string[]): any {
	return path.reduce((node, key) => {
		if (node === null || node === undefined || !Object.prototype.hasOwnProperty.call(node, key)) {
			throw new TypeError(`cannot read '${key}' of ${JSON.stringify(node)}`);
		}

		return node[key];
	}, object);
}

function getOrCreate(object: any, path: string[]): any {
	return path.reduce((node, key) => (node[key] ??= {}), object);
}

// ---------------------------------------------------------------------------------------------------------
// Built-in formats — each THROWS on a bad value (convict's `assert`, not juvy's old console.assert no-op)
// ---------------------------------------------------------------------------------------------------------

function assert(ok: boolean, message: string): void {
	if (!ok) { throw new Error(message); }
}

type FormatFn = (value: unknown) => void;

// String-format validators — dep-free equivalents of convict-format-with-validator (which pulls validator.js).
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u; // pragmatic, not RFC-exhaustive — good enough for config
// IPv6: full / compressed (::) / IPv4-mapped forms. Long, but a single dep-free literal.
const IPV6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(:[0-9a-fA-F]{1,4}){1,6}|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/u;

function isIPv4(value: string): boolean {
	const octets = value.split(".");

	return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255);
}

function isURL(value: string): boolean {
	// Accept a full URL; if it parses only once a scheme is prepended, it was a bare host (`example.com`) — still
	// a URL. Genuinely-malformed values (whitespace, empty) fail both and are rejected.
	for (const candidate of [value, `https://${value}`]) {
		if (URL.canParse(candidate)) { return true; }
	}

	return false;
}

const BUILT_IN_TYPES: Record<string, FormatFn> = {
	"*": () => { /* anything */ },
	"int": (x) => assert(Number.isInteger(x as number), "must be an integer"),
	"integer": (x) => assert(Number.isInteger(x as number), "must be an integer"),
	"nat": (x) => assert(Number.isInteger(x as number) && (x as number) >= 0, "must be a positive integer"),
	"port": (x) => assert(Number.isInteger(x as number) && (x as number) >= 0 && (x as number) <= 65535, "ports must be within range 0 - 65535"),
	"email": (x) => assert(EMAIL.test(String(x)), "must be an email address"),
	"url": (x) => assert(isURL(String(x)), "must be a URL (including protocol, e.g. https://…)"),
	"ipaddress": (x) => assert(isIPv4(String(x)) || IPV6.test(String(x)), "must be an IPv4 or IPv6 address")
};

const BUILT_IN_CTORS = { "Object": Object, "Array": Array, "String": String, "Number": Number, "Boolean": Boolean, "RegExp": RegExp } as const;

// ---------------------------------------------------------------------------------------------------------
// The runtime-switching env source (the killer feature). Node → process.env; browser/worker → globalThis.
// ---------------------------------------------------------------------------------------------------------

export type EnvSource = Record<string, unknown> | ((name: string) => unknown);

/** The default env source: `process.env` in Node, else the global object (`window`/`globalThis`). Detection is
 *  shared with `@brianjenkins94/util/env` (`getRuntime`, which resolves `browser` before `node`, so a bundler's
 *  process.env shim isn't mistaken for Node). Override per-instance with `juvy(schema, { env })`. */
export function pickEnvSource(): Record<string, unknown> {
	return getRuntime() === "node" ? (globalThis as any).process.env : (globalThis as any);
}

function readEnv(source: EnvSource, name: string): unknown {
	return typeof source === "function" ? source(name) : source[name];
}

// ---------------------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------------------

export interface PropertySchema {
	"default": unknown;
	/** Constructor (String/Number/…), a built-in type name ("port"/"int"/…), an enum array, or a validator fn. */
	"format"?: unknown;
	/** Env var to read from. Omitted → derived SCREAMING_SNAKE of the key path (#379). `false` opts out. */
	"env"?: string | false;
	/** CLI flag (no dashes). Omitted → derived --kebab of the key path (#379). Consumed by `.parse()`/the bridge. */
	"arg"?: string;
	"short"?: string;
	/** Take this value from a CLI positional argument (not a `--flag`) when used via the cmd-ts bridge. */
	"positional"?: boolean;
	"sensitive"?: boolean;
	"nullable"?: boolean;
	"doc"?: string;
}

export type Schema = Record<string, unknown>;

export interface JuvyOptions {
	"strict"?: boolean;
	/** Override the env source (object or accessor fn). Default = runtime switch (process.env ↔ globalThis). */
	"env"?: EnvSource;
	/** Set false to NOT auto-derive an env var for every leaf (#379 default is on). */
	"deriveEnv"?: boolean;
}

interface NormalizedProp extends PropertySchema {
	"_format": FormatFn;
	"_path": string;      // full dotted path
	"_arg": string;       // resolved CLI flag (kebab), for parse()/the bridge
	"_env"?: string;      // resolved env var name (or undefined if opted out)
}

interface SchemaNode {
	"_juvyProperties": Record<string, SchemaNode | NormalizedProp>;
}

function isNode(x: any): x is SchemaNode {
	return x !== null && typeof x === "object" && "_juvyProperties" in x;
}

function resolveFormat(prop: PropertySchema, fullName: string): FormatFn {
	const format = prop.format;

	// Built-in constructor (either the ctor itself or its name string)
	const ctorName = typeof format === "string" && format in BUILT_IN_CTORS
		? format
		: Object.entries(BUILT_IN_CTORS).find(([, ctor]) => ctor === format)?.[0];

	if (ctorName !== undefined) {
		const Ctor = BUILT_IN_CTORS[ctorName as keyof typeof BUILT_IN_CTORS];
		prop.format = Ctor.name.toLowerCase();

		return (x) => assert(Object.prototype.toString.call(x) === Object.prototype.toString.call(new (Ctor as any)()), `must be of type ${Ctor.name}`);
	}

	if (typeof format === "string") {
		const fn = BUILT_IN_TYPES[format];
		assert(fn !== undefined, `'${fullName}' uses an unknown format type: ${format}`);

		return fn;
	}

	if (Array.isArray(format)) {
		return (x) => assert(format.includes(x), `must be one of ${JSON.stringify(format)}`);
	}

	if (typeof format === "function") { return format as FormatFn; }

	assert(format === undefined || format === null, `'${fullName}': 'format' must be a function or a known format type.`);

	// No format → infer from the default value's runtime type.
	const type = Object.prototype.toString.call(prop.default);

	return (x) => assert(Object.prototype.toString.call(x) === type, `should be of type ${type.replace(/\[object (.*)\]/u, "$1")}`);
}

// ---------------------------------------------------------------------------------------------------------
// Coercion — env/argv values arrive as strings; coerce to the property's declared type
// ---------------------------------------------------------------------------------------------------------

function coerce(prop: NormalizedProp | undefined, value: unknown): unknown {
	if (typeof value !== "string" || prop === undefined) { return value; }

	switch (prop.format) {
		case "int": case "integer": case "nat": case "port": return parseInt(value, 10);
		case "number": return parseFloat(value);
		case "boolean": return value.toLowerCase() !== "false";
		case "array": return value.split(",");
		case "object": return JSON.parse(value);
		case "regexp": return new RegExp(value, "u");
		default: return value;
	}
}

// ---------------------------------------------------------------------------------------------------------
// The offering
// ---------------------------------------------------------------------------------------------------------

export interface Juvy {
	get(path: string): any;
	has(path: string): boolean;
	set(path: string, value: unknown): Juvy;
	default(path: string): any;
	reset(path: string): Juvy;
	load(values: Record<string, unknown>): Juvy;
	getProperties(): Record<string, any>;
	getSchema(): SchemaNode;
	/** #379 arg descriptors (flag/path/type/positional/short/doc) — drives `.parse()` and the cmd-ts bridge. */
	getArgSpecs(): Array<{ "flag": string; "path": string; "type": "string" | "boolean"; "positional": boolean; "short"?: string; "doc"?: string }>;
	validate(options?: { "strict"?: boolean }): Juvy;
	/** Portion: parse argv and load the result. Lazy-loads `node:util`, so it's async. Node front door. */
	parse(argv?: string[]): Promise<Juvy>;
	/** Seed `process.env` with the resolved config (for third-party code that reads `process.env.*` directly).
	 *  Fills only UNSET vars (never clobbers a real env var); objects are JSON-stringified. Node-only no-op. */
	seedEnv(): Juvy;
	/** Every property flagged `sensitive` (dotted paths). */
	sensitivePaths(): string[];
}

export function juvy(schema: Schema, options: JuvyOptions = {}): Juvy {
	const strictDefault = options.strict ?? true;
	const deriveEnv = options.deriveEnv ?? true;
	const envSource: EnvSource = options.env ?? pickEnvSource();

	const root: SchemaNode = { "_juvyProperties": {} };
	const envMap: Record<string, string[]> = {};   // ENV_NAME -> [paths]
	const propByPath: Record<string, NormalizedProp> = {};
	const sensitive: string[] = [];
	const instance: Record<string, any> = {};

	// --- normalize the schema (recursive), deriving env/flag names per #379 ---
	function normalize(name: string, node: unknown, props: Record<string, any>, fullName: string): void {
		assert(name !== "_juvyProperties", `'${fullName}': '_juvyProperties' is a reserved key`);
		assert(name !== "__proto__" && name !== "constructor" && name !== "prototype", `'${fullName}': reserved key`);

		// A nested namespace = a plain object with no `default`.
		if (node !== null && typeof node === "object" && !Array.isArray(node) && Object.keys(node).length > 0 && !("default" in (node as object))) {
			props[name] = { "_juvyProperties": {} };

			for (const key of Object.keys(node as object)) {
				normalize(key, (node as any)[key], props[name]["_juvyProperties"], `${fullName}.${key}`);
			}

			return;
		}

		// Shorthand: `key: value` → `{ default: value }`.
		const prop: PropertySchema = (node !== null && typeof node === "object" && !Array.isArray(node) && "default" in (node as object))
			? { ...(node as PropertySchema) } // shallow — we add fields; `format`/validator fn stays by reference
			: { "default": node };

		const normalized = prop as NormalizedProp;
		normalized._path = fullName;
		normalized._format = resolveFormat(prop, fullName);

		// #379: derive env (SCREAMING_SNAKE) + flag (--kebab) from the key path unless given / opted out.
		// #379 derivation: `server.maxCount` → flag `--server-max-count`, env `SERVER_MAX_COUNT` (dots → separators).
		normalized._arg = prop.arg ?? pascalCaseToKebabCase(fullName).replaceAll(".", "-");
		normalized._env = prop.env === false ? undefined : (prop.env ?? (deriveEnv ? pascalCaseToScreamingSnakeCase(fullName).replaceAll(".", "_") : undefined));

		if (normalized._env !== undefined) { (envMap[normalized._env] ??= []).push(fullName); }
		if (prop.sensitive) { sensitive.push(fullName); }

		props[name] = normalized;
		propByPath[fullName] = normalized;
	}

	for (const key of Object.keys(schema)) { normalize(key, schema[key], root["_juvyProperties"], key); }

	// --- seed defaults into the instance ---
	(function seed(node: SchemaNode, target: Record<string, any>): void {
		for (const [key, child] of Object.entries(node["_juvyProperties"])) {
			if (isNode(child)) { seed(child, target[key] ??= {}); } else { target[key] = coerce(child, structuredClone(child.default)); }
		}
	})(root, instance);

	function importEnv(): void {
		for (const [envName, paths] of Object.entries(envMap)) {
			const value = readEnv(envSource, envName);

			if (value !== undefined) { for (const path of paths) { api.set(path, value as string); } }
		}
	}

	const api: Juvy = {
		get(path) { return structuredClone(getByPath(instance, path.split("."))); },
		has(path) {
			try { getByPath(instance, path.split(".")); return true; } catch { return false; }
		},
		set(path, value) {
			const keys = path.split(".");
			const leaf = keys.pop()!;
			getOrCreate(instance, keys)[leaf] = coerce(propByPath[path], value);

			return api;
		},
		default(path) { return structuredClone(propByPath[path]?.default); },
		reset(path) { return api.set(path, structuredClone(propByPath[path]?.default)); },
		load(values) {
			(function overlay(from: Record<string, any>, prefix: string): void {
				for (const [key, value] of Object.entries(from)) {
					const path = prefix ? `${prefix}.${key}` : key;

					if (value !== null && typeof value === "object" && !Array.isArray(value) && propByPath[path] === undefined) {
						overlay(value, path); // descend into namespaces
					} else {
						api.set(path, value);
					}
				}
			})(values, "");

			return api;
		},
		getProperties() { return structuredClone(instance); },
		getSchema() { return JSON.parse(JSON.stringify(root)); },
		getArgSpecs() {
			return Object.values(propByPath).map((prop) => ({
				"flag": prop._arg,
				"path": prop._path,
				"type": (prop.format === "boolean" || prop.format === Boolean) ? "boolean" as const : "string" as const,
				"positional": prop.positional === true,
				...(prop.short !== undefined ? { "short": prop.short } : {}),
				...(prop.doc !== undefined ? { "doc": prop.doc } : {})
			}));
		},
		validate(validateOptions = {}) {
			const strict = validateOptions.strict ?? strictDefault;
			const errors: string[] = [];
			const seen = new Set<string>();

			for (const [path, prop] of Object.entries(propByPath)) {
				seen.add(path);
				let value: unknown;

				try { value = getByPath(instance, path.split(".")); } catch { errors.push(`'${path}' is missing from config`); continue; }

				if (prop.nullable && value === null) { continue; }

				try { prop._format(value); } catch (error) { errors.push(`'${path}': ${(error as Error).message} (got ${JSON.stringify(value)})`); }
			}

			if (strict) {
				(function walk(node: Record<string, any>, prefix: string): void {
					for (const [key, value] of Object.entries(node)) {
						const path = prefix ? `${prefix}.${key}` : key;

						if (propByPath[path] !== undefined || seen.has(path)) { continue; }

						if (value !== null && typeof value === "object" && !Array.isArray(value)) { walk(value, path); } else { errors.push(`'${path}' is not declared in the schema`); }
					}
				})(instance, "");
			}

			if (errors.length > 0) { throw new Error("juvy validation failed:\n  - " + errors.join("\n  - ")); }

			return api;
		},
		async parse(argv = (globalThis as any).process?.argv?.slice(2) ?? []) {
			// node's util.parseArgs (native + typed). `.parse()` is a Node front door — browsers have no argv —
			// so this stays node:util; alias it to @pkgjs/parseargs via @external only if you ever need it in-browser.
			const { parseArgs } = await import("node:util");
			const specs = api.getArgSpecs();
			const flagSpecs = specs.filter((spec) => !spec.positional);
			const positionalSpecs = specs.filter((spec) => spec.positional);
			const parseOptions: Record<string, { "type": "string" | "boolean"; "short"?: string }> = {};

			for (const spec of flagSpecs) { parseOptions[spec.flag] = { "type": spec.type, ...(spec.short ? { "short": spec.short } : {}) }; }

			// strict → reject unknown flags (parity with cmd-ts); trim parseArgs' verbose positional hint.
			let values: Record<string, unknown>;
			let positionals: string[];

			try {
				({ values, positionals } = parseArgs({ "args": argv, "options": parseOptions, "allowPositionals": true, "strict": true }));
			} catch (error) {
				throw new Error((error as Error).message.replace(/\.\s+To [\s\S]*/u, "."), { "cause": error });
			}

			const byFlag = new Map(flagSpecs.map((spec) => [spec.flag, spec.path]));

			for (const [flag, value] of Object.entries(values)) {
				const path = byFlag.get(flag);

				if (path !== undefined && value !== undefined) { api.set(path, value as string | boolean); }
			}

			// positionals map to `positional: true` props by declaration order
			positionalSpecs.forEach((spec, index) => {
				if (positionals[index] !== undefined) { api.set(spec.path, positionals[index]); }
			});

			return api;
		},
		seedEnv() {
			const env = (globalThis as any).process?.env;

			if (env === undefined) { return api; } // browser / no process — nothing to seed

			for (const prop of Object.values(propByPath)) {
				if (prop._env === undefined || env[prop._env] !== undefined) { continue; } // skip un-mapped + already-set

				const value = api.get(prop._path);
				env[prop._env] = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
			}

			return api;
		},
		sensitivePaths() { return [...sensitive]; }
	};

	importEnv();

	return api;
}
