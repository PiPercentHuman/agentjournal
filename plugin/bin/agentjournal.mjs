#!/usr/bin/env node
// The `agentjournal` command. The agent runs the first three itself.
//
//   agentjournal note "<line>"     put one line in the journal: a decision, a count, a list so far
//   agentjournal sleep "<topic>"   close a topic: journal what it came to, then clear the context and wake up from the
//                                  pins and the journal (pi: at once, in the same session; Claude Code: when the turn
//                                  ends the user is told it is safe to /clear, and the /clear wakes up from them)
//   agentjournal status            where the journal is, its size, the topics closed, whether a sleep is pending
//   agentjournal pi [pi options]   pi with the AgentJournal extension (also what any other arguments do, as in 0.1)
//
// `note` and `sleep` only write .agentjournal/INBOX.jsonl; the hooks (Claude Code, Codex, Copilot) or the pi extension
// move it into the session's journal, because they know which session asked.
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

if (cmd === "note" || cmd === "sleep") {
	const text = rest.join(" ").trim();
	if (!text) {
		console.error(`usage: agentjournal ${cmd} "<${cmd === "sleep" ? "what this topic came to, in one line" : "one line"}>"`);
		process.exit(2);
	}
	const root = findRoot();
	fs.mkdirSync(root, { recursive: true });
	fs.appendFileSync(path.join(root, "INBOX.jsonl"), JSON.stringify({ kind: cmd, text, at: new Date().toISOString() }) + "\n");
	console.log(cmd === "sleep" ? "Journaled. Topic closed: end your turn now; you continue from the pins and the journal." : "Journaled.");
} else if (cmd === "status") {
	const root = findRoot();
	const dir = read(path.join(root, "LAST")).trim();
	const lines = read(path.join(dir, "JOURNAL.md")).split("\n").filter(Boolean);
	const pins = read(path.join(dir, "PINNED.md")).split("\n").filter((l) => /^### /.test(l)).length;
	console.log(`journal folder: ${dir || "(none yet)"}`);
	console.log(`pins: ${pins}   journal lines: ${lines.length}`);
	for (const l of lines.filter((l) => /^\d+\. SLEEP /.test(l))) console.log(`topic: ${l}`);
	if (fs.existsSync(path.join(root, "SLEEP_PENDING"))) console.log("sleep pending: the context can be cleared once this turn ends");
	const waiting = read(path.join(root, "INBOX.jsonl")).split("\n").filter(Boolean).length;
	if (waiting) console.log(`not yet journaled: ${waiting} (taken in after this command finishes)`);
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
	const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
	console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
} else {
	// `agentjournal pi ...`, or any other arguments: start pi with the extension, as 0.1 did.
	process.argv.splice(2, cmd === "pi" ? 1 : 0);
	await import("../../pi/bin/agentjournal.mjs"); // only in the full package, not in the plugin copy
}
