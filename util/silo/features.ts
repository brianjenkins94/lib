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
 *   • MCP tools — an object literal with a `name`, a `description` and a handler or schema.
 *   • terminal commands (`defineCommand("name", …)`), URL parameters read from `location`, buttons (a JSX `<…button>` with
 *     a literal `aria-label` or `title`), and core modules (a call to an imported `install…` function).
 *
 * A feature is keyed by WHAT it is (`command|editor.debugFile`), never where it lives, so a moved file moves its
 * features rather than removing and re-adding them. Each way in carries a FINGERPRINT of its own code — the registration
 * call with its inline handler, as the AST without positions — so a change in comments or whitespace isn't a change —
 * and the names that code uses (`uses`): the roots of what the feature reaches in the program's declaration graph
 * (`./graph`), so a change anywhere it reaches is a change to it.
 *
 * `oxc` + pure AST logic only, the same portability contract as `./detect`: no fs, git or network.
 */

import type { Node } from "./graph";
import { parseSync } from "oxc-parser";
import { fingerprintOf, nodeId, topLevelNames, topLevelUses, walk } from "./graph";

export { fingerprintOf } from "./graph";

/** One way in, as one file states it. A command's declaration (manifest) and registration (code) are two of these. */
export interface WayIn {
	"facet": string;
	/** For commands and views: which side this file gives — declared (manifest), registered (code), or a keybinding / menu entry. */
	"side"?: string;
	"id": string;
	"label": string;
	/** Keyed by its file too: it has no name of its own (a provider registered for a selector). */
	"weak"?: boolean;
	/** The fingerprint of its own code. */
	"code"?: string;
	/** The names its code uses that its file declares or imports at the top level (a local of the function it's
	 *  registered in counts as what that local is made from). */
	"uses"?: string[];
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
}

/** Internal ways in: how a program's parts reach each other, not what a person or an agent reaches. */
export const INTERNAL_FACETS = new Set(["hub request", "hub subscription", "worker"]);

export const isManifest = (file: string): boolean => /(^|\/)package\.json$/u.test(file);
export const isSource = (file: string): boolean => /\.[cm]?[jt]sx?$/u.test(file) && !/\.d\.[cm]?ts$/u.test(file);

// ── the AST ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A whole file's fingerprint (see `fingerprintOf`); its text, if it doesn't parse. */
export function fileFingerprint(file: string, text: string): string {
	if (!isSource(file)) {
		return text;
	}

	const { program, errors } = parseSync(file, text);

	return errors.length > 0 ? text : fingerprintOf(program);
}

/** A string literal's value, or a template literal's with nothing interpolated. */
function literal(node: Node | undefined): string | undefined {
	if (node?.type === "Literal" && typeof node["value"] === "string") {
		return node["value"];
	}

	if (node?.type === "TemplateLiteral" && node["expressions"].length === 0) {
		return node["quasis"][0]?.value.cooked ?? undefined;
	}

	return undefined;
}

/** Every literal an argument can be: `pace === "fast" ? "a" : "b"` registers both. */
function literals(node: Node | undefined): string[] {
	if (node?.type === "ConditionalExpression") {
		return [...literals(node["consequent"]), ...literals(node["alternate"])];
	}

	if (node?.type === "ParenthesizedExpression") {
		return literals(node["expression"]);
	}

	const value = literal(node);

	return value === undefined ? [] : [value];
}

const property = (object: Node, name: string): Node | undefined => object["properties"].find((each: Node) => each.type === "Property" && (each["key"].name ?? each["key"].value) === name)?.value;

const REGISTER = /^register(?:\w*(?:Provider|Factory)|UriHandler|NotebookSerializer)$/u;
const CREATE = /^(?:createTreeView|createWebviewPanel|createStatusBarItem|createOutputChannel|createSourceControl|createTestController|createDiagnosticCollection|createTerminal|createTextEditorDecorationType|createCommentController)$/u;
const words = (name: string): string => name.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
const firstSentence = (text: string): string => text.split(/\.\s|\n/u)[0].slice(0, 120);

