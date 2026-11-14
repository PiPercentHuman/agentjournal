/**
 * AgentJournal for pi: pin what you were told, journal what you did, sleep when your head is full.
 *
 * Before every request the model sees exactly this, and nothing older:
 *   PINNED  every message the user wrote, word for word, oldest first, each marked with the step it arrived after.
 *           Never rewritten; where two disagree, the model is told the later one stands. When a message changes an
 *           earlier pin, the model is asked (once, with that message) to write the changed instruction out in full:
 *           `agentjournal update <pin> "<...>"`. That updated version is shown as a sub-chapter under the pin.
 *   JOURNAL one line for each action older than the steps below: what the model did, never what it read.
 *   the raw steps since the last sleep (tool calls and their results).
 * While awake, the raw steps only grow at the end, so the server can reuse what it already read. When they pass
 * AGENTJOURNAL_SLEEP_TOKENS (estimated), the model "sleeps": everything older than the last AGENTJOURNAL_KEEP_STEPS steps is
 * folded into the JOURNAL at once, and the JOURNAL stays fixed until the next sleep. The model can also sleep on purpose
 * when it finishes a topic: `agentjournal sleep "<what it came to>"` folds everything but that one step right away.
 *
 * Measured (local Qwen3.5-9B, 24- and 60-file jobs; benchmark/ in this repository): the same design finished 10/10
 * 24-file jobs with the right carried count and 3/3 60-file jobs longer than every window, at about the compute of
 * keeping everything. It cancels pi's own size-triggered compaction, so the two never fight over one context.
 *
 * The pins and the full journal are also written to .agentjournal/<session>/PINNED.md and JOURNAL.md, like the hook version.
 * Env: AGENTJOURNAL_SLEEP_TOKENS (9000), AGENTJOURNAL_KEEP_STEPS (3), AGENTJOURNAL_ROOT or AGENTJOURNAL_DIR (.agentjournal)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SLEEP_TOKENS = Number(process.env.AGENTJOURNAL_SLEEP_TOKENS ?? 9000);
const KEEP_STEPS = Number(process.env.AGENTJOURNAL_KEEP_STEPS ?? 3);
const ASK_UPDATES = Number(process.env.AGENTJOURNAL_ASK_UPDATES ?? 3); // 0: never ask whether a message changes a pin

type Msg = { role: string; content: any; [k: string]: any };

const text = (m: Msg): string =>
	typeof m.content === "string"
		? m.content
		: (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

// One action as one line: the model's own words and its calls. Results are not part of it.
const action = (m: Msg): string =>
	(m.content ?? [])
		.map((c: any) => (c.type === "toolCall" ? `CALL ${c.name} ${JSON.stringify(c.arguments)}` : c.type === "text" ? c.text : ""))
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

// A message may carry no content at all (empty tool/system turns). JSON.stringify(undefined) is undefined, so
// guard it: without this the estimate and the sent-token reduce throw "Cannot read properties of undefined (reading 'length')".
const chars = (m: Msg | undefined): number => {
	const c = m?.content;
	if (typeof c === "string") return c.length;
	if (c === undefined || c === null) return 0;
	return (JSON.stringify(c) ?? "").length;
};

export default function (pi: ExtensionAPI) {
	const root = process.env.AGENTJOURNAL_ROOT ?? path.resolve(process.cwd(), process.env.AGENTJOURNAL_DIR ?? ".agentjournal");
	process.env.AGENTJOURNAL_ROOT = root; // the `agentjournal note|sleep` the model runs writes to this same folder
	try {
		// So the model's shell finds `agentjournal` even when this package came in by `pi install`, not npm.
		const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "bin");
		if (fs.existsSync(bin)) process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
	} catch {}
	const dir = path.join(root, new Date().toISOString().replace(/[:.]/g, "-"));
	let pins: string[] = [];
	let pinHeads: string[] = []; // "### 2 (after step 17)": the journal line a message arrived after
	let updates: { pin: number; by: number; text: string }[] = []; // what `agentjournal update` wrote, in order
	let answered = 1; // the pins up to this one need no answer (the first message has nothing earlier to change)
	let asks = 0; // how often the question about the latest pin has been put
	let sleepHeld = false; // the model asked to sleep while that question was open
	let journal = ""; // frozen between sleeps, so the memory message stays byte-for-byte the same
	let cutAt = -1; // where the raw steps kept since the last sleep begin (-1: no sleep yet)
	let written = 0; // assistant turns already written to JOURNAL.md
	let sentTokens = 0; // estimate of the request this extension actually sends

	// A pin with the updated versions of it as sub-chapters. The pin itself stays as the user wrote it.
	const pinBlock = (p: string, i: number) => {
		const subs = updates
			.filter((u) => u.pin === i + 1)
			.map((u, k) => `#### ${i + 1}.${k + 1} updated by pin ${u.by} (how this part stands now; it replaces that part of pin ${i + 1} above)\n${u.text}`);
		return `${pinHeads[i]}\n${p}${subs.length ? `\n\n${subs.join("\n\n")}` : ""}`;
	};
	// Put to the model with a message after the first, while it can still see what the message answers, and again with
	// its next steps until it answers (ASK_UPDATES times at most). A sleep it asks for meanwhile waits for the answer:
	// folding first would throw away the conversation the answer has to be read from.
	const askForUpdate = (n: number) =>
		`[AgentJournal] Before your next step: pin ${n} is the user's latest message. Does it change an instruction in an earlier ` +
		`pin (${n === 2 ? "pin 1" : `1 to ${n - 1}`})? If yes, run in bash: agentjournal update <that earlier pin's number> "<only ` +
		`the one instruction that changes, rewritten in full with the change applied; not the rest of that pin>" . If no, run in bash: ` +
		`agentjournal same . Then do what the user's message asks, starting with its first step.`;

	const memory = () =>
		[
			"# AGENTJOURNAL",
			"Older conversation is gone. This, and your steps since the last sleep, are all you can see.",
			"",
			"## PINNED (what the user wrote, word for word, oldest first)",
			"Where two pins disagree, the later one is what the user wants now: follow it, and take the earlier one as replaced.",
			'A pin marked "after step N" arrived after journal line N: the steps before it were done without it.',
			...(updates.length
				? ['A sub-chapter under a pin ("#### 1.1 updated by pin 2") is that instruction written out in full as it stands now. You wrote it when the change arrived; the user\'s own words are the pins.']
				: []),
			...pins.map(pinBlock),
			"",
			"## JOURNAL (what you did, one line a step; what you read is gone once it leaves your recent steps)",
			journal || "(nothing older than your recent steps yet)",
		].join("\n");

	// AgentJournal sleeps instead of pi's compaction. Only pi's routine size-triggered compaction is cancelled; an explicit
	// /compact and pi's overflow recovery still run as a safety net.
	pi.on("session_before_compact", async (event: any) => (event.reason === "threshold" ? { cancel: true } : undefined));

	// pi sizes the reply from its estimate of the FULL history (window - estimate - 4096, at least 1). Once the job
	// is longer than the window that leaves a 1-token reply although the request actually sent is small, and the run
	// ends (seen on a 60-file job). Raise the reply limit to the room the sent request really leaves; never lower it.
	pi.on("before_provider_request", (event: any, ctx: any) => {
		const window = ctx.model?.contextWindow;
		const modelMax = ctx.model?.maxTokens;
		const payload = event.payload;
		if (!window || !modelMax || !sentTokens || !payload || typeof payload !== "object") return undefined;
		const room = Math.min(modelMax, Math.floor(window - sentTokens * 1.3 - 4096)); // 1.3: chars/4 under-counts dense text
		if (room <= 1) return undefined;
		const patched: Record<string, unknown> = { ...payload };
		let changed = false;
		for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
			if (typeof patched[key] === "number" && (patched[key] as number) < room) {
				patched[key] = room;
				changed = true;
			}
		}
		return changed ? patched : undefined;
	});

	pi.on("context", async (event) => {
		const msgs = event.messages as Msg[];
		const turns = msgs.filter((m) => m.role === "assistant");
		if (cutAt > msgs.length || turns.length < written) {
			// pi compacted anyway (manual or overflow): the history is shorter now, so start the bookkeeping over.
			cutAt = -1;
			journal = "";
			written = turns.length;
		}

		// The files on disk: every pin, and every action so far (the context only carries the journal up to the last sleep).
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(root, "LAST"), dir); // where `agentjournal pins|status|update` look
		}
		const users = msgs.filter((m) => m.role === "user").map(text);
		if (users.length !== pins.length) {
			pins = users;
			asks = 0;
			// The step each message arrived after, counted the way the journal numbers its lines, so the two can be compared.
			let steps = 0;
			pinHeads = [];
			for (const m of msgs) {
				if (m.role === "assistant") steps++;
				else if (m.role === "user") pinHeads.push(`### ${pinHeads.length + 1}${steps ? ` (after step ${steps})` : ""}`);
			}
			fs.writeFileSync(path.join(dir, "PINNED.md"), pins.map((p, i) => `${pinHeads[i]}\n${p}\n`).join("\n"));
		}
		if (turns.length > written) {
			fs.appendFileSync(path.join(dir, "JOURNAL.md"), turns.slice(written).map((m, i) => `${written + i + 1}. ${action(m)}\n`).join(""));
			written = turns.length;
		}

		// What the model wrote with `agentjournal note|sleep|update` (its call is already an action line; this keeps the
		// text whole). A sleep is the model saying a topic is finished: fold at once, whatever the size. An update goes
		// under the pin it changes, from the next request on.
		const inbox = path.join(root, "INBOX.jsonl");
		let asked: { kind: string; text: string; pin?: number; at?: string }[] = [];
		try {
			asked = fs.readFileSync(inbox, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
			fs.unlinkSync(inbox);
		} catch {}
		for (const a of asked) {
			if (a.kind === "update" && a.pin && a.pin <= pins.length) {
				const u = { pin: a.pin, by: pins.length, text: a.text };
				updates.push(u);
				answered = pins.length;
				fs.appendFileSync(path.join(dir, "UPDATES.jsonl"), JSON.stringify({ ...u, at: a.at }) + "\n");
				fs.appendFileSync(path.join(dir, "JOURNAL.md"), `UPDATE pin ${u.pin} (changed by pin ${u.by}): ${a.text.replace(/\s+/g, " ")}\n`);
			} else if (a.kind === "same") answered = pins.length;
			else if (a.kind !== "update") fs.appendFileSync(path.join(dir, "JOURNAL.md"), `${a.kind === "sleep" ? "SLEEP" : "NOTE"} ${a.text}\n`);
		}
		const open = pins.length > answered && asks < ASK_UPDATES; // the question about the latest pin still waits
		if (asked.some((a) => a.kind === "sleep")) sleepHeld = true;
		const sleepAsked = sleepHeld && !open;
		if (sleepAsked) sleepHeld = false;

		// The recent steps: the last KEEP_STEPS assistant turns with their results (a tool call stays with its result).
		let start = msgs.length;
		for (let i = msgs.length - 1, steps = 0; i >= 0; i--) {
			if (msgs[i].role === "user") break;
			if (msgs[i].role === "assistant") {
				start = i;
				if (++steps >= KEEP_STEPS) break;
			}
		}
		const firstStep = msgs.findIndex((m) => m.role === "assistant");
		const rawStart = cutAt >= 0 ? cutAt : firstStep >= 0 ? firstStep : msgs.length;
		const estimate = (memory().length + msgs.slice(rawStart).reduce((a, m) => a + chars(m), 0)) / 4;
		// On `agentjournal sleep` keep only the step that asked for it (the call and its reply), so the model sees it slept.
		const lastStep = msgs.findLastIndex((m) => m.role === "assistant");
		const foldTo = sleepAsked ? lastStep : start;
		if ((sleepAsked || estimate > SLEEP_TOKENS) && foldTo > rawStart) {
			// Sleep: fold everything older than the recent steps into the journal, once.
			cutAt = foldTo;
			const folded = msgs.slice(0, cutAt).filter((m) => m.role === "assistant").length;
			fs.appendFileSync(path.join(dir, "JOURNAL.md"), `--- slept (${sleepAsked ? "topic closed" : "head full"}): ${folded} steps now journal only\n`);
			let n = 0;
			journal = msgs
				.slice(0, cutAt)
				.filter((m) => m.role === "assistant")
				.map((m) => `${++n}. ${action(m)}`)
				.join("\n");
		}
		const first = msgs.find((m) => m.role === "user");
		const pinned: Msg = { ...(first ?? {}), role: "user", content: [{ type: "text", text: memory() }] };
		// While the question about the latest pin is open it ends the request: on the user's message at first, then on
		// the result of each step. Only the copy sent is changed; the pin and pi's own history keep the user's words.
		const raw = msgs.slice(cutAt >= 0 ? cutAt : rawStart);
		if (open && raw.length && raw[raw.length - 1].role !== "assistant") {
			asks++;
			const last = raw[raw.length - 1];
			const parts = typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content ?? []);
			raw[raw.length - 1] = { ...last, content: [...parts, { type: "text", text: askForUpdate(pins.length) }] };
		}
		const sent = [pinned, ...raw];
		sentTokens = sent.reduce((a, m) => a + chars(m), 0) / 4;
		return { messages: sent as any };
	});
}
