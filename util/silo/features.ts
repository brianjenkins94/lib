/**
 * silo — a program's features, found in its code (pure, browser-portable): every WAY IN — something a person, an agent
 * or another part of the program can reach — read from the source and the manifests, never kept by hand. The base of
 * derived history (`./history`): a feature is a way in plus the code it reaches, and its life (added, changed, moved,
 * removed) is a function of the code's snapshots (editor's packages/editor/CHANGE-HISTORY.md).
 *
 * Ways in, by kind (`facet`):
 *   • VS Code manifests (`contributes`) — commands, views, settings, debuggers, keybindings and menus (a keybinding or a
 *     menu entry is a facet of its command, not a feature of its own).
 *   • VS Code API calls — `registerCommand`, `register…Provider`, `create{TreeView,StatusBarItem,…}`.
 *   • hub — `serve(hub, "name", …)` requests and `hub.subscribe("subject", …)` subscriptions.
 *   • workers — a module that listens for messages at its top level (`addEventListener("message", …)`, `onmessage = …`):
 *     started by a URL rather than imported, so its listener is how the rest of the program reaches it.
 *   • MCP tools — an object literal with a `name`, a `description` and a handler or schema (`defineTool`'s keeps its
 *     description and schema in a `config`); CLI commands — the same shape passed to `command(…)`.
 *   • terminal commands (`defineCommand("name", …)`), URL parameters read from `location`, buttons (a JSX `<…button>` with
 *     a literal `aria-label` or `title`), and core modules (a call to an imported `install…` function).
 *
 * A feature is keyed by WHAT it is (`command|editor.debugFile`), never where it lives, so a moved file moves its
 * features rather than removing and re-adding them. Each way in carries a FINGERPRINT of its own code — the registration
 * call with its inline handler, as the AST without positions — so a change in comments or whitespace isn't a change —
 * and where that code leads (`roots`, node ids in the program's declaration graph, `./graph`), so a change anywhere it
 * reaches is a change to it. oxc's recognizers are here; `./ts-analysis` has the same over TypeScript's tree.
 *
 * `oxc` + pure AST logic only, the same portability contract as `./detect`: no fs, git or network.
 */

import { isEntry } from "@brianjenkins94/util/env";

/** One way in, as one file states it. A command's declaration (manifest) and registration (code) are two of these. */
export interface WayIn {
	"facet": string;
	/** For commands and views: which side this file gives — declared (manifest), registered (code), or a keybinding / menu entry. */
	"side"?: string;
	"id": string;
	"label": string;
	/** Keyed by its file too: it has no name of its own (a provider registered for a selector). */
	"weak"?: boolean;
	/** Where its registration is in its file: offsets of the code that states it (with its inline handler). */
	"range"?: [number, number];
	/** The fingerprint of its own code. */
	"code"?: string;
	/** Where its code leads, as node ids (`file#name`): the names it uses that its file declares or imports (a local of the
	 *  function it's registered in counts as what that local is made from). */
	"roots"?: string[];
}

/** A feature: one way in, merged across the files that state it. */
export interface Feature {
	"key": string;
	"facet": string;
	"id": string;
	"label": string;
	/** The files that implement it (a manifest only when nothing else does). */
	"files": string[];
	"sides": string[];
	"code": string[];
	/** Where it starts in the program's declaration graph: the names its ways in use, as node ids (`file#name`). */
	"roots": string[];
	/** Where its registrations are: each file's offsets of the code that states it — its own code, beside its roots. */
	"ranges": { "file": string; "start": number; "end": number }[];
}

/** Internal ways in: how a program's parts reach each other, not what a person or an agent reaches. */
export const INTERNAL_FACETS = new Set(["hub request", "hub subscription", "worker"]);

export const isManifest = (file: string): boolean => /(^|\/)package\.json$/u.test(file);
export const isSource = (file: string): boolean => /\.[cm]?[jt]sx?$/u.test(file) && !/\.d\.[cm]?ts$/u.test(file);

// What the recognizers look for — shared with TypeScript's (`./ts-analysis`), so both name a way in the same.
/** A VS Code API `register…` call that is a way in (a provider, a factory, a URI handler, a notebook serializer). */
export const REGISTER = /^register(?:\w*(?:Provider|Factory)|UriHandler|NotebookSerializer)$/u;
/** A VS Code API `create…` call that is a way in (a view, a status bar item, a terminal, …). */
export const CREATE = /^(?:createTreeView|createWebviewPanel|createStatusBarItem|createOutputChannel|createSourceControl|createTestController|createDiagnosticCollection|createTerminal|createTextEditorDecorationType|createCommentController)$/u;
/** The receivers a `create…` call has to be on. */
export const CREATE_RECEIVER = /window|languages|scm|tests|comments|vscode|api/u;
/** The keys that make an object with a `name` and a `description` an agent tool. */
export const TOOL_KEYS = ["handler", "inputSchema", "input", "run", "call", "schema"];
/** An agent tool's name. */
export const TOOL_NAME = /^[a-z][a-z0-9_.]*$/u;
/** A CLI command's name. */
export const CLI_NAME = /^[a-z][\w.:-]*$/u;
/** The call that makes an object literal a CLI command (juvy's, cmd-ts's `command({ name, description, … })`). */
export const CLI_CALL = "command";
/** `registerHoverProvider` → `hover provider`, `createTreeView` → `tree view`. */
export const words = (name: string): string => name.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
/** A description's first sentence: a way in's label. */
export const firstSentence = (text: string): string => text.split(/\.\s|\n/u)[0].slice(0, 120);

