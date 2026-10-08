#!/usr/bin/env node
// AgentJournal hooks: pin what you were told, journal what you did, and wake up from both after the context is cut.
// The pins and the journal are written by code, so they do not depend on the model remembering to write them.
//
// One script for Claude Code, Codex and GitHub Copilot. The event comes as the first argument, because
// Copilot's native payload does not always name it:
//   node agentjournal-hook.mjs pin         on UserPromptSubmit / userPromptSubmitted -> .agentjournal/<session>/PINNED.md
//   node agentjournal-hook.mjs journal     on PostToolUse(Failure) / postToolUse     -> .agentjournal/<session>/JOURNAL.md
//                                          (also takes in what `agentjournal note|sleep` left in .agentjournal/INBOX.jsonl)
//   node agentjournal-hook.mjs ask         on Claude Code PreToolUse(Bash): `agentjournal sleep` asks the user first
//                                          (Allow = close the topic; Deny = keep working in this context)
//   node agentjournal-hook.mjs stop        on Stop: after `agentjournal sleep`, tell the user (and the desktop) to /clear
//                                          (a /clear after a sleep continues the same pins and journal)
//   node agentjournal-hook.mjs wake        on SessionStart compact|resume|clear      -> pins + recent journal back in context
//                                          (on startup: one paragraph on how to close a topic with `agentjournal sleep`)
//                              wake-flat   the same for Copilot's native sessionStart (flat additionalContext)
//   node agentjournal-hook.mjs precompact  on Copilot preCompact (it has no wake-up event after compaction): the next
//                                          `journal` call returns the wake-up as additionalContext instead
// No dependencies. Never blocks the session: any error is swallowed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PINS_CHARS = 8000; // longer pin files are shown as the first pin + the latest ones
const JOURNAL_TAIL = 40;

// The `agentjournal` command as the agent can run it: the plugin's own folder is not on the shell's PATH.
function cliCommand() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const cli = [path.join(here, "..", "bin", "agentjournal.mjs"), path.join(here, "agentjournal.mjs")].find((f) => fs.existsSync(f));
	return cli ? `node "${cli.replace(/\\/g, "/")}"` : "agentjournal";
}
const howToSleep = () =>
	`When you finish a topic (a part of the job that stands on its own), close it: run \`${cliCommand()} sleep "<what it came to, ` +
	`in one line: files, numbers, decisions>"\`, then end your turn. The context can then be cleared, and you continue from the pins and ` +
	`the journal. For a fact you must keep (a count, a list so far, a decision): \`${cliCommand()} note "<line>"\`.`;

const oneLine = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

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

// Where the notes go: AGENTJOURNAL_ROOT, else the project folder Claude Code names, else the nearest .agentjournal
// above the working folder, else the working folder (the `agentjournal` command looks in the same order). Never the
// working folder alone: every `cd` moves it, and the notes then scatter across the folders the agent visited.
function findRoot(cwd) {
	if (process.env.AGENTJOURNAL_ROOT) return process.env.AGENTJOURNAL_ROOT;
	if (process.env.CLAUDE_PROJECT_DIR) return path.join(process.env.CLAUDE_PROJECT_DIR, ".agentjournal");
	for (let dir = cwd; ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".agentjournal"))) return path.join(dir, ".agentjournal");
		if (path.dirname(dir) === dir) return path.join(cwd, ".agentjournal");
	}
}

// A pin is what the user wrote. Background-task events arrive on the same hook and are not the user's words, and the
// editor's "opened file" tag is not either.
function typedByUser(prompt) {
	const text = String(prompt).replace(/<ide_(opened_file|selection)>[\s\S]*?<\/ide_\1>/g, "").trim();
	return /^<task-notification>/.test(text) ? "" : text;
}

