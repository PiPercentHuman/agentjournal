/**
 * anchor-memory: the conversation is not kept. A memory file is.
 *
 * Before every request the model sees exactly three things:
 *   1. ANCHORS  every message the user wrote, verbatim. The harness writes them; nobody edits them.
 *   2. NOW      what the model knows at this moment, in its own words. Rewritten whole, never appended;
 *               the old version is not kept in its context.
 *   3. the last few steps (tool calls and their results), so it can finish what it just started.
 * Everything older is gone. The file on disk is the whole of the memory, and it is re-fed as it is.
 *
 * ANCHOR_MODE picks a rung. Each rung is a set of features (FEATURES below); one change per rung:
 *   plain        no memory at all: the user's words and the last steps, nothing else (plain-code baseline)
 *   tail         + the model may call `remember` to rewrite NOW when it chooses   (measured: it never chose to)
 *   nudge        + a line in the memory when NOW is stale
 *   consolidate  after every step the harness asks the model to fold that step into NOW, like a brain
 *                updating what it understands instead of keeping the transcript
 *   endonly      consolidate + an END ANCHOR: the finish condition, written once from the user's words, then fixed
 *   shape        consolidate + a NOW with a fixed shape: DONE / CARRY / NEXT
 *   anchored     consolidate + both of the above
 *   facts        anchored, but a fact to keep is PINNED ("PIN: <label>: <item>"); this code keeps a set per
 *                label (add-only, counted by code)
 *   derive       anchored, but the end anchor is written as WHEN/THEN cues and says to recount every number
 *                from what was written, not from memory (people offload: notes, tallies)
 *   recall       anchored + every step kept in an episode log on disk and a `recall` tool to search it
 *                (forget from the context, not from disk)
 *   sourced      facts, but a pin must quote the line it rests on; the code accepts it only if that quote is in
 *                a tool result of the step, and a quoted contradiction retracts it (source monitoring)
 *   boundaries   anchored, but NOW is updated only when an action completes or a call fails, not on every
 *                message (event boundaries)
 *   journal      plain + a JOURNAL of everything the model DID (its calls and its own short notes, one line a
 *                step), while everything it READ is dropped once it leaves the last steps. You remember what you
 *                did, not every word you read. Kept by the harness, so it does not depend on the model choosing to.
 *   journal+end  journal + the end anchor
 *   sleep        journal, consolidated in batches instead of every step, the way sleep does it: the raw steps
 *                grow append-only (so the server can reuse its cache) until they pass ANCHOR_SLEEP_TOKENS, then
 *                everything older than the last steps is folded into the journal at once and the journal is
 *                frozen until the next sleep
 *
 * Env: ANCHOR_MODE (tail), ANCHOR_KEEP_STEPS (3), ANCHOR_NOW_MAX_CHARS (2400), ANCHOR_DIR (.anchor),
 *      ANCHOR_NUDGE_AFTER (2 steps)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

type Features = {
	remember?: boolean;
	nudge?: boolean;
	consolidate?: "free" | "carry" | "facts" | "sourced";
	end?: "plain" | "derive";
	recall?: boolean;
	boundaries?: boolean;
	journal?: boolean;
	sleep?: boolean;
};
const FEATURES: Record<string, Features> = {
	plain: {},
	tail: { remember: true },
	nudge: { remember: true, nudge: true },
	consolidate: { remember: true, consolidate: "free" },
	endonly: { remember: true, consolidate: "free", end: "plain" },
	shape: { remember: true, consolidate: "carry" },
	anchored: { remember: true, consolidate: "carry", end: "plain" },
	facts: { remember: true, consolidate: "facts", end: "plain" },
	derive: { remember: true, consolidate: "carry", end: "derive" },
	recall: { remember: true, consolidate: "carry", end: "plain", recall: true },
	sourced: { remember: true, consolidate: "sourced", end: "plain" },
	boundaries: { remember: true, consolidate: "carry", end: "plain", boundaries: true },
	journal: { journal: true },
	"journal+end": { journal: true, end: "plain" },
	sleep: { journal: true, sleep: true },
};
const MODE = process.env.ANCHOR_MODE ?? "tail";
const F = FEATURES[MODE];
if (!F) throw new Error(`anchor-memory: unknown ANCHOR_MODE "${MODE}" (one of ${Object.keys(FEATURES).join(", ")})`);
const KEEP_STEPS = Number(process.env.ANCHOR_KEEP_STEPS ?? 3);
const NOW_MAX = Number(process.env.ANCHOR_NOW_MAX_CHARS ?? 2400);
const NUDGE_AFTER = Number(process.env.ANCHOR_NUDGE_AFTER ?? 2);
const SLEEP_TOKENS = Number(process.env.ANCHOR_SLEEP_TOKENS ?? 9000); // estimated as characters / 4
const PINS = F.consolidate === "facts" || F.consolidate === "sourced";

type Msg = { role: string; content: any; [k: string]: any };

const text = (m: Msg): string =>
	typeof m.content === "string"
		? m.content
		: (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

// One step as plain text: what the model called, and what came back (long results cut to their head and tail).
const describe = (m: Msg): string => {
	if (m.role === "assistant")
		return (m.content ?? [])
			.map((c: any) => (c.type === "toolCall" ? `CALL ${c.name} ${JSON.stringify(c.arguments)}` : c.type === "text" ? c.text : ""))
			.filter(Boolean)
			.join("\n");
	const body = text(m);
	return `RESULT ${m.toolName ?? m.role}: ${body.length > 1600 ? body.slice(0, 1000) + " ... " + body.slice(-500) : body}`;
};

// How the harness asks the model to rewrite NOW, per consolidation style.
const DONE_LINE = "DONE: the work finished so far, as a range or count, taken only from what you can see above\n";
const SHAPES = {
	free:
		"Rewrite the NOW section so it holds everything still needed to finish the job: what is done, any facts " +
		"or running counts the ANCHORS ask you to carry (update them for what just happened), and the next step. " +
		"Do not keep logs or copies of file contents. Reply with the new NOW text only.",
	carry:
		"Reply with exactly three lines and nothing else:\n" +
		DONE_LINE +
		"CARRY: every fact the START ANCHOR asks you to keep, updated for what just happened. For a count, " +
		"keep the list of the items it counts (for example the file names), never a bare tally: an item " +
		"already in the list is not added again, and the count is the length of the list\n" +
		"NEXT: the single next action\n" +
		"Never mark something done that WHAT JUST HAPPENED does not show.",
	facts:
		"Reply with these lines and nothing else:\n" +
		DONE_LINE +
		"NEXT: the single next action\n" +
		"Then one line for each NEW fact the START ANCHOR asks you to keep track of, shown in WHAT JUST " +
		"HAPPENED, in the form  PIN: <label>: <item>  (for example  PIN: urgent: n03.txt). Pinned facts are " +
		"kept for you and counted for you; pinning one again changes nothing. Never pin what you cannot see above.",
	sourced:
		"Reply with these lines and nothing else:\n" +
		DONE_LINE +
		"NEXT: the single next action\n" +
		"Then one line for each NEW fact the START ANCHOR asks you to keep track of, in the form\n" +
		"  PIN: <label>: <item> | <the exact line, copied from a RESULT above, that shows it>\n" +
		"(for example  PIN: urgent: n03.txt | STATUS: URGENT). The pin is kept only if that line really is in a " +
		"RESULT of this step. If a RESULT shows that an earlier pin is wrong, write\n" +
		"  UNPIN: <label>: <item> | <the exact line that shows it>",
};
const END_PROMPTS = {
	plain:
		"Write the finish condition for this job: a short checklist of everything that must exist or be true at the " +
		"very end, in the order it must happen. Use the user's exact wording for anything they asked for word for " +
		"word. Reply with the checklist only.",
	derive:
		"Write the finish condition for this job as WHEN/THEN lines, in the order they must happen, e.g. " +
		"\"WHEN the last item is done, THEN ...\". Use the user's exact wording for anything they asked for word for " +
		"word. For every number the job asks for (a count, a total), add a line that says which record you have " +
		"written it can be recounted from, and say to recount it from that record, not from memory. Reply with the " +
		"lines only.",
};
const END_CHECK = {
	plain: "Before you say the job is finished, check every line above against what you can actually see.",
	derive:
		"Before you say the job is finished, read back what you have written and check every line above against it. " +
		"Recount any number from that record. Do not use a number you remember.",
};

export default function (pi: ExtensionAPI) {
	const dir = path.resolve(process.cwd(), process.env.ANCHOR_DIR ?? ".anchor");
	const file = path.join(dir, "MEMORY.md");
	const episodes = path.join(dir, "episodes.log");
	let now = "(empty: nothing done yet)";
	let anchors: string[] = [];
	let revision = 0;
	let nowAtStep = 0; // the step count when NOW was last written
	let folded = 0; // messages already folded into NOW
	let logged = 0; // messages already written to the episode log
	let endAnchor = ""; // the finish condition, written once from the START ANCHOR, then fixed
	let stepCount = 0;
	let journalText = ""; // journal mode: one line per step older than the tail, rebuilt from the messages
	let cutAt = -1; // sleep mode: where the raw steps kept since the last sleep begin (-1: no sleep yet)
	let sleeps = 0;

	// Pinned facts, kept by this code. A count is the number of distinct items, so seeing the same file twice
	// cannot count it twice. In `facts` nothing removes an item; in `sourced` only a quoted contradiction does.
	const facts = new Map<string, Set<string>>();
	// The count goes on its own line so it cannot be copied back into an item.
	const pinned = () =>
		[...facts].map(([label, items]) => `${label}: ${[...items].join(", ")}\n  how many ${label}: ${items.size}`).join("\n");
	// One PIN line can hold several items; brackets, bare numbers and "none" are not items.
	const pinItems = (raw: string) =>
		raw
			.replace(/\([^)]*\)/g, "")
			.split(/[,;]/)
			.map((s) => s.trim().toLowerCase().replace(/\.$/, ""))
			.filter((s) => s && !/^\d+$/.test(s) && !/^(none|n\/a|na|no|nothing|null|false|-|not urgent)$/.test(s));
	const pinLabel = (raw: string) => raw.replace(/\([^)]*\)/g, "").trim().toLowerCase();

	const render = (steps: number) =>
		[
			"# MEMORY",
			"Older conversation is gone. This file and your last few steps are all you can see.",
			"",
			"## START ANCHOR (what the user asked, word for word; fixed)",
			...anchors.map((a, i) => `### ${i + 1}\n${a}`),
			...(endAnchor
				? ["", "## END ANCHOR (what must be true when the job is done; fixed)", endAnchor, END_CHECK[F.end!]]
				: []),
			...(PINS
				? [
						"",
						F.consolidate === "sourced"
							? "## PINNED FACTS (each added with a quoted line as evidence; removed only with evidence; a count is the number of distinct items)"
							: "## PINNED FACTS (added once, never changed; a count is the number of distinct items)",
						pinned() || "(none yet)",
					]
				: []),
			...(F.recall
				? ["", "Everything you have done is kept in an episode log. Use the recall tool to search it."]
				: []),
			...(F.journal
				? ["", "## JOURNAL (what you did, one line a step; what you read is gone once it leaves your last steps)",
					journalText || "(nothing older than your last steps yet)"]
				: []),
			...(F.remember || F.consolidate
				? ["", "## NOW (what you know right now; rewritten whole, never appended)", now]
				: []),
			...(F.nudge && steps - nowAtStep >= NUDGE_AFTER
				? ["", `NOTE: NOW was last updated ${steps - nowAtStep} steps ago. Call remember before your next action.`]
				: []),
		].join("\n");

	const save = (steps: number) => {
		fs.mkdirSync(dir, { recursive: true });
		const body = render(steps);
		fs.writeFileSync(file, body);
		fs.writeFileSync(path.join(dir, `rev-${String(revision).padStart(4, "0")}.md`), body);
		revision++;
	};

	const setNow = (next: string, steps: number) => {
		next = next.trim();
		if (!next) return;
		now = next.length > NOW_MAX ? next.slice(0, NOW_MAX) : next;
		nowAtStep = steps;
		save(steps);
	};

	if (F.remember)
		pi.registerTool({
			name: "remember",
			label: "Remember",
			description:
				"Replace the NOW section of your memory with a new version. Older conversation is dropped, so put " +
				"here everything you still need: what is done, facts and counts you must carry, and the next step. " +
				"Write the whole section each time, short, no logs.",
			parameters: Type.Object({ now: Type.String({ description: "The complete new NOW section" }) }),
			async execute(_id, params) {
				setNow(String(params.now ?? ""), stepCount);
				return { content: [{ type: "text", text: `Memory saved (${now.length} characters).` }], details: {} };
			},
		});

	if (F.recall)
		pi.registerTool({
			name: "recall",
			label: "Recall",
			description:
				"Search the episode log of everything you have done in this job (every call and every result, by step). " +
				"Returns the matching lines, up to 40.",
			parameters: Type.Object({ query: Type.String({ description: "Text to look for; case does not matter" }) }),
			async execute(_id, params) {
				const q = String(params.query ?? "").toLowerCase();
				const lines = fs.existsSync(episodes) ? fs.readFileSync(episodes, "utf8").split("\n") : [];
				const hits = q ? lines.filter((l) => l.toLowerCase().includes(q)).slice(-40) : [];
				return { content: [{ type: "text", text: hits.length ? hits.join("\n") : "Nothing in the log matches." }], details: {} };
			},
		});

	const ask = async (ctx: any, prompt: string, maxTokens: number) => {
		const reply = await ctx.modelRegistry.complete(
			ctx.model,
			{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{ maxTokens, cacheRetention: "none" },
		);
		return reply.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
	};

	// PIN / UNPIN lines leave NOW and change the pinned sets. `sourced` keeps a line only when its quote is in a
	// tool result of this step (the model's own words do not count as evidence).
	const applyPins = (reply: string, fresh: Msg[]) => {
		const evidence = fresh.filter((m) => m.role === "toolResult").map(text).join("\n").toLowerCase();
		const keep: string[] = [];
		for (const line of reply.split("\n")) {
			const pin = line.match(/^\s*(UN)?PIN:\s*([^:]+):\s*(.+?)\s*$/i);
			if (!pin) {
				keep.push(line);
				continue;
			}
			const remove = !!pin[1];
			let body = pin[3];
			if (F.consolidate === "sourced") {
				const bar = body.lastIndexOf("|");
				const quote = bar >= 0 ? body.slice(bar + 1).trim().toLowerCase() : "";
				if (quote.length < 6 || !evidence.includes(quote)) continue; // no evidence, no pin
				body = body.slice(0, bar);
			} else if (remove) continue; // `facts` is add-only
			const label = pinLabel(pin[2]);
			const items = pinItems(body);
			if (!label || !items.length) continue;
			if (!facts.has(label)) facts.set(label, new Set());
			for (const item of items) remove ? facts.get(label)!.delete(item) : facts.get(label)!.add(item);
		}
		return keep.join("\n");
	};

	// Fold the steps since the last fold into NOW, with one short model call.
	const consolidate = async (msgs: Msg[], ctx: any) => {
		const fresh = msgs.slice(folded).filter((m) => m.role !== "user");
		if (!fresh.length || !ctx.model) return;
		if (F.boundaries) {
			// An event ends when something changed the world or a call failed; a read alone is not a boundary,
			// so it waits and is folded together with the action that uses it.
			const acted = fresh.some(
				(m) => (m.role === "assistant" && (m.content ?? []).some((c: any) => c.type === "toolCall" && c.name !== "read")) ||
					(m.role === "toolResult" && m.isError),
			);
			if (!acted) return;
		}
		folded = msgs.length;
		const step = fresh.map(describe).join("\n").slice(-6000);
		let reply = await ask(ctx, `${render(stepCount)}\n\n## WHAT JUST HAPPENED\n${step}\n\n${SHAPES[F.consolidate!]}`, 400);
		if (PINS) reply = applyPins(reply, fresh);
		setNow(reply, stepCount);
	};

	const writeEndAnchor = async (ctx: any) => {
		if (!ctx.model) return;
		endAnchor = await ask(ctx, `## START ANCHOR\n${anchors.join("\n\n")}\n\n${END_PROMPTS[F.end!]}`, 300);
		save(stepCount);
	};

	pi.on("context", async (event, ctx) => {
		const msgs = event.messages as Msg[];
		stepCount = msgs.filter((m) => m.role === "assistant").length;
		if (F.recall && msgs.length > logged) {
			fs.mkdirSync(dir, { recursive: true });
			const lines = msgs.slice(logged).filter((m) => m.role !== "user").map((m) => `[step ${stepCount}] ${describe(m).replace(/\n/g, " ")}`);
			if (lines.length) fs.appendFileSync(episodes, lines.join("\n") + "\n");
			logged = msgs.length;
		}
		const users = msgs.filter((m) => m.role === "user").map(text);
		if (users.length !== anchors.length) {
			anchors = users;
			save(stepCount);
			if (F.end) await writeEndAnchor(ctx);
		}
		if (F.consolidate && stepCount > 0) await consolidate(msgs, ctx);
		// The tail: the last KEEP_STEPS assistant turns with their tool results. Starting the tail on an
		// assistant message keeps every tool call paired with its result.
		let start = msgs.length;
		let steps = 0;
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role === "user") break; // a new user message is already in ANCHORS
			if (msgs[i].role === "assistant") {
				start = i;
				if (++steps >= KEEP_STEPS) break;
			}
		}
		// Every assistant turn before `upTo`, as one line: its own words and its calls. Results are dropped.
		const journalOf = (upTo: number) => {
			let n = 0;
			return msgs
				.slice(0, upTo)
				.filter((m) => m.role === "assistant")
				.map((m) => `${++n}. ${describe(m).replace(/\s+/g, " ").trim()}`)
				.join("\n");
		};
		const first = msgs.find((m) => m.role === "user");
		const asMemory = (): Msg => ({ ...(first ?? {}), role: "user", content: [{ type: "text", text: render(stepCount) }] });
		if (F.sleep) {
			// Awake: the memory message stays byte-for-byte the same and the raw steps only grow at the end, so the
			// server reuses everything it has already read. Asleep: fold all but the last steps into the journal once.
			const firstStep = msgs.findIndex((m) => m.role === "assistant");
			const rawStart = cutAt >= 0 ? cutAt : firstStep >= 0 ? firstStep : msgs.length;
			const chars = (m: Msg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).length;
			const estimate = (render(stepCount).length + msgs.slice(rawStart).reduce((a, m) => a + chars(m), 0)) / 4;
			if (estimate > SLEEP_TOKENS && start > rawStart) {
				cutAt = start;
				journalText = journalOf(cutAt);
				sleeps++;
				save(stepCount);
			}
			return { messages: [asMemory(), ...msgs.slice(cutAt >= 0 ? cutAt : rawStart)] as any };
		}
		if (F.journal) journalText = journalOf(start);
		return { messages: [asMemory(), ...msgs.slice(start)] as any };
	});
}
