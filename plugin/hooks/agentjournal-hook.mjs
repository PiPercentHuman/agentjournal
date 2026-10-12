#!/usr/bin/env node
// AgentJournal hooks: pin what you were told, journal what you did, and wake up from both after the context is cut.
// The pins and the journal are written by code, so they do not depend on the model remembering to write them.
//
// One script for Claude Code, Codex and GitHub Copilot. The event comes as the first argument, because
// Copilot's native payload does not always name it:
//   node agentjournal-hook.mjs pin         on UserPromptSubmit / userPromptSubmitted -> .agentjournal/<session>/PINNED.md
//                                          (stamped with the journal line it arrived after; where two pins disagree
//                                          the later one stands, and the wake-up says so. From the second message on
//                                          it also asks the agent to write out, in full, any earlier instruction the
//                                          message changes: `agentjournal update <pin> "<...>"`)
//   node agentjournal-hook.mjs journal     on PostToolUse(Failure) / postToolUse     -> .agentjournal/<session>/JOURNAL.md
//                                          (also takes in what `agentjournal note|sleep|update|same` left in
//                                          .agentjournal/INBOX.jsonl; an update goes to UPDATES.jsonl and is shown
//                                          under the pin it changes at every wake-up. A sleep asks once more for the
//                                          updates not yet written, before the conversation they depend on is cleared)
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

const MAX_PINS_CHARS = 8000; // longer pin files: the first pin and the latest ones whole, each pin between cut short
const PIN_CUT = 160; // what is shown of a pin between them (a change of mind is usually shorter than this)
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
	`the journal. For a fact you must keep (a count, a list so far, a decision): \`${cliCommand()} note "<line>"\`. ${howToUpdate()}`;
// A pin keeps the user's words, and a short change ("use the other one instead") only makes sense beside the
// conversation it was said in. The agent writes the changed instruction out in full while it still has that conversation.
const howToUpdate = () =>
	`When a message changes something an earlier pin asked for, record how that instruction stands now, in full, before you go on: ` +
	`\`${cliCommand()} update <number of the earlier pin> "<only the instruction that changed, as it stands now, complete enough ` +
	`to follow without this conversation; not the rest of that pin>"\` (\`${cliCommand()} pins\` lists the pins by number).`;

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

