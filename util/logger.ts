/**
 * Span-aware structured logger for Node and the browser. You create EXPLICIT descendant spans from a
 * parent and hold the handles — `const build = log.span("build"); const step = build.span("compile")`
 * — so parentage is deterministic with no ambient state (correct under any concurrency). Each span is
 * also a logger (`build.info(...)`), and `logger.child({ reqId })` binds extra context with no new
 * span. Spans render as an indented timed tree for humans and Roarr-
 * compatible JSON for machines. Every event is one neutral `LogRecord`; output is a list of `sinks`.
 *
 * Diagnostics (`log`/`span.*`, every level) go to STDERR; the program's data goes to STDOUT via
 * `print`/`write`, so `myapp | jq` stays clean. Format = `LOG_FORMAT`/`globalThis.LOG_FORMAT` override,
 * else Node `stderr.isTTY ? pretty : json`, else browser `pretty`.
 *
 * Concurrency + the indented tree: wrap a sink with `buffered(...)`. It holds each span's records and
 * flushes the whole subtree contiguously when the span closes, so concurrent operations print as clean
 * blocks (in completion order) instead of interleaving. No cursor tricks, so it works in the browser.
 * An OTel sink can drop in later by buffering point-logs into their span's `events` — no core change.
 */

type Attrs = Record<string, unknown>;

/** syslog-ish numeric severities, matching Roarr's `context.logLevel`. */
const LEVELS = { "trace": 10, "debug": 20, "info": 30, "warn": 40, "error": 50, "fatal": 60 } as const;

type Level = keyof typeof LEVELS;

type Format = "pretty" | "json";

/** The neutral superset every sink consumes. A `span-open`/`span-close` is just a log with span shape. */
export interface LogRecord {
	"kind": "log" | "span-open" | "span-close";
	"level": Level;
	"message": string;
	/** Per-call attributes (what the tree shows). */
	"attrs": Attrs;
	/** The emitting logger's bound context from `child()` — merged under `attrs` by the JSON sink. */
	"context"?: Attrs;
	/** Unix ms. For `span-close` this is the END time; start is `endTime - durationMs`. */
	"time": number;
	"span"?: string;
	"spanId"?: number;
	"parentSpanId"?: number;
	"traceId"?: string;
	"depth": number;
	/** Present only on `span-close`. */
	"durationMs"?: number;
}

export type Sink = (record: LogRecord) => void;

const isNode = typeof process !== "undefined" && Boolean(process.versions?.node);

/** Read config from the Node env or a `globalThis` global, so both platforms have a knob. */
function setting(name: string): string | undefined {
	const value = (isNode ? process.env[name] : undefined) ?? (globalThis as Record<string, unknown>)[name];

	return typeof value === "string" ? value : undefined;
}

function resolveFormat(): Format {
	const override = setting("LOG_FORMAT");

	if (override === "pretty" || override === "json") {
		return override;
	}

	if (isNode) {
		return process.stderr.isTTY ? "pretty" : "json";
	}

	return "pretty";
}

const threshold = LEVELS[setting("LOG_LEVEL") as Level] ?? LEVELS.trace;

let spanCounter = 0;
let sequence = 0;

