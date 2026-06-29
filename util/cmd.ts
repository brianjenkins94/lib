/**
 * Thin DX wrapper over cmd-ts (Schniz/cmd-ts). Re-exports everything from cmd-ts, plus the conveniences
 * that otherwise get hand-rolled in every CLI (see the ArmorCode customer-success start.ts / cli):
 *
 *   • aliases      — register one subcommand under several names ("finding|findings"); cmd-ts has none.
 *   • group        — terser `subcommands` with alias-expanded keys.
 *   • liftGlobals  — pull ambient flags out of argv before parsing (the getApiKey pattern), with an env
 *                    fallback, WITHOUT crashing when the flag is absent (the original did).
 *   • run          — run an app with lifecycle scaffolding: signal handlers, uncaughtException → onError,
 *                    an onExit cleanup hook, and a graceful exit.
 */
import { run as runCommand, subcommands } from "cmd-ts";

export * from "cmd-ts";

/** Expand "a|b|c" alias keys so one command registers under several names. */
export function aliases<T>(commands: Record<string, T>): Record<string, T> {
    const expanded: Record<string, T> = {};

    for (const [key, value] of Object.entries(commands)) {
        for (const name of key.split("|")) {
            expanded[name.trim()] = value;
        }
    }

    return expanded;
}

/** A cmd-ts `subcommands` whose keys may be "a|b" alias groups. */
export function group(name: string, commands: Record<string, any>) {
    return subcommands({ "name": name, "cmds": aliases(commands) });
}

interface GlobalFlag {
    long: string;            // the flag name without leading dashes
    env?: string;            // environment variable to fall back to
    boolean?: boolean;       // a valueless flag (presence → true)
}

/**
 * Lift ambient/global flags out of `argv` BEFORE cmd-ts parses, so they don't have to be redeclared on
 * every subcommand. Supports `--flag value`, `--flag=value`, valueless `--flag`, and an env fallback.
 * Returns the collected values and a new argv with the matched flags removed.
 */
export function liftGlobals(argv: string[], specs: Record<string, GlobalFlag>): { values: Record<string, string | boolean | undefined>; argv: string[] } {
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
                const inline = pattern.exec(args[index])![1];

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

interface RunOptions {
    argv?: string[];
    onError?: (error: unknown) => void | Promise<void>;
    onExit?: () => void;
    signals?: NodeJS.Signals[];
    exit?: boolean;
}

/** Run a cmd-ts app with lifecycle scaffolding. Defaults to the common signal set + a graceful exit(0). */
export async function run(app: Parameters<typeof runCommand>[0], options: RunOptions = {}): Promise<void> {
    const { argv = process.argv.slice(2), onError, onExit, signals = ["SIGINT", "SIGUSR1", "SIGUSR2"], exit = true } = options;

    process.on("uncaughtException", async function(error) {
        if (onError !== undefined) {
            await onError(error);
        } else {
            console.error(error instanceof Error ? error.stack : error);
        }

        process.exit(1);
    });

    if (onExit !== undefined) {
        for (const signal of [...signals, "exit" as NodeJS.Signals]) {
            process.on(signal, onExit);
        }
    }

    await runCommand(app, argv);

    if (exit) {
        process.exit(0);
    }
}