/** How a recognizer reads an object literal in its own tree (oxc's, TypeScript's). */
export interface ObjectReader<N> {
	/** A property's value, by its key. */
	"property": (object: N, key: string) => N | undefined;
	/** A string literal's value. */
	"literal": (node: N | undefined) => string | undefined;
	"isObject": (node: N | undefined) => boolean;
	/** A `+` concatenation's left operand. */
	"left": (node: N | undefined) => N | undefined;
}

/** A description's text, enough for its label: a string, or the one a concatenation (`"Run it" + more`) starts with. */
function textOf<N>(node: N | undefined, read: ObjectReader<N>): string | undefined {
	return read.literal(node) ?? (read.left(node) === undefined ? undefined : textOf(read.left(node), read));
}

/**
 * An object literal that's an agent tool: a `name` and a `description` with a handler or a schema — beside them, or in
 * its `config`, as util/mcp's `defineTool({ name, config: { description, inputSchema }, handler })` writes one. Keyed by
 * its name alone, so a tool moved to another file, or into `config`, is the same tool.
 */
export function agentTool<N>(object: N, read: ObjectReader<N>): WayIn | undefined {
	const name = read.literal(read.property(object, "name"));
	const config = read.property(object, "config");
	const sides = read.isObject(config) ? [object, config] : [object];
	const description = sides.map((side) => textOf(read.property(side, "description"), read)).find((each) => each !== undefined);

	if (name === undefined || description === undefined || !TOOL_NAME.test(name) || !TOOL_KEYS.some((key) => sides.some((side) => read.property(side, key) !== undefined))) {
		return undefined;
	}

	return { "facet": "agent tool", "id": name, "label": firstSentence(description) };
}

/** `command({ name, description, … })`'s object: a CLI command — shaped like an agent tool, but a person's way in. */
export function cliCommand<N>(object: N, read: ObjectReader<N>): WayIn | undefined {
	const name = read.literal(read.property(object, "name"));

	if (name === undefined || !CLI_NAME.test(name)) {
		return undefined;
	}

	return { "facet": "cli command", "id": name, "label": firstSentence(textOf(read.property(object, "description"), read) ?? "") };
}

// ── ways in ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The ways in a VS Code extension manifest (`package.json` `contributes`) declares. */
export function waysInManifest(text: string): WayIn[] {
	let contributes: Record<string, any> | undefined;

	try {
		contributes = JSON.parse(text)["contributes"];
	} catch {
		return [];
	}

	if (contributes === undefined) {
		return [];
	}

	const ways: WayIn[] = [];

	for (const command of contributes["commands"] ?? []) {
		ways.push({ "facet": "command", "side": "declared", "id": command.command, "label": (command.category ? command.category + ": " : "") + command.title });
	}

	for (const views of Object.values<any[]>(contributes["views"] ?? {})) {
		for (const view of views) {
			ways.push({ "facet": "view", "side": "declared", "id": view.id, "label": view.name ?? "" });
		}
	}

	for (const configuration of [contributes["configuration"] ?? []].flat()) {
		for (const [key, setting] of Object.entries<any>(configuration.properties ?? {})) {
			ways.push({ "facet": "setting", "id": key, "label": firstSentence(String(setting.markdownDescription ?? setting.description ?? "")) });
		}
	}

	for (const debuggerContribution of contributes["debuggers"] ?? []) {
		ways.push({ "facet": "debugger", "side": "declared", "id": debuggerContribution.type, "label": debuggerContribution.label ?? "" });
	}

	for (const keybinding of contributes["keybindings"] ?? []) {
		ways.push({ "facet": "command", "side": "keybinding", "id": keybinding.command, "label": "" });
	}

	for (const [where, items] of Object.entries<any[]>(contributes["menus"] ?? {})) {
		for (const item of items) {
			if (item.command !== undefined) {
				ways.push({ "facet": "command", "side": "menu:" + where, "id": item.command, "label": "" });
			}
		}
	}

	return ways;
}

/** A way in's key: what it is, never where it lives (but a way in with no name is keyed by its file's name). */
export function keyOf(way: WayIn, file: string): string {
	const weak = way.weak === true || way.id === "" || way.id === "*";

	return way.facet + "|" + way.id + (weak ? "|" + file.slice(file.lastIndexOf("/") + 1) : "");
}

