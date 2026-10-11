// What reaches the model after the user changes an instruction partway and the context is then cleared.
// No model runs here: these check the text the hook and the pi extension hand over, not which pin a model follows.
//   node --test
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(repo, "plugin", "hooks", "agentjournal-hook.mjs");
const CLI = path.join(repo, "plugin", "bin", "agentjournal.mjs");
const RULE = "Where two pins disagree, the later one is what the user wants now";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agentjournal-test-"));
// The child must not see the Claude Code session this test may itself be running in.
function env(root, extra = {}) {
	const e = { ...process.env, AGENTJOURNAL_ROOT: root, ...extra };
	for (const k of ["CLAUDE_PID", "CLAUDE_PROJECT_DIR", ...(extra.CLAUDE_CODE_SESSION_ID ? [] : ["CLAUDE_CODE_SESSION_ID"])]) delete e[k];
	return e;
}
function hook(root, action, event) {
	const r = spawnSync(process.execPath, [HOOK, action], { input: JSON.stringify(event), env: env(root), encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout ? JSON.parse(r.stdout) : null;
}
const pin = (root, session, prompt) => hook(root, "pin", { session_id: session, prompt });
const did = (root, session, command) =>
	hook(root, "journal", { session_id: session, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } });
const woken = (out) => out.hookSpecificOutput.additionalContext;

test("hook: a changed instruction is in the wake-up after a sleep and /clear, later than the one it replaces", () => {
	const root = tmp();
	pin(root, "s1", "Go through the notes. After the last file add a final line that says exactly: END ALPHA");
	for (const n of [1, 2, 3]) did(root, "s1", `echo "n0${n}.txt key" >> answers.txt`);
	pin(root, "s1", "Change of plan: the final line must say END BRAVO, not END ALPHA.");
	const slept = spawnSync(process.execPath, [CLI, "sleep", "topic 1 done: n01-n03 written"], {
		env: env(root, { CLAUDE_CODE_SESSION_ID: "s1" }),
		encoding: "utf8",
	});
	assert.equal(slept.status, 0, slept.stderr);
	did(root, "s1", "agentjournal sleep 'topic 1 done: n01-n03 written'");

	const text = woken(hook(root, "wake", { session_id: "s2", hook_event_name: "SessionStart", source: "clear" }));
	const first = text.indexOf("END ALPHA");
	const change = text.indexOf("the final line must say END BRAVO");
	assert.ok(first > 0 && change > first, "both pins, the change after the original");
	assert.match(text, /### 2 \([^)]*, after action 3\)\nChange of plan/, "the change is stamped with the action it arrived after");
	assert.ok(text.indexOf(RULE) > 0 && text.indexOf(RULE) < first, "the rule for two pins that disagree comes before the pins");
	assert.match(text, /4\. SLEEP topic 1 done/, "the closed topic is numbered after the change, so the two can be compared");
});

test("hook: a short change of mind in the middle of a long session is still shown whole", () => {
	const root = tmp();
	pin(root, "s1", "First message: write every key in lowercase.");
	did(root, "s1", "ls notes");
	pin(root, "s1", "No: write every key in UPPERCASE from now on.");
	const long = (n) => `Message ${n}: ` + "more detail about the job ".repeat(20);
	for (let n = 3; n <= 40; n++) pin(root, "s1", long(n));
	assert.ok(fs.statSync(path.join(root, "s1", "PINNED.md")).size > 8000, "the pin file is past the size where the wake-up shortens it");

	const text = woken(hook(root, "wake", { session_id: "s1", hook_event_name: "SessionStart", source: "compact" }));
	assert.ok(text.includes("First message: write every key in lowercase."), "the first pin is whole");
	assert.ok(text.includes("No: write every key in UPPERCASE from now on."), "the change of mind is whole");
	assert.ok(text.includes(long(40).trim()), "the latest pin is whole");
	for (let n = 1; n <= 40; n++) assert.match(text, new RegExp(`^### ${n} \\(`, "m"), `pin ${n} has its heading`);
	assert.match(text, /^Message 3: .* \[\.\.\.\]$/m, "a long pin between them is cut short and marked");
	assert.match(text, /of the pins below end in \[\.\.\.\]/, "and the wake-up says where the whole text is");
});

test("pi: after a sleep the changed instruction is still pinned, marked with the step it arrived after", async () => {
	const root = tmp();
	process.env.AGENTJOURNAL_ROOT = root;
	const handlers = {};
	const extension = (await import(pathToFileURL(path.join(repo, "pi", "extensions", "agentjournal.ts")).href)).default;
	extension({ on: (name, fn) => (handlers[name] = fn) });

	const step = (command) => [
		{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
	];
	const messages = [
		{ role: "user", content: "After the last file add a final line that says exactly: END ALPHA" },
		...[1, 2, 3].flatMap((n) => step(`echo "n0${n}.txt key" >> answers.txt`)),
		{ role: "user", content: [{ type: "text", text: "Change of plan: the final line must say END BRAVO, not END ALPHA." }] },
		...step('agentjournal sleep "topic 1 done"'),
	];
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "INBOX.jsonl"), JSON.stringify({ kind: "sleep", text: "topic 1 done" }) + "\n");

	const sent = (await handlers.context({ messages })).messages;
	const memory = sent[0].content[0].text;
	assert.ok(memory.indexOf("END ALPHA") < memory.indexOf("the final line must say END BRAVO"), "both pins, in the order given");
	assert.match(memory, /### 2 \(after step 3\)\nChange of plan/);
	assert.ok(memory.includes(RULE));
	assert.match(memory, /3\. CALL bash .*n03\.txt/, "the three steps before the change are journal lines 1 to 3");
	assert.deepEqual(sent.slice(1).map((m) => m.role), ["assistant", "toolResult"], "only the step that slept is left of the raw conversation");
});
