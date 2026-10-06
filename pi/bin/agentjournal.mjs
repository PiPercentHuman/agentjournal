#!/usr/bin/env node
// `agentjournal` = pi with the AgentJournal extension loaded. The extension itself cancels pi's size-triggered compaction
// (AgentJournal sleeps instead). Every argument is passed through to pi: --model, --provider, -p, --mode json, ...
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PI = "@earendil-works/pi-coding-agent";

// pi exports only an ES-module entry (no package.json, no require condition), so resolve it the way it is imported,
// then walk up to its folder and read package.json from disk.
let dir = path.dirname(fileURLToPath(import.meta.resolve(PI)));
while (!fs.existsSync(path.join(dir, "package.json")) || JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name !== PI) {
	const up = path.dirname(dir);
	if (up === dir) throw new Error(`agentjournal: could not find ${PI}; install it with npm i ${PI}`);
	dir = up;
}
const bin = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).bin;
const cli = path.join(dir, typeof bin === "string" ? bin : bin.pi);
const extension = path.join(here, "..", "extensions", "agentjournal.ts");

const child = spawn(process.execPath, [cli, "-e", extension, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