// One Claude Code window keeps its process id across a /clear while the session id changes. What a /clear has to find
// again (which session slept, which journal is this window's) is therefore kept per window, so two windows open on one
// project never wake up on each other's notes. A tool that does not name its window shares one marker, as before.
const WINDOW = process.env.CLAUDE_PID ? `.${process.env.CLAUDE_PID}` : "";

const count = (file, marker) => read(file).split("\n").filter((l) => marker.test(l)).length;
const append = (journal, text) => fs.appendFileSync(journal, `${count(journal, /^\d+\. /) + 1}. ${text}\n`);

function wakeText(pins, journal, why) {
	let pinText = read(pins).trim() || "(no pins yet)";
	if (pinText.length > MAX_PINS_CHARS) {
		const blocks = pinText.split(/\n(?=### )/);
		const tail = [];
		for (let i = blocks.length - 1; i > 0 && tail.join("\n").length < MAX_PINS_CHARS / 2; i--) tail.unshift(blocks[i]);
		pinText = `${blocks[0]}\n\n(... ${blocks.length - 1 - tail.length} more pins in ${pins} ...)\n\n${tail.join("\n")}`;
	}
	const lines = read(journal).trim().split("\n").filter(Boolean);
	const topics = lines.filter((l) => /^\d+\. SLEEP /.test(l));
	return [
		`AGENTJOURNAL WAKE-UP (${why}). What you remember of earlier work is now a summary, or nothing.`,
		"The pins and the journal below were written as things happened. They are the truth; your recollection is not.",
		"",
		`## PINNED - the user's instructions, word for word (${pins})`,
		pinText,
		"",
		...(topics.length ? [`## TOPICS CLOSED - ${topics.length}, in order`, ...topics, ""] : []),
		`## JOURNAL - your last ${Math.min(JOURNAL_TAIL, lines.length)} of ${lines.length} actions (${journal})`,
		lines.length ? lines.slice(-JOURNAL_TAIL).join("\n") : "(no actions journaled yet)",
		"",
		"Continue from these. Check every pin before you say you are done, and recount any number from the journal or the output, not from memory.",
		howToSleep(),
	].join("\n");
}

function main(action, ev) {
	const e = normalise(ev);
	const root = findRoot(e.cwd);
	const own = path.join(root, e.session);
	// After an agent-chosen /clear, the new session keeps writing to the folder of the session that slept (THREAD).
	const dir = read(path.join(own, "THREAD")).trim() || own;
	const pins = path.join(dir, "PINNED.md");
	const journal = path.join(dir, "JOURNAL.md");
	const flag = path.join(dir, "WAKE_ON_NEXT_TOOL");
	const pending = path.join(root, `SLEEP_PENDING${WINDOW}`);
	// A marker 0.2.0 left (one per project) is taken over by the window whose journal it names.
	const shared = path.join(root, "SLEEP_PENDING");
	if (WINDOW && read(shared).trim() === dir) fs.renameSync(shared, pending);
	const inbox = path.join(root, "INBOX.jsonl");
	fs.mkdirSync(dir, { recursive: true });
	if (action === "pin" || action === "journal") {
		fs.writeFileSync(path.join(root, "LAST"), dir);
		if (WINDOW) fs.writeFileSync(path.join(root, `LAST${WINDOW}`), dir);
	}

	if (action === "pin") {
		const prompt = typedByUser(e.prompt);
		if (!prompt) return;
		const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
		fs.appendFileSync(pins, `### ${count(pins, /^### /) + 1} (${stamp})\n${prompt}\n\n`);
		return;
	}
	if (action === "journal") {
		// What the agent wrote with `agentjournal note|sleep` replaces the plain line for that command.
		// Only what this session's own command left: an entry names its session when the command knew it.
		const left = read(inbox).split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const asked = left.filter((a) => !a.session || a.session === e.session);
		const others = left.filter((a) => a.session && a.session !== e.session);
		if (asked.length) {
			if (others.length) fs.writeFileSync(inbox, others.map((a) => JSON.stringify(a)).join("\n") + "\n");
			else fs.unlinkSync(inbox);
		}
		if (!asked.length || !/\bagentjournal\b/.test(summarise(e.input))) {
			append(journal, `${e.tool} ${summarise(e.input)}${e.failed ? " - FAILED" : ""}`);
		}
		let slept = false;
		for (const a of asked) {
			append(journal, `${a.kind === "sleep" ? "SLEEP" : "NOTE"} ${oneLine(a.text, 600)}`);
			if (a.kind === "sleep") slept = true;
		}
		const context = [];
		if (slept) {
			fs.writeFileSync(pending, dir);
			context.push(
				"AgentJournal: topic closed and written to the journal. End your turn now with one short line of status and " +
					"start nothing new: the context can be cleared now, and you continue from the pins and the journal.",
			);
		}
		if (fs.existsSync(flag)) {
			// Copilot: the context was compacted since the last tool; hand the wake-up to the model now.
			fs.unlinkSync(flag);
			context.push(wakeText(pins, journal, "after compaction"));
		}
		if (context.length) {
			const text = context.join("\n\n");
			// Claude Code and Codex name the event and read hookSpecificOutput; Copilot's payload reads a flat field.
			process.stdout.write(JSON.stringify(ev.hook_event_name
				? { hookSpecificOutput: { hookEventName: ev.hook_event_name, additionalContext: text } }
				: { additionalContext: text }));
		}
		return;
	}
	if (action === "ask") {
		// Claude Code PreToolUse on Bash: the user decides whether the agent may close the topic (and so clear).
		const sleep = String(e.input.command ?? "").match(/agentjournal(?:\.mjs)?["']?\s+sleep\s+([\s\S]*)$/);
		if (!sleep) return;
		const topic = oneLine(sleep[1].replace(/^\s*["']|["']\s*$/g, ""), 300);
		process.stdout.write(JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "ask",
				permissionDecisionReason:
					`AgentJournal: Claude finished a topic and wants a fresh context ("${topic}"). Allow = journal it and stop; ` +
					"then type /clear and it wakes up from your pins and the journal. Deny = keep working in this context.",
			},
		}));
		return;
	}
	if (action === "stop") {
		if (read(pending).trim() !== dir) return;
		const text = "AgentJournal: topic closed and journaled. Type /clear now; Claude wakes up from the pins and the journal.";
		// A desktop notification as well (OSC 9: Windows Terminal, iTerm2, WezTerm, ConEmu), for when you are elsewhere.
		process.stdout.write(JSON.stringify({ systemMessage: text, terminalSequence: `\u001b]9;${text}\u0007` }));
		return;
	}
	if (action === "precompact") {
		fs.writeFileSync(flag, new Date().toISOString());
		return;
	}
	if (action === "wake" || action === "wake-flat") {
		if (!["compact", "resume", "clear"].includes(e.source)) {
			// A fresh start has nothing to restore; it only learns how to close a topic.
			const intro = `AGENTJOURNAL is on: your instructions are pinned word for word and every action is journaled. ${howToSleep()}`;
			process.stdout.write(JSON.stringify(action === "wake-flat"
				? { additionalContext: intro }
				: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: intro } }));
			return;
		}
		let why = { compact: "after compaction", resume: "session resumed", clear: "after /clear" }[e.source];
		let from = { pins, journal };
		if (e.source === "clear") {
			const slept = read(pending).trim();
			if (!slept) return; // the user cleared on purpose: start blank (no wake-up, and no intro either)
			// The clear follows `agentjournal sleep`: this new session continues the thread of the one that slept.
			fs.unlinkSync(pending);
			fs.mkdirSync(own, { recursive: true });
			fs.writeFileSync(path.join(own, "THREAD"), slept);
			from = { pins: path.join(slept, "PINNED.md"), journal: path.join(slept, "JOURNAL.md") };
			why = "after sleep: the context was cleared at the end of a topic";
		}
		const text = wakeText(from.pins, from.journal, why);
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
