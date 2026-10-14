/**
 * silo — the CAPABILITY axis kernel (pure, browser-portable). Extracted from the `silo` prototype
 * (dogfooded in `ok-claude`); was `detect/analysis-core.ts` + `detect/capability-detectors.ts`.
 *
 * The capabilities code implies (fs:read, fs:write, net, exec, env, eval), and the shape of a consumer surface —
 * which specifiers + members a file imports (read by `./reach`'s surfaceOf). Pure string logic ONLY: no
 * parser, fs, git, node:module, network, or top-level side effects, so it runs unchanged in Node AND the browser.
 * Keep it pure, or it stops being portable. The Node orchestration around it — file walking, node_modules version
 * resolution, the `.silo/` baseline — lives in `./audit`.
 */


/**
 * PURE capability detectors. Regexes over source text (run over un-minified / deobfuscated code):
 * import-based detectors survive minification; call-based ones give fs:read/write granularity.
 */
const imp = (m: string) => new RegExp(`from\\s*["']node:${m}["']|require\\(\\s*["'](?:node:)?${m}["']\\s*\\)`);

/** The call-based names per capability, as DATA — the single source both the regex `DETECTORS` below and the
 *  AST matchers in `./reach` build from (a bare `writeFile(` and an `fs.writeFile(` both count). */
export const CALL_DETECTORS: Record<string, string[]> = {
	"exec": ["spawnSync", "spawn", "execFileSync", "execFile", "execSync", "fork"],
	"fs:write": ["writeFileSync", "writeFile", "createWriteStream", "mkdirSync", "mkdir", "unlinkSync", "unlink", "rmSync", "renameSync", "appendFileSync"],
	"fs:read": ["readFileSync", "readFile", "createReadStream", "readdirSync", "readdir", "existsSync", "statSync"]
};

const callRe = (names: string[]) => new RegExp(`\\b(${names.join("|")})\\s*\\(`);

