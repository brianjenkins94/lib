/**
 * juvy's `.cli()` portion — the CLI application layer (Node-only), kept out of the config core (`./index`)
 * so that core stays dependency-free and browser-safe.
 *
 * Architecture (from the cmd-ts↔juvy investigation): **juvy's `parseArgs` is THE parser** and juvy owns
 * routing + validation. cmd-ts is used ONLY as a swappable HELP RENDERER, via its public pluggable formatter
 * (`defaultHelpFormatter`), fed `CommandHelpData`/`SubcommandsHelpData` we DERIVE FROM THE JUVY SCHEMA. No
 * cmd-ts arg objects, no cmd-ts parser, no schema→cmd-ts translation. The formatter is LAZY-LOADED — pulled
 * in only to render `--help` — so a juvy CLI runs without cmd-ts installed unless help is actually requested.
 * And because that formatter is a two-method interface fed by plain data, it can later be swapped for a
 * ~40-line house formatter to drop cmd-ts entirely.
 *
 * Also carries `liftGlobals` (the ArmorCode getApiKey pattern). The old cmd-ts-native `aliases`/`group`
 * helpers are gone — juvy owns routing, so aliases are just a per-command name list matched during dispatch.
 */
import type { CommandHelpData, Example, SubcommandsHelpData } from "cmd-ts";
import type { Juvy } from "./index";

// ---------------------------------------------------------------------------------------------------------
// Descriptors — plain data (NOT cmd-ts commands)
// ---------------------------------------------------------------------------------------------------------

export interface JuvyCommand {
	"kind": "command";
	"name": string;
	"description"?: string;
	"aliases": string[];
	"config"?: Juvy;
	"examples"?: Example[];
	"handler": (config: Juvy) => unknown;
}

export interface JuvyApp {
	"kind": "subcommands";
	"name": string;
	"description"?: string;
	"aliases": string[];
	"commands": Array<JuvyCommand | JuvyApp>;
}

/** A leaf command. Its flags/positionals come from `config`'s schema; env + validation stay juvy's. */
export function command(options: { "name": string; "description"?: string; "config"?: Juvy; "aliases"?: string[]; "examples"?: Example[]; "handler": (config: Juvy) => unknown }): JuvyCommand {
	return { "kind": "command", "name": options.name, "description": options.description, "aliases": options.aliases ?? [], "config": options.config, "examples": options.examples, "handler": options.handler };
}

/** A group of sub-commands (may nest). Aliases live on each child command, matched during dispatch. */
export function subcommands(options: { "name": string; "description"?: string; "aliases"?: string[]; "commands": Array<JuvyCommand | JuvyApp> }): JuvyApp {
	return { "kind": "subcommands", "name": options.name, "description": options.description, "aliases": options.aliases ?? [], "commands": options.commands };
}

// ---------------------------------------------------------------------------------------------------------
// Help rendering — cmd-ts's public formatter, fed data derived from the juvy schema
// ---------------------------------------------------------------------------------------------------------

function helpTopicsFor(config: Juvy | undefined): CommandHelpData["helpTopics"] {
	const topics: CommandHelpData["helpTopics"] = [];

	for (const spec of config?.getArgSpecs() ?? []) {
		const category = spec.positional ? "arguments" : spec.type === "boolean" ? "flags" : "options";
		const usage = spec.positional === "rest"
			? `<${spec.flag}...>`
			: spec.positional
				? `<${spec.flag}>`
				: [`--${spec.flag}`, ...(spec.short !== undefined ? [`-${spec.short}`] : [])].join(", ") + (spec.type === "boolean" ? "" : " <value>");
		const fallback = config?.default(spec.path);

		topics.push({ category, usage, "description": spec.doc ?? "", "defaults": fallback !== undefined && fallback !== "" ? [String(fallback)] : [] });
	}

	topics.push({ "category": "flags", "usage": "--help, -h", "description": "show help", "defaults": [] });

	return topics;
}

// The formatter's second arg is a ParseContext (not exported from cmd-ts's index); for pure help rendering
// a minimal one suffices, so build it untyped rather than deep-import an internal type.
function helpContext(path: string[]): any {
	return { "nodes": [], "visitedNodes": new Set(), "hotPath": path };
}

async function renderCommandHelp(node: JuvyCommand, path: string[]): Promise<string> {
	const { defaultHelpFormatter } = await import("cmd-ts"); // lazy — cmd-ts is needed ONLY to render help
	const data: CommandHelpData = {
		"name": node.name,
		path,
		"description": node.description,
		...(node.aliases.length > 0 ? { "aliases": node.aliases } : {}),
		"helpTopics": helpTopicsFor(node.config),
		...(node.examples !== undefined ? { "examples": node.examples } : {})
	};

	return defaultHelpFormatter.formatCommand(data, helpContext(path));
}

async function renderSubcommandsHelp(node: JuvyApp, path: string[]): Promise<string> {
	const { defaultHelpFormatter } = await import("cmd-ts"); // lazy — cmd-ts is needed ONLY to render help
	const data: SubcommandsHelpData = {
		"name": node.name,
		path,
		"description": node.description,
		"commands": node.commands.map((child) => ({
			"name": child.name,
			"description": child.description,
			...(child.aliases.length > 0 ? { "aliases": child.aliases } : {}),
			"helpTopics": child.kind === "command" ? helpTopicsFor(child.config) : []
		}))
	};

	return defaultHelpFormatter.formatSubcommands(data, helpContext(path));
}

