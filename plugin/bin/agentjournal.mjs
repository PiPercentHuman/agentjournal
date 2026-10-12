#!/usr/bin/env node
// The `agentjournal` command. The agent runs the first six itself.
//
//   agentjournal note "<line>"     put one line in the journal: a decision, a count, a list so far
//   agentjournal sleep "<topic>"   close a topic: journal what it came to, then clear the context and wake up from the
//                                  pins and the journal (pi: at once, in the same session; Claude Code: when the turn
//                                  ends the user is told it is safe to /clear, and the /clear wakes up from them)
//   agentjournal update <pin> "<the instruction as it stands now, in full>"
//                                  when a new message changes something pin <pin> asked for: the updated version is
//                                  kept as a sub-chapter under that pin (the user's own words are never touched)
//   agentjournal same              the answer when asked and the latest message changes no earlier pin
//   agentjournal pins             the pins by number, one line each, with their updated versions
//   agentjournal status            where the journal is, its size, the topics closed, whether a sleep is pending
//   agentjournal pi [pi options]   pi with the AgentJournal extension (pi's options alone, `agentjournal --model ...`,
//                                  do the same, as in 0.1; any other word is an error, never a program left waiting)
//
// `note`, `sleep`, `update` and `same` only write .agentjournal/INBOX.jsonl; the hooks (Claude Code, Codex, Copilot) or the pi
// extension move it into the session's notes, because they know which session asked.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [cmd, ...rest] = process.argv.slice(2);

// The journal folder: AGENTJOURNAL_ROOT, else the nearest .agentjournal above, else here.
function findRoot() {
	if (process.env.AGENTJOURNAL_ROOT) return process.env.AGENTJOURNAL_ROOT;
	for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".agentjournal"))) return path.join(dir, ".agentjournal");
		if (path.dirname(dir) === dir) return path.join(process.cwd(), ".agentjournal");
	}
}
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
// Claude Code names the session and the window to the agent's shell. With them a note reaches only the session that
// wrote it, and `status` reads this window's journal when several windows are open on one project.
const session = process.env.CLAUDE_CODE_SESSION_ID;
const windowTag = process.env.CLAUDE_PID ? `.${process.env.CLAUDE_PID}` : "";
// This window's notes (the folder the hook or the extension wrote to last).
const lastDir = (root) => (read(path.join(root, `LAST${windowTag}`)) || read(path.join(root, "LAST"))).trim();
const leave = (root, entry) => {
	fs.mkdirSync(root, { recursive: true });
	fs.appendFileSync(path.join(root, "INBOX.jsonl"), JSON.stringify({ ...entry, at: new Date().toISOString(), ...(session ? { session } : {}) }) + "\n");
};

if (cmd === "note" || cmd === "sleep") {
	const text = rest.join(" ").trim();
	if (!text) {
		console.error(`usage: agentjournal ${cmd} "<${cmd === "sleep" ? "what this topic came to, in one line" : "one line"}>"`);
		process.exit(2);
	}
	leave(findRoot(), { kind: cmd, text });
	console.log(cmd === "sleep" ? "Journaled: topic closed. Continue from the pins and the journal." : "Journaled.");
} else if (cmd === "update") {
	const pin = Number(String(rest[0] ?? "").replace(/^#/, ""));
	const text = rest.slice(1).join(" ").trim();
	const root = findRoot();
	const dir = lastDir(root);
	const blocks = dir ? read(path.join(dir, "PINNED.md")).trim().split(/\n(?=### )/).filter(Boolean) : [];
	const known = blocks.length;
	const flat = (s) => s.replace(/\s+/g, " ").trim();
	const latest = known ? flat(blocks[known - 1].split("\n").slice(1).join(" ")) : "";
	if (!Number.isInteger(pin) || pin < 1 || !text || (known && pin > known)) {
		console.error('usage: agentjournal update <pin number> "<the instruction as it stands now, written out in full>"');
		if (known && pin > known) console.error(`there is no pin ${pin}: the pins are 1 to ${known} (\`agentjournal pins\` lists them)`);
		process.exit(2);
	}
	// What a small model does when it has not understood: it files the new message under itself, or copies it.
	if (known > 1 && pin === known) {
		console.error(`Not journaled: pin ${pin} is the latest message itself. Give the number of the EARLIER pin it changes (1 to ${known - 1}) and write that earlier instruction out in full with the change applied. If it changes no earlier pin, run: agentjournal same`);
		process.exit(2);
	}
	if (known > 1 && latest.includes(flat(text))) {
		console.error(`Not journaled: that is the latest message copied. Write out the instruction of pin ${pin} that it changes, in full, with the change applied.`);
		process.exit(2);
	}
	leave(root, { kind: "update", pin, text });
	console.log(`Journaled: pin ${pin} now has an updated version under it.`);
} else if (cmd === "same") {
	leave(findRoot(), { kind: "same" });
	console.log("Noted: the latest message changes no earlier pin.");
} else if (cmd === "pins") {
	const dir = lastDir(findRoot());
	const updates = read(path.join(dir, "UPDATES.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const blocks = read(path.join(dir, "PINNED.md")).trim().split(/\n(?=### )/).filter(Boolean);
	if (!blocks.length) console.log("(no pins yet)");
	for (const b of blocks) {
		const [head, ...body] = b.split("\n");
		const n = Number((head.match(/^### (\d+)/) ?? [])[1]);
		const said = body.join(" ").replace(/\s+/g, " ").trim();
		console.log(`${n}. ${said.slice(0, 160)}${said.length > 160 ? " [...]" : ""}`);
		updates.filter((u) => u.pin === n).forEach((u, k) => console.log(`   ${n}.${k + 1} updated by pin ${u.by}: ${u.text}`));
	}
} else if (cmd === "status") {
	const root = findRoot();
	const dir = lastDir(root);
	const lines = read(path.join(dir, "JOURNAL.md")).split("\n").filter(Boolean);
	const pins = read(path.join(dir, "PINNED.md")).split("\n").filter((l) => /^### /.test(l)).length;
	const updates = read(path.join(dir, "UPDATES.jsonl")).split("\n").filter(Boolean).length;
	console.log(`journal folder: ${dir || "(none yet)"}`);
	console.log(`pins: ${pins}   updated versions: ${updates}   journal lines: ${lines.length}`);
	for (const l of lines.filter((l) => /^\d+\. SLEEP /.test(l))) console.log(`topic: ${l}`);
	if (fs.existsSync(path.join(root, `SLEEP_PENDING${windowTag}`))) console.log("sleep pending: the context can be cleared once this turn ends");
	const waiting = read(path.join(root, "INBOX.jsonl")).split("\n").filter(Boolean).length;
	if (waiting) console.log(`not yet journaled: ${waiting} (taken in after this command finishes)`);
} else if (cmd === "pi" || (cmd?.startsWith("-") && cmd !== "--help" && cmd !== "-h")) {
	// `agentjournal pi ...`, or pi's own options straight away: start pi with the extension, as 0.1 did.
	process.argv.splice(2, cmd === "pi" ? 1 : 0);
	await import("../../pi/bin/agentjournal.mjs"); // only in the full package, not in the plugin copy
} else {
	// Help, and any word that is not a command. Never pi: an agent that guesses a command (`agentjournal read 1`) would
	// start an interactive program and wait on it for good.
	const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
	const help = lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
	const asked = cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h";
	if (!asked) console.error(`agentjournal: there is no command "${cmd}".`);
	(asked ? console.log : console.error)(help);
	process.exit(asked ? 0 : 2);
}