// The updated versions the agent wrote with `agentjournal update`, shown as sub-chapters under the pin they change.
// The pin itself stays as the user wrote it.
function withUpdates(block, updates) {
	const n = Number((block.match(/^### (\d+)/) ?? [])[1]);
	const mine = updates.filter((u) => u.pin === n);
	if (!mine.length) return block;
	const subs = mine.map((u, k) => `#### ${n}.${k + 1} updated by pin ${u.by} (how this part stands now; it replaces that part of pin ${n} above)\n${u.text}`);
	return `${block.trimEnd()}\n\n${subs.join("\n\n")}\n`;
}

function wakeText(pins, journal, why) {
	let pinText = read(pins).trim() || "(no pins yet)";
	const updates = read(path.join(path.dirname(pins), "UPDATES.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
	if (pinText.length <= MAX_PINS_CHARS) {
		if (updates.length) pinText = pinText.split(/\n(?=### )/).map((b) => withUpdates(b, updates)).join("\n");
	} else {
		const blocks = pinText.split(/\n(?=### )/);
		const tail = [];
		for (let i = blocks.length - 1; i > 0 && tail.join("\n").length < MAX_PINS_CHARS / 2; i--) tail.unshift(blocks[i]);
		// No pin is left out: a change of mind in the middle of a long session binds as much as the first message.
		let cut = 0;
		const middle = blocks.slice(1, blocks.length - tail.length).map((b) => {
			const [head, ...body] = b.split("\n");
			const said = body.join(" ").replace(/\s+/g, " ").trim();
			if (said.length <= PIN_CUT) return withUpdates(b, updates);
			cut++;
			return withUpdates(`${head}\n${said.slice(0, PIN_CUT)} [...]\n`, updates); // an updated version is never cut
		});
		const note = cut ? `(${cut} of the pins below end in [...]: they are cut short here, and whole in ${pins})\n\n` : "";
		pinText = `${withUpdates(blocks[0], updates)}\n\n${note}${middle.join("\n")}\n${tail.map((b) => withUpdates(b, updates)).join("\n")}`;
	}
	const lines = read(journal).trim().split("\n").filter(Boolean);
	const topics = lines.filter((l) => /^\d+\. SLEEP /.test(l));
	return [
		`AGENTJOURNAL WAKE-UP (${why}). What you remember of earlier work is now a summary, or nothing.`,
		"The pins and the journal below were written as things happened. They are the truth; your recollection is not.",
		"",
		`## PINNED - what the user wrote, word for word, oldest first (${pins})`,
		"Where two pins disagree, the later one is what the user wants now: follow it, and take the earlier one as replaced.",
		'A pin marked "after action N" arrived after journal line N. Work journaled before that line was done under the',
		"instructions as they stood then; if the pin changes them, check that work against the pin before you build on it.",
		...(updates.length
			? ['A sub-chapter under a pin ("#### 1.1 updated by pin 2") is that instruction written out in full as it stands now. You wrote it when the change arrived; the user\'s own words are the pins.']
			: []),
		"",
		pinText,
		"",
		...(topics.length ? [`## TOPICS CLOSED - ${topics.length}, in order`, ...topics, ""] : []),
		`## JOURNAL - your last ${Math.min(JOURNAL_TAIL, lines.length)} of ${lines.length} actions (${journal})`,
		lines.length ? lines.slice(-JOURNAL_TAIL).join("\n") : "(no actions journaled yet)",
		"",
		"Continue from these. Before you say you are done, check every pin that a later one has not replaced, and recount any number from the journal or the output, not from memory.",
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
	const checked = path.join(dir, "CHECKED"); // the last pin the agent was asked about, or answered for
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
		// Where in the job the message arrived: what was journaled before it was done without it.
		const done = count(journal, /^\d+\. /);
		const n = count(pins, /^### /) + 1;
		fs.appendFileSync(pins, `### ${n} (${stamp}${done ? `, after action ${done}` : ""})\n${prompt}\n\n`);
		// From the second message on, ask for the updated version now, while the agent still has the conversation the
		// message was said in. Claude Code and Codex hand this to the model with the message; a tool that ignores the
		// output of this event still has the same sentence from the start of the session.
		if (n > 1) {
			const text = `AgentJournal: this message is pin ${n}. ${howToUpdate()} If it changes nothing an earlier pin asked for, ignore this.`;
			process.stdout.write(JSON.stringify(ev.hook_event_name
				? { hookSpecificOutput: { hookEventName: ev.hook_event_name, additionalContext: text } }
				: { additionalContext: text }));
		}
		return;
	}
	if (action === "journal") {
		// What the agent wrote with `agentjournal note|sleep|update` replaces the plain line for that command.
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
			if (a.kind === "update") {
				// Kept whole, beside the pins: it is shown under the pin it changes at every wake-up.
				const by = count(pins, /^### /);
				fs.appendFileSync(path.join(dir, "UPDATES.jsonl"), JSON.stringify({ pin: a.pin, by, text: a.text, at: a.at }) + "\n");
				append(journal, `UPDATE pin ${a.pin} (changed by pin ${by}): ${oneLine(a.text, 600)}`);
				fs.writeFileSync(checked, String(by));
				continue;
			}
			if (a.kind === "same") {
				append(journal, `NOTE pin ${count(pins, /^### /)} changes no earlier pin`);
				fs.writeFileSync(checked, String(count(pins, /^### /)));
				continue;
			}
			append(journal, `${a.kind === "sleep" ? "SLEEP" : "NOTE"} ${oneLine(a.text, 600)}`);
			if (a.kind === "sleep") slept = true;
		}
		const context = [];
		if (slept) {
			fs.writeFileSync(pending, dir);
			// The last moment the conversation still exists: a change that was never written out in full goes with it.
			const n = count(pins, /^### /);
			const upTo = Number(read(checked)) || 1;
			if (n > upTo) {
				fs.writeFileSync(checked, String(n));
				context.push(
					`AgentJournal: before the context is cleared, look at pin${n - upTo > 1 ? `s ${upTo + 1} to ${n}` : ` ${n}`} ` +
						`(the user's message${n - upTo > 1 ? "s" : ""} since you last checked). ${howToUpdate()} After the clear only the pins and what is ` +
						"written under them remain.",
				);
			}
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