/** Every file's ways in, merged into features. */
export function featuresOf(files: Iterable<{ "file": string; "ways": WayIn[] }>): Map<string, Feature> {
	const features = new Map<string, Feature>();

	for (const { file, ways } of files) {
		for (const way of ways) {
			const key = keyOf(way, file);
			let feature = features.get(key);

			if (feature === undefined) {
				feature = { "key": key, "facet": way.facet, "id": way.id, "label": "", "files": [], "sides": [], "code": [], "roots": [], "ranges": [] };
				features.set(key, feature);
			}

			// A declaration's label wins (it's what a person sees); otherwise the first one stated.
			if (way.label !== "" && (feature.label === "" || way.side === "declared")) {
				feature.label = way.label;
			}

			if (way.side !== undefined && !feature.sides.includes(way.side)) {
				feature.sides.push(way.side);
			}

			if (way.code !== undefined) {
				feature.code.push(way.code);
			}

			if (way.range !== undefined) {
				feature.ranges.push({ "file": file, "start": way.range[0], "end": way.range[1] });
			}

			for (const root of way.roots ?? []) {
				if (!feature.roots.includes(root)) {
					feature.roots.push(root);
				}
			}

			// The files that implement it; a manifest only while nothing else does.
			const implementing = !isManifest(file) || way.side === undefined;

			if (!feature.files.includes(file) && (implementing || feature.files.length === 0)) {
				feature.files = implementing ? [...feature.files.filter((each) => !isManifest(each)), file] : [file];
			}
		}
	}

	for (const feature of features.values()) {
		feature.files.sort();
		feature.code.sort();
		feature.roots.sort();
	}

	return features;
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		// Both readings, oxc's and TypeScript's. (Specifiers made at run time, so a bundler of this module doesn't follow
		// them into either: the tests only run here.)
		const { waysIn }: typeof import("./oxc") = await import(/* @vite-ignore */ ["./oxc"].join(""));
		const { analyzeFile, classicHost }: typeof import("./ts-analysis") = await import(/* @vite-ignore */ ["./ts-analysis"].join(""));
		const ts: typeof import("typescript") = (await import(/* @vite-ignore */ ["typescript"].join(""))).default;

		function tsWaysIn(file: string, text: string): WayIn[] {
			const options = { "allowJs": true, "noLib": true, "noResolve": true };
			const host = { ...ts.createCompilerHost(options), "fileExists": (name: string) => name === "/r/" + file, "readFile": () => text, "getSourceFile": (name: string, target: any) => ts.createSourceFile(name, text, target, true) };
			const program = ts.createProgram(["/r/" + file], options, host);

			return analyzeFile(classicHost(ts, program, (name) => name.slice(3)), file, program.getSourceFile("/r/" + file), text, "v1").ways;
		}

		/** What a file states, the same in both readings: `facet id · label`. */
		function stated(file: string, text: string): string[] {
			const [oxc, typescript] = [waysIn(file, text), tsWaysIn(file, text)].map((ways) => ways.map((way) => way.facet + " " + way.id + (way.label === "" ? "" : " · " + way.label)).sort());

			assert.deepEqual(typescript, oxc, "both readings agree");

			return oxc;
		}

		// An agent tool: its description and schema beside its name, or in util/mcp's `defineTool` `config`.
		assert.deepEqual(stated("tools.ts", `const eval = { "name": "page_eval", "description": "Evaluate it. Awaited.", "inputSchema": { "type": "object" } };\nexport const run = defineTool({ "name": "terminal_run", "config": { "description": "Run a command line" + (more ? "; and " + more : "") + ". Each call is its own shell.", "inputSchema": {} }, "handler": run });\nexport const tools = [defineTool({ "name": "runs_ledger", "config": { "description": "The run ledger. Newest first.", "inputSchema": {} }, "handler": async () => ok(1) })];\n`), ["agent tool page_eval · Evaluate it", "agent tool runs_ledger · The run ledger", "agent tool terminal_run · Run a command line"]);

		// Not agent tools: no handler or schema (in either place), or not a tool's name.
		assert.deepEqual(stated("other.ts", `const a = { "name": "x", "description": "Only words." };\nconst b = { "name": "pkg", "config": { "description": "A package." } };\nconst c = { "name": "Some Name", "description": "A person.", "handler": f };\n`), []);

		// A CLI command (juvy's, cmd-ts's `command({…})`) is shaped like a tool, but it's a CLI command.
		assert.deepEqual(stated("cli.ts", `run(command({ "name": "history", "description": "What changed. Told from the code.", "config": juvy({}), "handler": (config) => 0 }));\nconst build = command({ name: "build-all", args: {}, handler: () => 0 });\n`), ["cli command build-all", "cli command history · What changed"]);

		// A tool moved to another file and into `defineTool`'s shape is the same feature, not one removed and one added.
		const before = { "file": "tools/files.ts", "ways": waysIn("tools/files.ts", `export const read = { "name": "files_read", "description": "Read a file.", "handler": read };\n`) };
		const after = { "file": "tools/files/tools.ts", "ways": waysIn("tools/files/tools.ts", `export default [defineTool({ "name": "files_read", "config": { "description": "Read a file.", "inputSchema": {} }, "handler": read })];\n`) };

		assert.deepEqual([...featuresOf([before]).keys()], [...featuresOf([after]).keys()]);
		assert.deepEqual([...featuresOf([after]).keys()], ["agent tool|files_read"]);
	})();
}