export const DETECTORS: [RegExp, string][] = [
	[imp("child_process"), "exec"],
	[callRe(CALL_DETECTORS["exec"]), "exec"],   // call-based (deobfuscated/bare)
	[imp("(net|http|https|tls|dgram|http2)"), "net"],
	[/\bfetch\s*\(|\bnew WebSocket\b/, "net"],
	[/\beval\s*\(|new Function\s*\(/, "eval"],
	[/\bprocess\.env\b/, "env"],
	[callRe(CALL_DETECTORS["fs:write"]), "fs:write"],
	[callRe(CALL_DETECTORS["fs:read"]), "fs:read"],
	[imp("fs"), "fs"]   // coarse — dropped by refine() if read/write seen
];

export function detect(code: string): string[] {
	return refine(DETECTORS.filter(([re]) => re.test(code)).map(([, c]) => c));
}

/** A package's code files: what `detect` reads of it. */
const CODE_FILE = /\.[cm]?js$/u;

/** npm's install hooks: the code that runs without being imported. A hook is a shell command, so its mere existence is
 *  `exec` at install time — the classic supply-chain vector, in package.json, not the file tree. (`bin` isn't one: a bin
 *  only runs if you invoke it.) */
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

/**
 * What a package's own code can do, from its files however they were read — node_modules on the desktop, its published
 * tarball in the editor — by path within the package: `detect` over each code file, never what it depends on (each
 * dependency is its own), plus its install hooks (`exec`, and whatever a hook's command reveals). The one package
 * analysis both front ends run. Pure.
 */
export function packageCaps(files: Iterable<readonly [string, string]>): string[] {
	const caps = new Set<string>();

	for (const [path, text] of files) {
		if (CODE_FILE.test(path)) {
			for (const cap of detect(text)) {
				caps.add(cap);
			}
		} else if (path === "package.json") {
			let scripts: Record<string, unknown> = {};

			try {
				scripts = (JSON.parse(text) as { "scripts"?: Record<string, unknown> }).scripts ?? {};
			} catch { /* not JSON: no hooks to read */ }

			for (const hook of INSTALL_HOOKS.filter((each) => typeof scripts[each] === "string")) {
				for (const cap of ["exec", ...detect(scripts[hook] as string)]) {
					caps.add(cap);
				}
			}
		}
	}

	return [...caps].sort();
}

/** Drop the indeterminate marker and the coarse `fs` when a granular fs:read/write is present. */
export function refine(caps: Iterable<string>): string[] {
	const s = new Set(caps);

	s.delete("?");
	if (s.has("fs:read") || s.has("fs:write")) { s.delete("fs"); }

	return [...s].sort();
}

// Node's public builtin module names, inlined (node:module's `builtinModules` isn't available in the
// browser). Matched in both bare and `node:`-prefixed forms.
const BUILTIN_NAMES = [
	"assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
	"crypto", "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises",
	"http", "http2", "https", "inspector", "inspector/promises", "module", "net", "os", "path", "path/posix",
	"path/win32", "perf_hooks", "process", "punycode", "querystring", "readline", "readline/promises", "repl",
	"stream", "stream/consumers", "stream/promises", "stream/web", "string_decoder", "sys", "timers",
	"timers/promises", "tls", "trace_events", "tty", "url", "util", "util/types", "v8", "vm", "wasi",
	"worker_threads", "zlib", "sea", "sqlite", "test", "test/reporters"
];
const BUILTINS = new Set(BUILTIN_NAMES.flatMap((m) => { const bare = m.replace(/^node:/u, ""); return [bare, "node:" + bare]; }));

/** Kind + package name for a specifier. Version resolution (node_modules) is Node-only — do it separately. */
export function classifyKind(spec: string): { "kind": "builtin" | "package" | "local"; "pkg"?: string } {
	if (spec.startsWith("node:") || BUILTINS.has(spec)) { return { "kind": "builtin" }; }
	if (spec.startsWith(".") || spec.startsWith("/")) { return { "kind": "local" }; }
	const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

	return { "kind": "package", "pkg": pkg };
}

export interface Use { "members": Set<string>; "dynamic": boolean }
export type Surface = Map<string, Use>;   // specifier -> consumed members
export interface SurfaceEntry { "members": string[]; "dynamic": boolean }

export function add(s: Surface, spec: string, member: string, dynamic = false): void {
	const u = s.get(spec) ?? { "members": new Set<string>(), "dynamic": false };

	if (member) { u.members.add(member); }
	if (dynamic) { u.dynamic = true; }
	s.set(spec, u);
}

/** One dependency as a workspace's code uses it: what kind of specifier, the version installed, the members its code
 *  imports (`dynamic`: some it can't name), and the capabilities those reach — a builtin's by its members, a package's
 *  by its slice (`./slice`, the join; the whole package's when no slice could be built). `grew`: each capability its
 *  reach gained after the baseline was made, with what brought it in — the members the code started using, or the
 *  version it moved to (evidence's syncConsumer). */
export interface DepEntry { "kind": string; "version"?: string; "members": string[]; "dynamic": boolean; "caps": string[]; "grew"?: Record<string, string> }
export type WsConsumer = Record<string, DepEntry>;   // spec → dep, for one workspace

/**
 * The baseline's `consumer` — each workspace's use of its dependencies — from each workspace's merged surface:
 * local specifiers left out (own files), a builtin's capabilities read off its members (builtinCaps), a package's
 * version as `versionOf` says (node_modules on desktop, the editor's resolved versions in the browser). Pure.
 */
export function consumerOf(surfaces: Record<string, Record<string, SurfaceEntry>>, versionOf: (workspace: string, pkg: string) => string | undefined): Record<string, WsConsumer> {
	const out: Record<string, WsConsumer> = {};

	for (const workspace of Object.keys(surfaces).sort()) {
		const current: WsConsumer = {};

		out[workspace] = current;

		for (const [spec, use] of Object.entries(surfaces[workspace]).sort(([one], [other]) => one.localeCompare(other))) {
			const kind = classifyKind(spec);

			if (kind.kind !== "local") {
				const version = kind.pkg === undefined ? undefined : versionOf(workspace, kind.pkg);

				current[spec] = { "kind": kind.kind, ...version === undefined ? {} : { "version": version }, "members": use.members, "dynamic": use.dynamic, "caps": kind.kind === "builtin" ? builtinCaps(spec, use.members, use.dynamic) : [] };
			}
		}
	}

	return out;
}

/** A surface as the baseline writes it: members sorted, a Set no longer. */
export const surfaceEntries = (surface: Surface): Record<string, SurfaceEntry> => Object.fromEntries([...surface].map(([spec, use]) => [spec, { "members": [...use.members].sort(), "dynamic": use.dynamic }]));

/** Builtins ARE capabilities — map (specifier, members) directly, no bundling. */
export function builtinCaps(spec: string, members: string[], dynamic = false): string[] {
	const base = spec.replace(/^node:/u, "");
	const caps = new Set<string>();

	if (base === "fs" || base === "fs/promises") {
		for (const m of members) {
			if (/^(read|exists|stat|realpath|access|opendir|watch|lstat)/u.test(m) || m === "createReadStream") { caps.add("fs:read"); } else if (/^(write|append|mkdir|unlink|rm|rename|cp|copy|chmod|chown|truncate|symlink|link|utimes|open|mkdtemp)/u.test(m) || m === "createWriteStream") { caps.add("fs:write"); } else { caps.add("fs"); }
		}

		if (dynamic || !members.length) { caps.add("fs"); }
		if (caps.has("fs:read") || caps.has("fs:write")) { caps.delete("fs"); }
	} else if (base === "child_process") { caps.add("exec"); } else if (["net", "http", "https", "http2", "tls", "dgram", "dns"].includes(base)) { caps.add("net"); } else if (base === "vm") { caps.add("eval"); }

	return [...caps].sort();
}