// ── ways in ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The ways in a source file states. */
export function waysInSource(file: string, text: string): WayIn[] {
	const { program } = parseSync(file, text);
	const ways: WayIn[] = [];
	const source = (node: Node): string => text.slice(node.start, node.end);
	const imports = new Map<string, string>();
	const scope = topLevelNames(program);
	// A name made at run time (`virtual.debug.${port}`, `controlSubject(SESSION)`): keyed by how it's written.
	const isName = (node: Node | undefined): boolean => node !== undefined && ["TemplateLiteral", "Identifier", "CallExpression", "MemberExpression", "BinaryExpression"].includes(node.type);
	const spelled = (node: Node): string => source(node).replace(/\s+/gu, " ");
	let statement: Node = program;

	for (const statement of program.body as Node[]) {
		if (statement.type === "ImportDeclaration") {
			for (const specifier of statement["specifiers"] as Node[]) {
				imports.set(specifier["local"].name, statement["source"].value);
			}
		}
	}

	const visit = (node: Node): void => {
		const before = ways.length;

		if (node.type === "CallExpression") {
			const callee = node["callee"] as Node;
			const name: string | undefined = callee.type === "MemberExpression" && !callee["computed"] ? callee["property"].name : callee.type === "Identifier" ? callee["name"] : undefined;
			const receiver = callee.type === "MemberExpression" ? source(callee["object"]) : "";
			const [first, second] = node["arguments"] as Node[];

			if (name === "registerCommand" || name === "registerTextEditorCommand") {
				for (const id of literals(first)) {
					ways.push({ "facet": "command", "side": "registered", "id": id, "label": "" });
				}
			} else if (name !== undefined && REGISTER.test(name)) {
				const facet = name === "registerWebviewViewProvider" || name === "registerTreeDataProvider" ? "view" : words(name.replace(/^register/u, "").replace(/(?:Provider|Factory)$/u, "")) + " provider";
				const id = literal(first);

				ways.push({ "facet": facet, ...facet === "view" ? { "side": "registered" } : {}, "id": id ?? "", "label": "", ...id === undefined ? { "weak": true } : {} });
			} else if (name !== undefined && CREATE.test(name) && /window|languages|scm|tests|comments|vscode|api/u.test(receiver)) {
				const facet = name === "createTreeView" ? "view" : words(name.replace(/^create/u, ""));
				const id = literal(first);

				ways.push({ "facet": facet, ...facet === "view" ? { "side": "registered" } : {}, "id": id ?? "", "label": literal(second) ?? "", ...id === undefined ? { "weak": true } : {} });
			} else if (name === "serve" && (node["arguments"] as Node[]).length >= 3 && (literal(second) !== undefined || (first !== undefined && /hub/iu.test(source(first)) && isName(second)))) {
				ways.push({ "facet": "hub request", "id": literal(second) ?? spelled(second), "label": "" });
			} else if (name === "subscribe" && /hub/iu.test(receiver) && (literal(first) !== undefined || isName(first))) {
				ways.push({ "facet": "hub subscription", "id": literal(first) ?? spelled(first), "label": "" });
			} else if (name === "defineCommand" && literal(first) !== undefined) {
				ways.push({ "facet": "terminal command", "id": literal(first), "label": "" });
			} else if ((name === "get" || name === "has" || name === "getAll") && literal(first) !== undefined && receiver.includes("location") && /URLSearchParams|search/u.test(receiver)) {
				ways.push({ "facet": "url parameter", "id": "?" + literal(first), "label": "" });
			} else if (name === "addEventListener" && (literal(first) === "message" || literal(first) === "connect") && node === statement["expression"] && /^(?:|globalThis|self)$/u.test(receiver)) {
				ways.push({ "facet": "worker", "id": "", "label": "", "weak": true });
			} else if (name !== undefined && /^install[A-Z]/u.test(name) && callee.type === "Identifier" && imports.get(name)?.startsWith(".") === true) {
				// What it is: the module's `install…` function, and what that reaches (its `uses`).
				ways.push({ "facet": "core module", "id": name, "label": "" });
			}
		} else if (node.type === "AssignmentExpression" && node === statement["expression"] && /^(?:(?:globalThis|self)\.)?on(?:message|connect)$/u.test(source(node["left"]))) {
			ways.push({ "facet": "worker", "id": "", "label": "", "weak": true });
		} else if (node.type === "ObjectExpression") {
			const name = literal(property(node, "name")); const
				description = literal(property(node, "description"));

			if (name !== undefined && description !== undefined && /^[a-z][a-z0-9_.]*$/u.test(name) && ["handler", "inputSchema", "input", "run", "call", "schema"].some((key) => property(node, key) !== undefined)) {
				ways.push({ "facet": "agent tool", "id": name, "label": firstSentence(description) });
			}
		} else if (node.type === "JSXOpeningElement" && /button/iu.test(source(node["name"]))) {
			const attribute = (name: string): Node | undefined => (node["attributes"] as Node[]).find((each) => each.type === "JSXAttribute" && source(each["name"]) === name);
			const label = literal(attribute("aria-label")?.["value"]) ?? literal(attribute("title")?.["value"]);

			if (label !== undefined) {
				ways.push({ "facet": "button", "id": label, "label": attribute("onClick") !== undefined || attribute("ref") !== undefined ? "" : "no handler" });
			}
		}

		if (ways.length > before) {
			const code = fingerprintOf(node);
			const uses = topLevelUses(node, statement, scope);

			for (let index = before; index < ways.length; index++) {
				ways[index].code = code;
				ways[index].uses = uses;
			}
		}
	};

	for (statement of program.body as Node[]) {
		walk(statement, visit);
	}

	return ways;
}

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

/** The ways in a file states: a manifest's, a source file's, or none. A file that doesn't parse states none. */
export function waysIn(file: string, text: string): WayIn[] {
	if (isManifest(file)) {
		return waysInManifest(text);
	}

	if (!isSource(file)) {
		return [];
	}

	try {
		return waysInSource(file, text);
	} catch {
		return [];
	}
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
				feature = { "key": key, "facet": way.facet, "id": way.id, "label": "", "files": [], "sides": [], "code": [], "roots": [] };
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

			for (const used of way.uses ?? []) {
				if (!feature.roots.includes(nodeId(file, used))) {
					feature.roots.push(nodeId(file, used));
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
