#!/usr/bin/env node
// AgentJournal hooks: pin what you were told, journal what you did, and wake up from both after the context is cut.
// The pins and the journal are written by code, so they do not depend on the model remembering to write them.
//
// One script for Claude Code, Codex and GitHub Copilot. The event comes as the first argument, because
// Copilot's native payload does not always name it:
//   node agentjournal-hook.mjs pin         on UserPromptSubmit / userPromptSubmitted -> .agentjournal/<session>/PINNED.md
//   node agentjournal-hook.mjs journal     on PostToolUse(Failure) / postToolUse     -> .agentjournal/<session>/JOURNAL.md
//   node agentjournal-hook.mjs wake        on SessionStart compact|resume|clear      -> pins + recent journal back in context
//                              wake-flat   the same for Copilot's native sessionStart (flat additionalContext)
//   node agentjournal-hook.mjs precompact  on Copilot preCompact (it has no wake-up event after compaction): the next
//                                          `journal` call returns the wake-up as additionalContext instead
// No dependencies. Never blocks the session: any error is swallowed.
import fs from "node:fs";
import path from "node:path";

const MAX_PINS_CHARS = 8000; // longer pin files are shown as the first pin + the latest ones
const JOURNAL_TAIL = 40;

const oneLine = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// The same event arrives with different field names per tool; read whichever is present.
function normalise(ev) {
	let input = ev.tool_input ?? ev.toolArgs ?? ev.toolInput ?? {};
	if (typeof input === "string") {
		try {
			input = JSON.parse(input);
		} catch {
			input = { value: input };
		}
	}
	return {
		session: String(ev.session_id ?? ev.sessionId ?? "session"),
		cwd: ev.cwd || process.cwd(),
		prompt: ev.prompt ?? ev.initialPrompt ?? "",
		tool: String(ev.tool_name ?? ev.toolName ?? "tool"),
		input,
		failed: ev.hook_event_name === "PostToolUseFailure" || ev.error != null,
		source: ev.source ?? "",
	};
}

// What was done, in one line: the command, the file, the query. Never the content that came back.
function summarise(input) {
	for (const key of ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description"]) {
		if (input[key]) return oneLine(input[key]);
	}
	return oneLine(JSON.stringify(input), 150);
}

const count = (file, marker) =>
	fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => marker.test(l)).length : 0;

function wakeText(pins, journal, why) {
	let pinText = fs.existsSync(pins) ? fs.readFileSync(pins, "utf8").trim() : "(no pins yet)";
	if (pinText.length > MAX_PINS_CHARS) {
		const blocks = pinText.split(/\n(?=### )/);
		const tail = [];
		for (let i = blocks.length - 1; i > 0 && tail.join("\n").length < MAX_PINS_CHARS / 2; i--) tail.unshift(blocks[i]);
		pinText = `${blocks[0]}\n\n(... ${blocks.length - 1 - tail.length} more pins in ${pins} ...)\n\n${tail.join("\n")}`;
	}
	const lines = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean) : [];
	return [
		`AGENTJOURNAL WAKE-UP (${why}). What you remember of earlier work is now a summary, or nothing.`,
		"The pins and the journal below were written as things happened. They are the truth; your recollection is not.",
		"",
		`## PINNED - the user's instructions, word for word (${pins})`,
		pinText,
		"",
		`## JOURNAL - your last ${Math.min(JOURNAL_TAIL, lines.length)} of ${lines.length} actions (${journal})`,
		lines.length ? lines.slice(-JOURNAL_TAIL).join("\n") : "(no actions journaled yet)",
		"",
		"Continue from these. Check every pin before you say you are done, and recount any number from the journal or the output, not from memory.",
	].join("\n");
}

function main(action, ev) {
	const e = normalise(ev);
	const dir = path.join(e.cwd, ".agentjournal", e.session);
	const pins = path.join(dir, "PINNED.md");
	const journal = path.join(dir, "JOURNAL.md");
	const flag = path.join(dir, "WAKE_ON_NEXT_TOOL");
	fs.mkdirSync(dir, { recursive: true });

	if (action === "pin") {
		if (!String(e.prompt).trim()) return;
		const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
		fs.appendFileSync(pins, `### ${count(pins, /^### /) + 1} (${stamp})\n${String(e.prompt).trim()}\n\n`);
		return;
	}
	if (action === "journal") {
		fs.appendFileSync(journal, `${count(journal, /^\d+\. /) + 1}. ${e.tool} ${summarise(e.input)}${e.failed ? " - FAILED" : ""}\n`);
		if (fs.existsSync(flag)) {
			// Copilot: the context was compacted since the last tool; hand the wake-up to the model now.
			fs.unlinkSync(flag);
			process.stdout.write(JSON.stringify({ additionalContext: wakeText(pins, journal, "after compaction") }));
		}
		return;
	}
	if (action === "precompact") {
		fs.writeFileSync(flag, new Date().toISOString());
		return;
	}
	if (action === "wake" || action === "wake-flat") {
		if (!["compact", "resume", "clear"].includes(e.source)) return; // a fresh start has nothing to restore
		const why = { compact: "after compaction", resume: "session resumed", clear: "after /clear" }[e.source];
		const text = wakeText(pins, journal, why);
		// Claude Code and Codex read hookSpecificOutput; Copilot's native sessionStart reads a flat additionalContext.
		process.stdout.write(JSON.stringify(action === "wake-flat"
			? { additionalContext: text }
			: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
	}
}

let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
	try {
		main(process.argv[2], JSON.parse(raw || "{}"));
	} catch {
		// never block the session over the journal
	}
});