function nextSpanId(): number {
	const id = spanCounter;

	spanCounter += 1;

	return id;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────────────────────--

/** Active sinks. Default: human tree or Roarr JSON per the resolved `format`. Mutate to add/replace. */
export const sinks: Sink[] = [selectSink(resolveFormat())];

function selectSink(format: Format): Sink {
	if (format === "json") {
		return jsonSink; // universal — the transport differs inside, not the shape
	}

	return isNode ? ansiTreeSink : consoleGroupSink;
}

function dispatch(record: LogRecord): void {
	if (LEVELS[record.level] < threshold) {
		return;
	}

	for (const sink of sinks) {
		sink(record);
	}
}

// ── Loggers: an explicit span tree, plus context-binding sub-loggers ──────────────────────────--

export class Logger {
	protected readonly context: Attrs;
	protected readonly host?: Span;

	constructor(context: Attrs = {}, host?: Span) {
		this.context = context;
		this.host = host;
	}

	/** A sub-logger that binds extra context into every record it emits — no span, no new tree level. */
	child(context: Attrs): Logger {
		return new Logger({ ...this.context, ...context }, this.hostSpan());
	}

	/** Open a descendant span (timed, one level deeper). Inherits this logger's bound context. */
	span(name: string, attrs: Attrs = {}): Span {
		return new Span(name, attrs, this.hostSpan(), { ...this.context, ...attrs });
	}

	log(level: Level, message: string, attrs?: Attrs): void { this.emit("log", level, message, attrs); }
	trace(message: string, attrs?: Attrs): void { this.emit("log", "trace", message, attrs); }
	debug(message: string, attrs?: Attrs): void { this.emit("log", "debug", message, attrs); }
	info(message: string, attrs?: Attrs): void { this.emit("log", "info", message, attrs); }
	warn(message: string, attrs?: Attrs): void { this.emit("log", "warn", message, attrs); }
	error(message: string, attrs?: Attrs): void { this.emit("log", "error", message, attrs); }
	fatal(message: string, attrs?: Attrs): void { this.emit("log", "fatal", message, attrs); }

	/** The enclosing span whose identity/depth stamp this logger's records (undefined at the root). */
	protected hostSpan(): Span | undefined {
		return this.host;
	}

	protected emit(kind: LogRecord["kind"], level: Level, message: string, attrs: Attrs = {}, durationMs?: number): void {
		const host = this.hostSpan();

		dispatch({
			"kind": kind,
			"level": level,
			"message": message,
			"attrs": attrs,
			"context": this.context,
			"time": Date.now(),
			"span": host?.name,
			"spanId": host?.id,
			"parentSpanId": host?.parentId,
			"traceId": host?.traceId,
			"depth": host?.depth ?? 0,
			"durationMs": durationMs
		});
	}
}

export class Span extends Logger {
	readonly id = nextSpanId();
	readonly name: string;
	readonly parentId?: number;
	readonly traceId: string;
	readonly depth: number;
	private readonly startMs = performance.now();
	private ended = false;

	constructor(name: string, attrs: Attrs = {}, parent?: Span, context: Attrs = attrs) {
		super(context);

		this.name = name;
		this.parentId = parent?.id;
		this.traceId = parent?.traceId ?? `t${this.id}`;
		this.depth = parent ? parent.depth + 1 : 0;

		this.emit("span-open", "trace", "span started", attrs);
	}

	/** Close the span and report its duration. Idempotent. */
	end(attrs: Attrs = {}): void {
		if (this.ended) {
			return;
		}

		this.ended = true;

		this.emit("span-close", "info", "span finished", attrs, performance.now() - this.startMs);
	}

	/** `using span = log.span(...)` auto-ends on scope exit, even on throw. Needs a `using`-capable runtime. */
	[Symbol.dispose](): void {
		this.end();
	}

	protected override hostSpan(): this {
		return this;
	}
}

/** Root logger: `log.span(...)` opens a top-level span, `log.child(...)` binds context, `log.info(...)` logs at the root. */
export const log = new Logger();

/** Sugar for a context-bound sub-logger: `logger({ reqId })` === `log.child({ reqId })`. */
export const logger = (context: Attrs): Logger => log.child(context);

// ── Application output (the stdout counterpart to the stderr logger) ───────────────────────────--

function toLine(args: unknown[]): string {
	return args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
}

/** The program's data → stdout, newline included (Python's `print`). Browser: one `console.log`. */
export function print(...args: unknown[]): void {
	if (isNode) {
		process.stdout.write(`${toLine(args)}\n`);

		return;
	}

	console.log(...args);
}

/** Like `print` but no trailing newline (mirrors `process.stdout.write`). Browser: identical to `print`. */
export function write(...args: unknown[]): void {
	if (isNode) {
		process.stdout.write(toLine(args));

		return;
	}

	console.log(...args);
}

// ── Sinks ─────────────────────────────────────────────────────────────────────────────────────--

const COLOR = { "cyan": "[36m", "yellow": "[33m", "red": "[31m", "dim": "[2m", "reset": "[0m" };

/** Node human tree: depth → ANSI indentation. Span open/close render as `→ name` / `← name (Xms)`. */
function ansiTreeSink(record: LogRecord): void {
	const indent = "  ".repeat(record.depth);
	const extra = Object.keys(record.attrs).length ? ` ${COLOR.dim}${JSON.stringify(record.attrs)}${COLOR.reset}` : "";

	if (record.kind === "span-open") {
		process.stderr.write(`${indent}${COLOR.cyan}→ ${record.span}${COLOR.reset}${extra}\n`);

		return;
	}

	if (record.kind === "span-close") {
		const incomplete = record.durationMs === undefined;
		const color = incomplete ? COLOR.red : COLOR.cyan;
		const timing = incomplete ? "incomplete" : `${record.durationMs.toFixed(1)}ms`;

		process.stderr.write(`${indent}${color}← ${record.span}${COLOR.reset} ${COLOR.dim}(${timing})${COLOR.reset}${extra}\n`);

		return;
	}

	const level = record.level === "warn" ? `${COLOR.yellow}WARN${COLOR.reset} ` : (record.level === "error" || record.level === "fatal") ? `${COLOR.red}${record.level.toUpperCase()}${COLOR.reset} ` : "";

	process.stderr.write(`${indent}${level}${record.message}${extra}\n`);
}

/** Browser human tree: `console.group`/`groupEnd` gives real collapsible nesting in devtools. */
function consoleGroupSink(record: LogRecord): void {
	const args = Object.keys(record.attrs).length ? [record.attrs] : [];

	if (record.kind === "span-open") {
		console.group(`→ ${record.span}`);

		return;
	}

	if (record.kind === "span-close") {
		const timing = record.durationMs === undefined ? "incomplete" : `${record.durationMs.toFixed(1)}ms`;

		console.log(`← ${record.span} (${timing})`, ...args);
		console.groupEnd();

		return;
	}

	const emit = record.level === "error" || record.level === "fatal" ? console.error : record.level === "warn" ? console.warn : console.log;

	emit(record.message, ...args);
}

/** Roarr-compatible `{ time, sequence, version, message, context }`; span/domain data under `context`. */
function jsonSink(record: LogRecord): void {
	const context: Attrs = {
		...record.context,
		...record.attrs,
		"logLevel": LEVELS[record.level]
	};

	if (record.spanId !== undefined) {
		Object.assign(context, {
			"span": record.span,
			"spanId": record.spanId,
			"parentSpanId": record.parentSpanId,
			"traceId": record.traceId,
			"depth": record.depth
		});
	}

	if (record.durationMs !== undefined) {
		context["durationMs"] = record.durationMs;
	}

	const message = {
		"context": context,
		"message": record.message,
		"sequence": String(sequence),
		"time": record.time,
		"version": "2.0.0"
	};

	sequence += 1;

	if (isNode) {
		process.stderr.write(`${JSON.stringify(message)}\n`);
	} else {
		console.log(message);
	}
}

/** A synthetic close for a span that opened but never ended — visible, error-level, no duration. */
function incompleteClose(open: LogRecord): LogRecord {
	return { ...open, "kind": "span-close", "level": "error", "message": "span did not end", "attrs": { "incomplete": true }, "durationMs": undefined };
}

/**
 * Wrap a sink so concurrent spans don't interleave: buffer every record by span and flush the whole
 * subtree contiguously when its ROOT span closes. Concurrent operations then print as clean blocks in
 * completion order. Point logs outside any span stream through immediately. Browser-friendly — it only
 * reorders records, no terminal cursor control. Trade-off: a subtree is invisible until its root ends.
 *
 * Never-ended spans are handled, not lost: any span reached without a stored close flushes an
 * error-level `incomplete` close instead of vanishing, and a Node `exit` hook (also the returned
 * `.drain()`) force-flushes any root that was still open — so a forgotten `.end()` is loud, not silent.
 */
export function buffered(sink: Sink): Sink & { "drain": () => void } {
	const items = new Map<number, (LogRecord | number)[]>(); // spanId → its logs, interleaved with child spanIds
	const opens = new Map<number, LogRecord>();
	const closes = new Map<number, LogRecord>();
	const pendingRoots = new Set<number>();

	function flush(id: number): void {
		const open = opens.get(id);

		if (open) {
			sink(open);
		}

		for (const item of items.get(id) ?? []) {
			if (typeof item === "number") {
				flush(item);
			} else {
				sink(item);
			}
		}

		const close = closes.get(id) ?? (open ? incompleteClose(open) : undefined);

		if (close) {
			sink(close);
		}

		items.delete(id);
		opens.delete(id);
		closes.delete(id);
		pendingRoots.delete(id);
	}

	const drain = (): void => {
		for (const id of [...pendingRoots]) {
			flush(id);
		}
	};

	if (isNode) {
		process.once("exit", drain);
	}

	const forward = (record: LogRecord): void => {
		if (record.spanId === undefined) {
			sink(record); // rootless point log — nothing to buffer under

			return;
		}

		if (record.kind === "span-open") {
			items.set(record.spanId, []);
			opens.set(record.spanId, record);

			if (record.parentSpanId === undefined) {
				pendingRoots.add(record.spanId);
			} else {
				items.get(record.parentSpanId)?.push(record.spanId);
			}

			return;
		}

		if (record.kind === "span-close") {
			closes.set(record.spanId, record);

			if (record.parentSpanId === undefined) {
				flush(record.spanId); // a whole root subtree is now complete
			}

			return;
		}

		items.get(record.spanId)?.push(record);
	};

	return Object.assign(forward, { "drain": drain });
}
