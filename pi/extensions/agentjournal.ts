/**
 * AgentJournal for pi: pin what you were told, journal what you did, sleep when your head is full.
 *
 * Before every request the model sees exactly this, and nothing older:
 *   PINNED  every message the user wrote, word for word. Fixed.
 *   JOURNAL one line for each action older than the steps below: what the model did, never what it read.
 *   the raw steps since the last sleep (tool calls and their results).
 * While awake, the raw steps only grow at the end, so the server can reuse what it already read. When they pass
 * AGENTJOURNAL_SLEEP_TOKENS (estimated), the model "sleeps": everything older than the last AGENTJOURNAL_KEEP_STEPS steps is
 * folded into the JOURNAL at once, and the JOURNAL stays fixed until the next sleep.
 *
 * Measured (local Qwen3.5-9B, 24- and 60-file jobs; benchmark/ in this repository): the same design finished 10/10
 * 24-file jobs with the right carried count and 3/3 60-file jobs longer than every window, at about the compute of
 * keeping everything. It cancels pi's own size-triggered compaction, so the two never fight over one context.
 *
 * The pins and the full journal are also written to .agentjournal/<session>/PINNED.md and JOURNAL.md, like the hook version.
 * Env: AGENTJOURNAL_SLEEP_TOKENS (9000), AGENTJOURNAL_KEEP_STEPS (3), AGENTJOURNAL_DIR (.agentjournal)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const SLEEP_TOKENS = Number(process.env.AGENTJOURNAL_SLEEP_TOKENS ?? 9000);
const KEEP_STEPS = Number(process.env.AGENTJOURNAL_KEEP_STEPS ?? 3);

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

const chars = (m: Msg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).length;

export default function (pi: ExtensionAPI) {
	const dir = path.resolve(process.cwd(), process.env.AGENTJOURNAL_DIR ?? ".agentjournal", new Date().toISOString().replace(/[:.]/g, "-"));
	let pins: string[] = [];
	let journal = ""; // frozen between sleeps, so the memory message stays byte-for-byte the same
	let cutAt = -1; // where the raw steps kept since the last sleep begin (-1: no sleep yet)
	let written = 0; // assistant turns already written to JOURNAL.md
	let sentTokens = 0; // estimate of the request this extension actually sends

	const memory = () =>
		[
			"# AGENTJOURNAL",
			"Older conversation is gone. This, and your steps since the last sleep, are all you can see.",
			"",
			"## PINNED (what the user asked, word for word; fixed)",
			...pins.map((p, i) => `### ${i + 1}\n${p}`),
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
		fs.mkdirSync(dir, { recursive: true });
		const users = msgs.filter((m) => m.role === "user").map(text);
		if (users.length !== pins.length) {
			pins = users;
			fs.writeFileSync(path.join(dir, "PINNED.md"), pins.map((p, i) => `### ${i + 1}\n${p}\n`).join("\n"));
		}
		if (turns.length > written) {
			fs.appendFileSync(path.join(dir, "JOURNAL.md"), turns.slice(written).map((m, i) => `${written + i + 1}. ${action(m)}\n`).join(""));
			written = turns.length;
		}

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
		if (estimate > SLEEP_TOKENS && start > rawStart) {
			// Sleep: fold everything older than the recent steps into the journal, once.
			cutAt = start;
			let n = 0;
			journal = msgs
				.slice(0, cutAt)
				.filter((m) => m.role === "assistant")
				.map((m) => `${++n}. ${action(m)}`)
				.join("\n");
		}
		const first = msgs.find((m) => m.role === "user");
		const pinned: Msg = { ...(first ?? {}), role: "user", content: [{ type: "text", text: memory() }] };
		const sent = [pinned, ...msgs.slice(cutAt >= 0 ? cutAt : rawStart)];
		sentTokens = sent.reduce((a, m) => a + chars(m), 0) / 4;
		return { messages: sent as any };
	});
}