// ---------------------------------------------------------------------------------------------------------
// Routing — owned by juvy (trivial first-token dispatch + a dep-free "did you mean")
// ---------------------------------------------------------------------------------------------------------

function findCommand(node: JuvyApp, token: string): JuvyCommand | JuvyApp | undefined {
	return node.commands.find((child) => child.name === token || child.aliases.includes(token));
}

function editDistance(a: string, b: string): number {
	const dp: number[][] = Array.from({ "length": a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);

	for (let j = 0; j <= b.length; j++) { dp[0][j] = j; }

	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
		}
	}

	return dp[a.length][b.length];
}

function didYouMean(token: string, node: JuvyApp): string {
	let best: string | undefined;
	let bestDistance = 3; // suggest only within edit distance 2

	for (const name of node.commands.flatMap((child) => [child.name, ...child.aliases])) {
		const distance = editDistance(token, name);

		if (distance < bestDistance) { bestDistance = distance; best = name; }
	}

	return best !== undefined ? ` Did you mean '${best}'?` : "";
}

const HELP_FLAGS = new Set(["--help", "-h"]);

async function dispatch(node: JuvyCommand | JuvyApp, argv: string[], path: string[]): Promise<void> {
	if (node.kind === "subcommands") {
		const token = argv[0];

		if (token === undefined || HELP_FLAGS.has(token)) {
			process.stdout.write(await renderSubcommandsHelp(node, path) + "\n");

			return;
		}

		const match = findCommand(node, token);

		if (match === undefined) {
			process.stderr.write(`error: unknown ${node.name} command '${token}'.${didYouMean(token, node)}\n\n` + await renderSubcommandsHelp(node, path) + "\n");
			process.exitCode = 1;

			return;
		}

		return dispatch(match, argv.slice(1), [...path, match.name]);
	}

	// leaf command
	if (argv.some((argument) => HELP_FLAGS.has(argument))) {
		process.stdout.write(await renderCommandHelp(node, path) + "\n");

		return;
	}

	if (node.config !== undefined) {
		await node.config.parse(argv);   // juvy owns parsing (flags + positionals)
		node.config.validate();          // and validation
	}

	await node.handler(node.config as Juvy);
}

// ---------------------------------------------------------------------------------------------------------
// run — routing + lifecycle
// ---------------------------------------------------------------------------------------------------------

export interface RunOptions {
	"argv"?: string[];
	"onError"?: (error: unknown) => void | Promise<void>;
	"onExit"?: () => void;
	"signals"?: NodeJS.Signals[];
	"exit"?: boolean;
}

/** Route argv through the app (juvy parses + validates), with lifecycle scaffolding (signals + graceful exit). */
export async function run(app: JuvyCommand | JuvyApp, options: RunOptions = {}): Promise<void> {
	const { argv = process.argv.slice(2), onError, onExit, signals = ["SIGINT", "SIGUSR1", "SIGUSR2"], exit = true } = options;

	if (onExit !== undefined) {
		for (const signal of [...signals, "exit" as NodeJS.Signals]) { process.on(signal, onExit); }
	}

	try {
		await dispatch(app, argv, [app.name]);
	} catch (error) {
		if (onError !== undefined) { await onError(error); } else { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); }
		process.exitCode = 1;
	}

	if (exit) { process.exit(process.exitCode ?? 0); }
}

// ---------------------------------------------------------------------------------------------------------
// liftGlobals — pull ambient flags out of argv before dispatch (the ArmorCode getApiKey pattern)
// ---------------------------------------------------------------------------------------------------------

interface GlobalFlag {
	"long": string;            // the flag name without leading dashes
	"env"?: string;            // environment variable to fall back to
	"boolean"?: boolean;       // a valueless flag (presence → true)
}

/**
 * Lift ambient/global flags out of `argv` BEFORE dispatch, so they don't have to be redeclared on every
 * command (a value needed at module scope, before any handler). Supports `--flag value`, `--flag=value`,
 * valueless `--flag`, and an env fallback. Returns the collected values and a new argv with them removed.
 */
export function liftGlobals(argv: string[], specs: Record<string, GlobalFlag>): { "values": Record<string, string | boolean | undefined>; "argv": string[] } {
	const args = [...argv];
	const values: Record<string, string | boolean | undefined> = {};

	for (const [key, spec] of Object.entries(specs)) {
		if (spec.env !== undefined && process.env[spec.env] !== undefined) {
			values[key] = process.env[spec.env];
		}

		if (spec.boolean === true) {
			const index = args.indexOf("--" + spec.long);

			if (index >= 0) {
				values[key] = true;
				args.splice(index, 1);
			}
		} else {
			const pattern = new RegExp(`^--${spec.long}(?:=(.*))?$`, "u");
			const index = args.findIndex((argument) => pattern.test(argument));

			if (index >= 0) {
				const inline = pattern.exec(args[index])?.[1];

				if (inline !== undefined) {
					values[key] = inline;
					args.splice(index, 1);
				} else {
					values[key] = args[index + 1];
					args.splice(index, 2);
				}
			}
		}
	}

	return { "values": values, "argv": args };
}
