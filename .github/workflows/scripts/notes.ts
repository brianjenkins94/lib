import { execFileSync } from "node:child_process";
import * as url from "node:url";
import * as fs from "node:fs/promises";

const MARKER = "<!-- auto-notes -->";
const MAX_BYTES = 200_000; // ~50k tokens; above this, fall back to a file-level --stat summary
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's canonical empty-tree object

// No shell — args pass through verbatim (no quoting/escaping of the prompt or diff), and a big diff
// won't overflow the default 1MB capture buffer before we get to size-check it.
function run(command: string, args: string[], input?: string): string {
	return execFileSync(command, args, { "encoding": "utf8", "maxBuffer": 256 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });
}

/**
 * Draft AI release notes onto a package's draft GitHub release, inferred from the CODE DIFF since the
 * last published `<pkg>@x.y.z` tag — commit messages here are unreliable, so they're passed only as a
 * weak hint. Idempotent: recomputes the whole range every run and REPLACES the body, but only while our
 * `<!-- auto-notes -->` marker is present, so a hand-edited body is never clobbered. A too-large diff
 * degrades to a file-level `--stat`. Needs `gh` + `git` + the `claude` CLI (authed via
 * `CLAUDE_CODE_OAUTH_TOKEN`) on PATH. Wired into cd.yml's release job (lib-CD-internal, not a util bin).
 */
export function draftNotes(pkg: string, tagName: string): void {
	// Marker guard: a non-empty body WITHOUT our marker means a human took over — leave it alone.
	let existing = "";
	try {
		existing = run("gh", ["release", "view", tagName, "--json", "body", "--jq", ".body"]).trim();
	} catch { /* no draft yet — fall through and generate */ }

	if (existing !== "" && !existing.includes(MARKER)) {
		console.error(`notes: ${tagName} body was hand-edited (no marker) — leaving it alone.`);

		return;
	}

	// Lower bound: the latest PUBLISHED (non-draft) tag for this package, else the empty tree.
	const prefix = pkg + "@";
	const prevVersion = (JSON.parse(run("gh", ["release", "list", "--limit", "100", "--json", "tagName,isDraft"])) as { "tagName": string; "isDraft": boolean }[])
		.filter((release) => !release.isDraft && release.tagName.startsWith(prefix))
		.map((release) => release.tagName.slice(prefix.length).split(".").map(Number))
		.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
		.at(-1);
	const prevTag = prevVersion === undefined ? undefined : prefix + prevVersion.join(".");
	const lower = prevTag ?? EMPTY_TREE;

	// Ground truth = the NET code diff for this package (lockfiles excluded as noise).
	let diff = run("git", ["diff", lower, "HEAD", "--", pkg, ":(exclude,glob)**/pnpm-lock.yaml", ":(exclude,glob)**/package-lock.json"]);

	if (diff.trim() === "") {
		console.error(`notes: no net changes for ${pkg} since ${lower} — skipping.`);

		return;
	}

	// Size guard: a pathologically large diff (e.g. a vendored bump) degrades to file-level --stat.
	let note = "";

	if (Buffer.byteLength(diff) > MAX_BYTES) {
		diff = run("git", ["diff", "--stat", lower, "HEAD", "--", pkg]);
		note = "(The full diff was too large, so this is a file-level summary — describe changes by area/file.)";
	}

	// Weak hint only: the (unreliable) commit subjects, for intent the diff can't convey.
	let subjects = "";
	try {
		subjects = run("git", ["log", prevTag === undefined ? "HEAD" : `${prevTag}..HEAD`, "--no-merges", "--pretty=format:- %s", "--", pkg]);
	} catch { /* no commits — leave empty */ }

	// Summarize with Claude (subscription auth via CLAUDE_CODE_OAUTH_TOKEN in the env).
	const notes = run("claude", ["-p", `Write concise Markdown release notes for ${tagName}. ${note}
My commit messages are unreliable — infer what changed from the DIFF, not the messages; the
subjects below are only weak hints about intent. Group under '### Features', '### Fixes',
'### Other'; omit any empty group. Describe user-facing impact, not file churn. No preamble.

## Commit subjects (hints only)
${subjects}

## Diff (source of truth)
${diff}`]);

	// Replace the draft body (re-stamping the marker so the next run stays in control); body via stdin.
	run("gh", ["release", "edit", tagName, "--notes-file", "-"], `${MARKER}\n${notes.trim()}\n`);
	console.error(`notes: updated ${tagName} from ${lower.slice(0, 12)}..HEAD`);
}

if (process.argv[1] !== undefined && import.meta.url === url.pathToFileURL(await fs.realpath(process.argv[1])).toString()) {
	const [pkg, tagName] = process.argv.slice(2);

	if (pkg === undefined || tagName === undefined) {
		console.error("usage: notes.ts <package> <tag-name>");
		process.exit(1);
	}

	draftNotes(pkg, tagName);
}
