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
	// (the model has also said the second message needs no updated version: it states the change in full)
	fs.writeFileSync(path.join(root, "INBOX.jsonl"), [{ kind: "same" }, { kind: "sleep", text: "topic 1 done" }].map((e) => JSON.stringify(e)).join("\n") + "\n");

	const sent = (await handlers.context({ messages })).messages;
	const memory = sent[0].content[0].text;
	assert.ok(memory.indexOf("END ALPHA") < memory.indexOf("the final line must say END BRAVO"), "both pins, in the order given");
	assert.match(memory, /### 2 \(after step 3\)\nChange of plan/);
	assert.ok(memory.includes(RULE));
	assert.match(memory, /3\. CALL bash .*n03\.txt/, "the three steps before the change are journal lines 1 to 3");
	assert.deepEqual(sent.slice(1).map((m) => m.role), ["assistant", "toolResult"], "only the step that slept is left of the raw conversation");
});

// A message may arrive with no content at all (an empty tool or system turn). The token estimate used to do
// JSON.stringify(undefined).length on it and throw "Cannot read properties of undefined (reading 'length')" from
// the context handler on every request, which pi reported as an extension error.
test("pi: a message with no content does not break the context handler", async () => {
	const root = tmp();
	process.env.AGENTJOURNAL_ROOT = root;
	const handlers = {};
	const extension = (await import(pathToFileURL(path.join(repo, "pi", "extensions", "agentjournal.ts")).href)).default;
	extension({ on: (name, fn) => (handlers[name] = fn) });
	const messages = [
		{ role: "user", content: "Do topic 1." },
		{ role: "assistant" },
		{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
		{ role: "toolResult", content: undefined },
	];
	const sent = (await handlers.context({ messages })).messages;
	assert.equal(sent[0].role, "user", "the pin is still first");
	assert.ok(sent.some((m) => m.role === "toolResult"), "the contentless message is kept");
});

// The updated version: the agent writes the changed instruction out in full, and it is kept under the pin it changes.
const cli = (root, session, ...args) =>
	spawnSync(process.execPath, [CLI, ...args], { env: env(root, { CLAUDE_CODE_SESSION_ID: session }), encoding: "utf8" });
const FULL = "After the last file add a final line that says exactly: END BRAVO";

test("hook: the agent is asked for an updated version with every message after the first", () => {
	const root = tmp();
	assert.equal(pin(root, "s1", "After the last file add a final line that says exactly: END ALPHA"), null, "nothing to change yet");
	const asked = pin(root, "s1", "Use END BRAVO instead.");
	assert.match(asked.additionalContext, /this message is pin 2\..* update <number of the earlier pin> /, "a tool that reads a flat field");
	const named = hook(root, "pin", { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "and keep the keys in lowercase" });
	assert.match(named.hookSpecificOutput.additionalContext, /this message is pin 3\./, "Claude Code and Codex");
	assert.equal(named.hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("hook: an updated version is shown under the pin it changes, and the user's words stay as they were", () => {
	const root = tmp();
	pin(root, "s1", "After the last file add a final line that says exactly: END ALPHA");
	did(root, "s1", "ls notes");
	pin(root, "s1", "Use END BRAVO instead.");
	const before = fs.readFileSync(path.join(root, "s1", "PINNED.md"), "utf8");
	assert.equal(cli(root, "s1", "update", "7", FULL).status, 2, "there is no pin 7");
	assert.match(cli(root, "s1", "update", "2", FULL).stderr, /pin 2 is the latest message itself/, "a message is not an update of itself");
	assert.match(cli(root, "s1", "update", "1", "Use END BRAVO instead.").stderr, /the latest message copied/, "and copying it says nothing new");
	assert.equal(fs.existsSync(path.join(root, "INBOX.jsonl")), false, "none of the three was taken");
	assert.equal(cli(root, "s1", "update", "1", FULL).status, 0);
	did(root, "s1", `agentjournal update 1 "${FULL}"`);
	assert.equal(fs.readFileSync(path.join(root, "s1", "PINNED.md"), "utf8"), before, "the pin file holds the user's words only");

	const text = woken(hook(root, "wake", { session_id: "s1", hook_event_name: "SessionStart", source: "compact" }));
	const sub = text.indexOf(`#### 1.1 updated by pin 2 (how this part stands now; it replaces that part of pin 1 above)\n${FULL}`);
	assert.ok(sub > text.indexOf("END ALPHA") && sub < text.indexOf("### 2 ("), "between pin 1's words and pin 2");
	assert.ok(text.includes("Use END BRAVO instead."), "the short message is still pinned as written");
	assert.match(text, /2\. UPDATE pin 1 \(changed by pin 2\): After the last file/, "and the journal says when it was written");
	assert.match(cli(root, "s1", "pins").stdout, /^1\. After the last file.*END ALPHA\n {3}1\.1 updated by pin 2: .*END BRAVO\n2\. Use END BRAVO instead\.$/m);
});

test("hook: in a long session an updated version is never cut short", () => {
	const root = tmp();
	pin(root, "s1", "First message.");
	const long = (n) => `Message ${n}: ` + "more detail about the job ".repeat(20);
	for (let n = 2; n <= 40; n++) pin(root, "s1", long(n));
	const whole = "Message 3 as it stands now: " + "every word of the changed instruction ".repeat(12);
	assert.equal(cli(root, "s1", "update", "3", whole).status, 0);
	did(root, "s1", "agentjournal update 3 ...");
	const text = woken(hook(root, "wake", { session_id: "s1", hook_event_name: "SessionStart", source: "compact" }));
	assert.match(text, /^Message 3: .* \[\.\.\.\]$/m, "pin 3 itself is cut short");
	assert.ok(text.includes(`#### 3.1 updated by pin 40 (how this part stands now; it replaces that part of pin 3 above)\n${whole.trim()}`));
});

test("pi: the question stays until it is answered, a sleep waits for the answer, and the update goes under its pin", async () => {
	const root = tmp();
	process.env.AGENTJOURNAL_ROOT = root;
	const handlers = {};
	const extension = (await import(pathToFileURL(path.join(repo, "pi", "extensions", "agentjournal.ts")).href)).default;
	extension({ on: (name, fn) => (handlers[name] = fn) });
	const step = (command) => [
		{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
	];
	const leave = (entry) => fs.writeFileSync(path.join(root, "INBOX.jsonl"), JSON.stringify(entry) + "\n");
	const question = /pin 2 is the user's latest message\. .*\(pin 1\)\? .*agentjournal update <that earlier pin's number> .*agentjournal same /;
	const messages = [
		{ role: "user", content: "After the last file add a final line that says exactly: END ALPHA" },
		...step('echo "n01.txt key" >> answers.txt'),
		{ role: "user", content: "Use END BRAVO instead." },
	];
	let sent = (await handlers.context({ messages })).messages;
	assert.equal(sent.at(-1).content[0].text, "Use END BRAVO instead.");
	assert.match(sent.at(-1).content[1].text, question, "the question comes with the message");
	assert.ok(!sent[0].content[0].text.includes("[AgentJournal]"), "the pin keeps the user's words only");
	assert.equal(messages[3].content, "Use END BRAVO instead.", "and pi's own history is not touched");

	// The model sleeps first: nothing is folded while the question is open, and it is put again.
	messages.push(...step('agentjournal sleep "topic 1 done"'));
	leave({ kind: "sleep", text: "topic 1 done" });
	sent = (await handlers.context({ messages })).messages;
	assert.ok(sent.some((m) => m.role === "user" && m !== sent[0]), "the message it has to read the answer from is still there");
	assert.match(sent.at(-1).content.at(-1).text, question);

	// It answers: the update is under pin 1, the sleep it asked for happens, and the question is gone.
	messages.push(...step(`agentjournal update 1 "${FULL}"`));
	leave({ kind: "update", pin: 1, text: FULL });
	sent = (await handlers.context({ messages })).messages;
	const memory = sent[0].content[0].text;
	const sub = memory.indexOf(`#### 1.1 updated by pin 2 (how this part stands now; it replaces that part of pin 1 above)\n${FULL}`);
	assert.ok(sub > memory.indexOf("END ALPHA") && sub < memory.indexOf("### 2 (after step 1)"), "between pin 1's words and pin 2");
	assert.deepEqual(sent.slice(1).map((m) => m.role), ["assistant", "toolResult"], "folded down to the last step");
	assert.ok(!JSON.stringify(sent.slice(1)).includes("[AgentJournal]"));
});

test("pi: `agentjournal same` answers the question, and an unanswered one is dropped after three tries", async () => {
	const root = tmp();
	process.env.AGENTJOURNAL_ROOT = root;
	const handlers = {};
	const extension = (await import(pathToFileURL(path.join(repo, "pi", "extensions", "agentjournal.ts")).href)).default;
	extension({ on: (name, fn) => (handlers[name] = fn) });
	const step = (command) => [
		{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
	];
	const asked = async () => JSON.stringify((await handlers.context({ messages })).messages.at(-1)).includes("[AgentJournal]");
	const messages = [{ role: "user", content: "Do topic 1." }, ...step("ls"), { role: "user", content: "Now do topic 2 the same way." }];
	assert.equal(await asked(), true);
	messages.push(...step("agentjournal same"));
	fs.writeFileSync(path.join(root, "INBOX.jsonl"), JSON.stringify({ kind: "same" }) + "\n");
	assert.equal(await asked(), false, "answered");

	messages.push({ role: "user", content: "And topic 3." });
	const tries = [];
	for (let i = 0; i < 5; i++) {
		tries.push(await asked());
		messages.push(...step("ls"));
	}
	assert.deepEqual(tries, [true, true, true, false, false]);
});

test("command: a word that is not a command is an error at once, not a program left waiting", () => {
	const root = tmp();
	const r = spawnSync(process.execPath, [CLI, "read", "1"], { env: env(root), encoding: "utf8", timeout: 5000 });
	assert.equal(r.status, 2);
	assert.match(r.stderr, /there is no command "read"/);
	assert.match(r.stderr, /agentjournal update <pin>/, "and it lists the commands there are");
	assert.equal(spawnSync(process.execPath, [CLI, "same"], { env: env(root), encoding: "utf8" }).status, 0);
});
