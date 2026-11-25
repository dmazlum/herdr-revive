// The hooks against a fake `hc` and a fake agent process tree. The fake agent
// is a shell script named `claude`, so `ps` lists it as `/bin/sh …/claude`
// and Revive recognizes it as an agent the way it recognizes the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseProcesses, hasTranscript } from "../mods/revive/revive.mjs";
import { hookOwner, hookPayload, needsHint, command, readRecord } from "../mods/revive/lib/core.js";
import { POSIX_HARNESS, WINDOWS } from "./helpers/platform.js";

const ENGINE = resolve("mods/revive/revive.mjs");
const ID = "0c8b28eb-1111-4222-8333-444455556666";

/**
 * A fake `hc`: `get` answers from state.json, `label` appends to labels.log.
 * The foreground is the fake agent (FAKE_FG), or state.json's `fg` once a test
 * puts another process there.
 */
function setup({ labels = {}, app = null, argv = ["claude", "--model", "opus", "fix it"], bin = "claude", hookArgs = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "revive-hook-"));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ labels, app, argv }));
  const hc = join(dir, "hc");
  writeFileSync(hc, `#!/usr/bin/env node
const fs = require("fs"), dir = ${JSON.stringify(dir)};
const [cmd, t, ...rest] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const extra = state.extra ?? {};
if (cmd === "ls") {
  console.log(JSON.stringify({ terminals: [...Object.keys(extra), "t1"].map((address) => ({ address })) }));
} else if (cmd === "get" && extra[t]) {
  console.log(JSON.stringify({ address: t, state: "live", labels: {}, ...extra[t] }));
} else if (cmd === "get") {
  fs.appendFileSync(dir + "/gets.log", t + "\\n");
  const fg = state.fg ?? Number(process.env.FAKE_FG);
  let argv = state.argv;
  if (fg) {
    try { process.kill(fg, 0); } catch { argv = ["sh"]; }
  }
  console.log(JSON.stringify({ address: t, state: "live", pid: Number(process.env.FAKE_PID) || 4242, cwd: "/w", labels: state.labels,
    status: state.app ? { app: state.app, state: "working" } : null,
    foreground: { pid: fg, argv, cwd: "/w" } }));
} else if (cmd === "label") {
  fs.appendFileSync(dir + "/labels.log", JSON.stringify(rest) + "\\n");
  fs.appendFileSync(dir + "/targets.log", t + "\\n");
}
`);
  chmodSync(hc, 0o755);
  // The agent in the foreground: it records its own pid as FAKE_FG, then runs
  // either the hook or, through a shell the way an agent's tool call does,
  // another agent (a \`claude -p\` used as a tool).
  const agent = (name) => {
    const path = join(dir, name, bin);
    mkdirSync(join(dir, name));
    writeFileSync(path, `#!/bin/sh\n[ -z "$FAKE_FG" ] && export FAKE_FG=$$\nif [ -n "$NESTED" ]; then NESTED= sh -c "\\"$NESTED\\"; true"; else node ${JSON.stringify(ENGINE)} hook ${hookArgs}; fi\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const outer = agent("outer");
  const inner = agent("inner");
  const run = (payload, { nested = false, env = {} } = {}) => execFileSync(outer, [], {
    input: JSON.stringify(payload),
    env: { ...base, HC_TERMINAL_ID: "t1", REVIVE_HC: hc, NESTED: nested ? inner : "", FAKE_FG: "", ...env },
  });
  const calls = () => (existsSync(join(dir, "labels.log")) ? readFileSync(join(dir, "labels.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const gets = () => (existsSync(join(dir, "gets.log")) ? readFileSync(join(dir, "gets.log"), "utf8").trim().split("\n") : []);
  const set = (calls) => Object.fromEntries(calls.flat().map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  const state = (patch) => {
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
  };
  const targets = () => (existsSync(join(dir, "targets.log")) ? readFileSync(join(dir, "targets.log"), "utf8").trim().split("\n") : []);
  return { run, calls, gets, set, state, targets, dir };
}

const start = { hook_event_name: "SessionStart", session_id: ID, cwd: "/w", source: "startup" };
const end = (reason) => ({ hook_event_name: "SessionEnd", session_id: ID, reason });
// The test runner's own CLAUDE_CONFIG_DIR / CODEX_HOME must not leak into records.
const base = { ...process.env };
delete base.CLAUDE_CONFIG_DIR;
delete base.CODEX_HOME;
delete base.PI_CODING_AGENT_DIR;
delete base.PI_CODING_AGENT_SESSION_DIR;
delete base.COPILOT_HOME;

const remembered = { "revive.agent": "claude", "revive.session": ID, "revive.shell": "4242" };

test("the foreground agent's SessionStart is remembered, with its flags", POSIX_HARNESS, () => {
  const { run, calls, set } = setup();
  run(start);
  const got = set(calls());
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.agent"], "claude");
  assert.equal(got["revive.flags"], '["--model","opus"]');
  assert.equal(got["revive.shell"], "4242");
});

test("a `claude -p` the agent runs as a tool records nothing", POSIX_HARNESS, () => {
  const { run, calls } = setup();
  run(start, { nested: true });
  assert.deepEqual(calls(), []);
});

test("a `claude -p` typed in the terminal records nothing", POSIX_HARNESS, () => {
  const { run, calls } = setup({ argv: ["claude", "-p", "summarize this"] });
  run(start);
  run(end("other"));
  assert.deepEqual(calls(), []);
});

test("a `claude -p` typed in the terminal leaves the remembered session alone", POSIX_HARNESS, () => {
  const { run, calls } = setup({ labels: remembered, argv: ["claude", "-p", "summarize this"] });
  run({ ...start, session_id: "11111111-2222-4333-8444-555566667777" });
  assert.deepEqual(calls(), []);
});

test("Codex exec after global options leaves the remembered interactive session alone", POSIX_HARNESS, () => {
  const { run, calls } = setup({ bin: "codex", argv: ["codex", "--model", "o3", "exec", "fix it"],
    labels: { ...remembered, "revive.agent": "codex" } });
  const session_id = "batch-session";
  run({ ...start, session_id });
  run({ hook_event_name: "SessionEnd", session_id, reason: "other" });
  assert.deepEqual(calls(), []);
});

test("an automatic resume keeps its original flags through start and compaction for a later manual resume", POSIX_HARNESS, () => {
  const flags = ["--dangerously-skip-permissions", "--model", "opus"];
  const labels = { ...remembered, "revive.flags": JSON.stringify(flags) };
  const rec = readRecord(labels);
  const resumed = { agent: "claude", session: ID, flags };
  const fixture = setup({ labels, argv: command(rec, "resume", { unattended: true }) });
  for (const source of ["resume", "compact"]) fixture.run({ ...start, source }, { env: { REVIVE_RESUME: JSON.stringify(resumed) } });
  const got = readRecord({ ...labels, ...fixture.set(fixture.calls()) });
  assert.deepEqual(got.flags, flags);
  assert.deepEqual(command(got), ["claude", ...flags, "--resume", ID]);
  assert.deepEqual(command(got, "resume", { unattended: true }), ["claude", "--model", "opus", "--resume", ID]);
  fixture.run(end("other"));
  assert.equal(fixture.calls().length, 2, "a signal leaves the record available for manual resume");
  fixture.run(end("prompt_input_exit"));
  assert.equal(fixture.set(fixture.calls())["revive.session"], "", "an intentional exit still forgets the session");
});

test("resume flag context is session-specific and filtered like terminal labels", POSIX_HARNESS, () => {
  for (const context of ["{broken", JSON.stringify({ agent: "codex", session: ID, flags: ["--yolo"] }),
    JSON.stringify({ agent: "claude", session: "old-session", flags: ["--dangerously-skip-permissions"] })]) {
    const fixture = setup();
    fixture.run(start, { env: { REVIVE_RESUME: context } });
    assert.equal(fixture.set(fixture.calls())["revive.flags"], '["--model","opus"]');
  }
  const fixture = setup();
  fixture.run(start, { env: { REVIVE_RESUME: JSON.stringify({ agent: "claude", session: ID,
    flags: ["--dangerously-skip-permissions", "--settings", "/bad.json", "--model", "opus"] }) } });
  assert.equal(fixture.set(fixture.calls())["revive.flags"], '["--dangerously-skip-permissions","--model","opus"]');
});

test("a session's own config folder is remembered by name", POSIX_HARNESS, () => {
  const { run, calls, set } = setup();
  run(start, { env: { CLAUDE_CONFIG_DIR: "/h/.claude-work", CODEX_HOME: "/c" } });
  // Its name only: a label must not choose the folder a resume loads settings from.
  assert.equal(set(calls())["revive.needs"], '["CLAUDE_CONFIG_DIR"]');
  assert.equal(set(calls())["revive.env"], "");
});

test("a session without a config folder clears an older one's", POSIX_HARNESS, () => {
  const { run, calls, set } = setup({ labels: { ...remembered, "revive.env": '{"CLAUDE_CONFIG_DIR":"/old"}' } });
  run(start);
  assert.equal(set(calls())["revive.env"], "");
});

test("the command line wins over a previous agent's report", POSIX_HARNESS, () => {
  const { run, calls, set } = setup({ app: "codex" });
  run(start);
  assert.equal(set(calls())["revive.agent"], "claude");
});

test("ending a session yourself forgets it", POSIX_HARNESS, () => {
  const { run, calls, set } = setup({ labels: remembered });
  run(end("prompt_input_exit"));
  assert.equal(set(calls())["revive.session"], "");
});

test("a signal keeps the session as it was", POSIX_HARNESS, () => {
  const { run, calls } = setup({ labels: remembered });
  run(end("other"));
  assert.deepEqual(calls(), []);
});

test("/clear leaves the record to the new session's SessionStart", POSIX_HARNESS, () => {
  const { run, calls } = setup({ labels: remembered });
  run(end("clear"));
  assert.deepEqual(calls(), []);
});

test("another session's SessionEnd is ignored", POSIX_HARNESS, () => {
  const { run, calls } = setup({ labels: { ...remembered, "revive.session": "aaaaaaaa-0000-0000-0000-000000000000" } });
  run(end("prompt_input_exit"));
  assert.deepEqual(calls(), []);
});

test("ps lines parse into pid, parent, start time and words", () => {
  const table = parseProcesses([
    "  812     1 Sat Oct 31 18:49:55 2026     /bin/zsh -l",
    "  900   812 Sat Oct 31 18:50:01 2026     claude --model opus",
    "  950   900 Sat Oct 31 18:51:00 2026     /bin/sh -c node /x/revive.mjs hook",
    "garbage",
  ].join("\n"));
  assert.deepEqual(table.get(812), { ppid: 1, since: "Sat Oct 31 18:49:55 2026", argv: ["/bin/zsh", "-l"] });
  assert.equal(table.get(900).argv[0], "claude");
  assert.equal(table.size, 3);
  assert.deepEqual(hookOwner(table, 950, 900), { owned: true, agent: 900 });
  assert.deepEqual(hookOwner(table, 812, 900), { owned: false, agent: null });
});

test("a tool call's hooks are not the foreground agent's", () => {
  const table = new Map([
    [10, { ppid: 1, argv: ["/bin/zsh", "-l"] }],
    [20, { ppid: 10, argv: ["claude"] }],
    [30, { ppid: 20, argv: ["/bin/zsh", "-c", "claude -p hi"] }],
    [40, { ppid: 30, argv: ["claude", "-p", "hi"] }],
    [50, { ppid: 40, argv: ["/bin/sh", "-c", "node revive.mjs hook"] }],
  ]);
  assert.deepEqual(hookOwner(table, 50, 20), { owned: false, agent: 40 }, "claude -p under a shell under claude");
  assert.deepEqual(hookOwner(table, 50, 40), { owned: true, agent: 40 });
  assert.deepEqual(hookOwner(table, 30, 20), { owned: true, agent: 20 });
});

test("an agent behind a wrapper is still the foreground's", () => {
  // npm: node …/bin/codex runs the native codex, which runs the hook.
  const npm = new Map([
    [10, { ppid: 1, argv: ["/bin/zsh", "-l"] }],
    [20, { ppid: 10, argv: ["node", "/usr/local/lib/node_modules/@openai/codex/bin/codex", "--yolo"] }],
    [30, { ppid: 20, argv: ["/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex", "--yolo"] }],
    [40, { ppid: 30, argv: ["/bin/sh", "-c", "node revive.mjs hook"] }],
  ]);
  assert.deepEqual(hookOwner(npm, 40, 20), { owned: true, agent: 30 });
  // A launcher with another name: node …/cli.mjs runs the native codex.
  const hud = new Map([
    [10, { ppid: 1, argv: ["/bin/zsh", "-l"] }],
    [20, { ppid: 10, argv: ["node", "/home/u/.codex/codex-hud/runtime/cli.mjs"] }],
    [30, { ppid: 20, argv: ["/home/u/.codex/packages/standalone/current/bin/codex"] }],
    [40, { ppid: 30, argv: ["/bin/sh", "-c", "node revive.mjs hook"] }],
  ]);
  assert.deepEqual(hookOwner(hud, 40, 20), { owned: true, agent: 30 });
  // A codex exec the agent ran as a tool, behind a shell: not the agent's.
  const tool = new Map([...hud,
    [50, { ppid: 30, argv: ["/bin/zsh", "-c", "codex exec x"] }],
    [60, { ppid: 50, argv: ["codex", "exec", "x"] }],
    [70, { ppid: 60, argv: ["/bin/sh", "-c", "node revive.mjs hook"] }],
  ]);
  assert.equal(hookOwner(tool, 70, 20).owned, false);
});

test("the same session starting again keeps its resumed mark", POSIX_HARNESS, () => {
  const { run, calls, set } = setup({ labels: { ...remembered, "revive.resumed": "1700000000000", "revive.at": "5" } });
  run({ ...start, source: "compact" });
  const got = set(calls());
  assert.equal(got["revive.resumed"], "1700000000000");
  assert.equal(got["revive.at"], "5");
});

test("a new session starts without a resumed mark", POSIX_HARNESS, () => {
  const { run, calls, set } = setup({ labels: { ...remembered, "revive.session": "aaaaaaaa-0000-0000-0000-000000000000", "revive.resumed": "1700000000000" } });
  run({ ...start, source: "clear" });
  const got = set(calls());
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.resumed"], "");
});

test("a transcript is looked for in the engine's own config folder, never a record's", () => {
  const work = mkdtempSync(join(tmpdir(), "revive-config-"));
  mkdirSync(join(work, "projects", "-w"), { recursive: true });
  writeFileSync(join(work, "projects", "-w", `${ID}.jsonl`), "{}\n");
  const rec = { agent: "claude", session: ID, cwd: "/w", env: { CLAUDE_CONFIG_DIR: work } };
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "revive-empty-"));
    assert.equal(hasTranscript(rec), false);
    process.env.CLAUDE_CONFIG_DIR = work;
    assert.equal(hasTranscript({ ...rec, env: {} }), true);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("pi's flags and session file come from its extension, since ps shows only `pi`", POSIX_HARNESS, () => {
  const { run, calls, set } = setup({ argv: ["pi"], bin: "pi", app: "pi" });
  const file = "/h/.pi/agent/sessions/--w--/2026-11-02T10-00-00-000Z_" + ID + ".jsonl";
  run({ ...start, transcript_path: file, argv: ["pi", "--model", "sonnet", "--thinking", "high", "fix it"] }, { env: { PI_CODING_AGENT_DIR: "/h/.pi-work" } });
  const got = set(calls());
  assert.equal(got["revive.agent"], "pi");
  assert.equal(got["revive.flags"], '["--model","sonnet","--thinking","high"]');
  assert.equal(got["revive.transcript"], file);
  assert.equal(got["revive.needs"], '["PI_CODING_AGENT_DIR"]');
});

test("a pi session is resumable once its file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "revive-pi-"));
  const rec = { agent: "pi", session: ID, cwd: "/w", transcript: join(dir, `x_${ID}.jsonl`) };
  assert.equal(hasTranscript(rec), false);
  writeFileSync(rec.transcript, "{}\n");
  assert.equal(hasTranscript(rec), true);
  assert.equal(hasTranscript({ ...rec, transcript: null }), true, "no file named: unknown, let pi try");
});

/** A fake `hc` with one live terminal running claude, for `revive.mjs list`. */
function listSetup(labels) {
  const dir = mkdtempSync(join(tmpdir(), "revive-list-"));
  const hc = join(dir, "hc");
  writeFileSync(hc, `#!/usr/bin/env node
const [cmd, t] = process.argv.slice(2);
if (cmd === "ls") console.log(JSON.stringify({ terminals: [{ address: "t1" }, { address: "t2" }] }));
else if (cmd === "get") console.log(JSON.stringify({ address: t, state: "live", pid: 4242, cwd: "/w",
  labels: ${JSON.stringify(labels)},
  foreground: { pid: 4243, argv: ["claude"], cwd: "/w" } }));
`);
  chmodSync(hc, 0o755);
  const config = join(dir, "config");
  const list = (env = {}) => JSON.parse(execFileSync("node", [ENGINE, "list", "--focus", "t1"], {
    env: { ...base, REVIVE_HC: hc, CLAUDE_CONFIG_DIR: config, ...env },
  })).entries;
  const transcript = (folder = config) => {
    mkdirSync(join(folder, "projects", "-w"), { recursive: true });
    writeFileSync(join(folder, "projects", "-w", `${ID}.jsonl`), "{}\n");
  };
  return { config, list, transcript };
}

test("the focused session can be forked only once it has a transcript", POSIX_HARNESS, () => {
  const { config, list, transcript } = listSetup({ ...remembered, "revive.cwd": "/w" });
  // The agent's own sessions/<pid>.json proves the engine looks in its folder.
  mkdirSync(join(config, "sessions"), { recursive: true });
  writeFileSync(join(config, "sessions", "4243.json"), JSON.stringify({ sessionId: ID }));
  assert.equal(list()[0].forkable, false);
  transcript();
  assert.equal(list()[0].forkable, true);
  // Only the focused terminal is checked.
  assert.equal(list()[1].forkable, undefined);
});

test("a fork isn't blocked when the session's config folder isn't known", POSIX_HARNESS, () => {
  // A record without env, and no sessions/<pid>.json here: the agent may keep
  // its sessions in a folder this process doesn't know about.
  const { list } = listSetup({ ...remembered, "revive.cwd": "/w" });
  assert.equal(list()[0].forkable, null);
});

test("a config folder from a label is never believed", POSIX_HARNESS, () => {
  const own = mkdtempSync(join(tmpdir(), "revive-own-"));
  const { list, transcript } = listSetup({ ...remembered, "revive.cwd": "/w", "revive.env": JSON.stringify({ CLAUDE_CONFIG_DIR: own }) });
  transcript(own);
  const entry = list()[0];
  assert.equal(entry.rec.env, undefined);
  assert.deepEqual(entry.rec.needs, ["CLAUDE_CONFIG_DIR"]);
  assert.notEqual(entry.forkable, true, "the label's folder holding the session proves nothing");
});

test("an agent running with nothing on record is listed with its folder", POSIX_HARNESS, () => {
  const { list } = listSetup({});
  const entry = list()[0];
  assert.equal(entry.rec, null);
  assert.equal(entry.live, "claude");
  assert.equal(entry.folder, "/w");
});

/** A fake `hc` with one idle shell whose labels remember a session, for `revive.mjs resume`. */
function resumeSetup(extra = {}, terminal = {}) {
  const dir = mkdtempSync(join(tmpdir(), "revive-resume-"));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "revive-work-")));
  const hc = join(dir, "hc");
  const labels = { "revive.agent": "codex", "revive.session": ID, "revive.cwd": work, "revive.shell": "1", ...extra };
  writeFileSync(hc, `#!/usr/bin/env node
const fs = require("fs");
const [cmd, t, ...rest] = process.argv.slice(2);
if (cmd === "get") console.log(JSON.stringify({ address: t, state: "live", pid: 4242, cwd: "/w",
  labels: ${JSON.stringify(labels)},
  foreground: { pid: 4242, argv: ["zsh"], cwd: "/w" }, ...${JSON.stringify(terminal)} }));
else if (cmd === "send") fs.writeFileSync(${JSON.stringify(join(dir, "sent.json"))}, JSON.stringify({ text: rest[0], from: process.env.HC_TERMINAL_ID ?? null }));
else if (cmd === "label") fs.appendFileSync(${JSON.stringify(join(dir, "labels.txt"))}, rest.join(" ") + "\\n");
else if (cmd === "ls") console.log(JSON.stringify({ terminals: [{ address: "t1" }] }));
`);
  chmodSync(hc, 0o755);
  const list = () => JSON.parse(execFileSync("node", [ENGINE, "list"], { env: { ...base, REVIVE_HC: hc }, encoding: "utf8" })).entries[0];
  const resume = () => {
    try { execFileSync("node", [ENGINE, "resume", "t1"], { env: { ...base, REVIVE_HC: hc, HC_TERMINAL_ID: "t9" }, stdio: "pipe" }); return null; }
    catch (err) { return String(err.stderr); }
  };
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
  return { work, hc, list, resume, sent: () => JSON.parse(read("sent.json") ?? "null"), labelled: () => read("labels.txt") ?? "" };
}

test("Resume types the command as is, even when run from inside a herdr terminal", POSIX_HARNESS, () => {
  // From a terminal, `hc send` would deliver the text as a note (<hc from="t9">…</hc>).
  const { work, resume, sent } = resumeSetup();
  assert.equal(resume(), null);
  assert.equal(sent().text, `cd -- ${work} && codex resume ${ID}`);
  assert.equal(sent().from, null);
});

test("Resume still refuses a busy program or a shell outside the terminal's process tree", POSIX_HARNESS, () => {
  for (const argv of [["vim"], ["zsh"], ["sh", "-c", "sleep 60"], ["bash", "/tmp/launcher.sh"]]) {
    const fixture = resumeSetup({}, { foreground: { pid: 999999999, argv } });
    assert.match(fixture.resume(), /is busy with/);
    assert.equal(fixture.sent(), null);
  }
});

test("Resume by hand refuses a folder that failed the check, and names it", POSIX_HARNESS, () => {
  const { resume, sent } = resumeSetup({ "revive.cwd": "/nonexistent/revive-w" });
  assert.match(resume(), /Won't resume: its folder \/nonexistent\/revive-w is missing/);
  assert.equal(sent(), null, "nothing typed: the agent would start elsewhere, with its flags");
});

test("an agent behind a shell launcher is still recognized by its report", POSIX_HARNESS, () => {
  const fixture = resumeSetup({}, { foreground: { pid: 4243, argv: ["bash", "/tmp/launcher.sh"] }, status: { app: "codex" } });
  assert.match(fixture.resume(), /Codex is already running/);
  assert.equal(fixture.sent(), null);
});

// #57: the terminal's own command runs the agent (`fish -ic 'claude --resume …'`),
// so its foreground is the terminal's program, a shell running a command.
const ownCommand = (line) => ({ foreground: { pid: 4242, argv: ["fish", "-ic", line], cwd: "/w" } });

test("an agent run by the terminal's own command is running, and Resume won't type into it", POSIX_HARNESS, () => {
  const fixture = resumeSetup({ "revive.shell": "4242" }, { ...ownCommand(`codex resume ${ID}`), status: { app: "codex" } });
  assert.equal(fixture.list().live, "codex");
  assert.equal(fixture.list().state, "running");
  assert.match(fixture.resume(), /Codex is already running/);
  assert.equal(fixture.sent(), null);
});

test("Resume won't type into another agent run by the terminal's own command", POSIX_HARNESS, () => {
  const fixture = resumeSetup({}, { ...ownCommand("claude"), status: { app: "claude-code" } });
  assert.match(fixture.resume(), /busy with Claude Code/);
  assert.equal(fixture.sent(), null);
});

test("the terminal's own shell at its prompt ignores a stale agent report", POSIX_HARNESS, () => {
  const fixture = resumeSetup({ "revive.shell": "4242" }, { status: { app: "codex" } });
  assert.equal(fixture.list().live, null);
  assert.equal(fixture.list().state, "interrupted");
  assert.equal(fixture.resume(), null);
  assert.match(fixture.sent().text, new RegExp(`codex resume ${ID}`));
});

test("restore turns omp's --restore on and off for a terminal, and refuses another agent", POSIX_HARNESS, () => {
  const restore = (fixture, value) => {
    try { execFileSync("node", [ENGINE, "restore", "t1", value], { env: { ...base, REVIVE_HC: fixture.hc }, stdio: "pipe" }); return null; }
    catch (err) { return String(err.stderr); }
  };
  const omp = resumeSetup({ "revive.agent": "omp" });
  assert.equal(restore(omp, "on"), null);
  assert.equal(restore(omp, "off"), null);
  assert.deepEqual(omp.labelled().trim().split("\n"), ["revive.restore=on", "revive.restore="]);
  assert.match(restore(omp, "maybe"), /usage: revive.mjs restore T on\|off/);
  const codex = resumeSetup();
  assert.match(restore(codex, "on"), /Codex can't go on with an interrupted turn; only omp can/);
  assert.equal(restore(codex, "off"), null, "turning it off is always allowed");
  assert.doesNotMatch(codex.labelled(), /restore=on/);
});

test("Resume by hand sends --restore for an omp terminal that opted in", POSIX_HARNESS, () => {
  const { work, resume, sent } = resumeSetup({ "revive.agent": "omp", "revive.restore": "on" });
  assert.equal(resume(), null);
  assert.equal(sent().text, `cd -- ${work} && omp --restore ${ID}`);
});

test("Resume by hand refuses a session with needs, keeps it and shows the command", POSIX_HARNESS, () => {
  for (const extra of [{ "revive.needs": '["CODEX_HOME"]' }, { "revive.agent": "pi", "revive.needs": '["--session-dir"]' }]) {
    const { resume, sent, labelled } = resumeSetup(extra);
    const err = resume();
    assert.match(err, /Won't resume here: it ran with (CODEX_HOME|--session-dir)/);
    assert.match(err, new RegExp(`Set CODEX_HOME, then run: cd -- \\S+ && codex resume ${ID}|Fill in --session-dir, then run: cd -- \\S+ && pi --session-dir <folder> --session ${ID}`), "a command to copy");
    assert.equal(sent(), null);
    assert.doesNotMatch(labelled(), /revive\.session=(\s|$)/, "the record is not forgotten");
  }
});

test("the hand-resume hint puts an uncarried flag after the agent's name, with a placeholder", () => {
  const rec = { agent: "pi", session: ID, cwd: "/w x", flags: ["--model", "m"], needs: ["PI_CODING_AGENT_DIR", "--session-dir"] };
  assert.equal(needsHint(rec), `Set PI_CODING_AGENT_DIR and fill in --session-dir, then run: cd -- '/w x' && pi --session-dir <folder> --model m --session ${ID}`);
  assert.equal(needsHint({ agent: "claude", session: ID, cwd: null, flags: [], needs: ["CLAUDE_CONFIG_DIR"] }), `Set CLAUDE_CONFIG_DIR, then run: claude --resume ${ID}`);
});

// ── Factory Droid and Cursor ────────────────────────────────────────────────

const droid = { bin: "droid", argv: ["droid", "--auto", "high", "fix it"] };
const cursor = { bin: "cursor-agent", argv: ["cursor-agent", "--force", "--model", "gpt-5", "fix it"] };
const cursorStart = { hook_event_name: "sessionStart", conversation_id: ID, session_id: ID, generation_id: ID, workspace_roots: ["/w/app"], cursor_version: "2026.10.1", transcript_path: null };
const cursorEnd = (reason) => ({ hook_event_name: "sessionEnd", conversation_id: ID, session_id: ID, reason, cursor_version: "2026.10.1" });

test("droid's SessionStart is remembered, with its flags", POSIX_HARNESS, () => {
  const { run, calls, set } = setup(droid);
  run({ ...start, transcript_path: "/Users/me/.factory/projects/-w/s.jsonl" });
  const got = set(calls());
  assert.equal(got["revive.agent"], "droid");
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.flags"], '["--auto","high"]');
});

test("droid's own /exit forgets it, a signal keeps it", POSIX_HARNESS, () => {
  const exit = setup({ ...droid, labels: { ...remembered, "revive.agent": "droid" } });
  exit.run(end("prompt_input_exit"));
  assert.equal(exit.set(exit.calls())["revive.session"], "");
  const kill = setup({ ...droid, labels: { ...remembered, "revive.agent": "droid" } });
  kill.run(end("other"));
  assert.deepEqual(kill.calls(), []);
});

test("Cursor's sessionStart is remembered from its conversation id and workspace", POSIX_HARNESS, () => {
  const { run, calls, set } = setup(cursor);
  run(cursorStart);
  const got = set(calls());
  assert.equal(got["revive.agent"], "cursor");
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.cwd"], "/w/app");
  assert.equal(got["revive.flags"], '["--force","--model","gpt-5"]');
});

test("a bare `agent` that reports itself as Cursor is Cursor", POSIX_HARNESS, () => {
  const { run, calls, set } = setup({ bin: "cursor-agent", argv: ["agent", "--yolo"], app: "cursor" });
  run(cursorStart);
  assert.equal(set(calls())["revive.agent"], "cursor");
});

test("Cursor's completed session is forgotten; an aborted one is kept", POSIX_HARNESS, () => {
  const done = setup({ ...cursor, labels: { ...remembered, "revive.agent": "cursor" } });
  done.run(cursorEnd("completed"));
  assert.equal(done.set(done.calls())["revive.session"], "");
  const aborted = setup({ ...cursor, labels: { ...remembered, "revive.agent": "cursor" } });
  aborted.run(cursorEnd("aborted"));
  assert.deepEqual(aborted.calls(), []);
});

// ── Copilot CLI ─────────────────────────────────────────────────────────────

const copilot = { bin: "copilot", argv: ["copilot", "--model", "gpt-5", "--allow-all-tools", "--add-dir", "/x", "-i", "fix it"] };
const copilotRec = { ...remembered, "revive.agent": "copilot" };
// Copilot's user_exit is settled by whether the terminal's shell outlived it.
const settle = (shellPid) => ({ env: { REVIVE_SETTLE_MS: "0", FAKE_PID: String(shellPid) } });
const deadPid = () => spawnSync("true").pid;

test("Copilot CLI's SessionStart is remembered, with its flags", POSIX_HARNESS, () => {
  const { run, calls, set } = setup(copilot);
  run({ ...start, timestamp: "2026-11-12T16:27:10.315Z", source: "new", initial_prompt: "fix it" });
  const got = set(calls());
  assert.equal(got["revive.agent"], "copilot");
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.flags"], '["--model","gpt-5","--allow-all-tools"]');
});

test("`copilot -p` records nothing; `gh copilot` is not Copilot CLI", POSIX_HARNESS, () => {
  const once = setup({ ...copilot, argv: ["copilot", "-p", "summarize"] });
  once.run(start);
  assert.deepEqual(once.calls(), []);
  const gh = setup({ bin: "gh", argv: ["gh", "copilot", "suggest"] });
  gh.run(start);
  assert.deepEqual(gh.calls(), []);
});

test("Copilot's user_exit is kept when its shell died with it", POSIX_HARNESS, () => {
  const hangup = setup({ ...copilot, labels: copilotRec });
  hangup.run(end("user_exit"), settle(deadPid()));
  assert.deepEqual(hangup.calls(), []);
});

test("Copilot's /clear (user_exit, the same process still in the foreground) forgets the cleared session", POSIX_HARNESS, () => {
  const clear = setup({ ...copilot, labels: copilotRec });
  clear.run(end("user_exit"), settle(process.pid));
  assert.equal(clear.set(clear.calls())["revive.session"], "");
});

const settled = async (h) => {
  for (let i = 0; i < 20 && !h.calls().length; i++) await new Promise((r) => setTimeout(r, 50));
};

test("Copilot's user_exit is kept when another Copilot is in the foreground by then, or a new session is on record", POSIX_HARNESS, async () => {
  // `copilot --resume <id>` typed again within the wait: it may be this same session.
  const rerun = setup({ ...copilot, labels: copilotRec });
  rerun.run(end("user_exit"), { env: { REVIVE_SETTLE_MS: "300", FAKE_PID: String(process.pid) } });
  rerun.state({ fg: process.pid });
  await settled(rerun);
  assert.deepEqual(rerun.calls(), []);
  const next = setup({ ...copilot, labels: copilotRec });
  next.run(end("user_exit"), { env: { REVIVE_SETTLE_MS: "300", FAKE_PID: String(process.pid) } });
  next.state({ labels: { ...copilotRec, "revive.session": "11111111-2222-4333-8444-555566667777" } });
  await settled(next);
  assert.deepEqual(next.calls(), []);
});

test("Copilot's user_exit is settled after the hook returns, by a process the agent's exit can't take down", POSIX_HARNESS, async () => {
  const exit = setup({ ...copilot, labels: copilotRec });
  exit.run(end("user_exit"), { env: { REVIVE_SETTLE_MS: "300", FAKE_PID: String(process.pid) } });
  assert.deepEqual(exit.calls(), []);
  for (let i = 0; i < 100 && !exit.calls().length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(exit.set(exit.calls())["revive.session"], "");
});

test("Copilot's completed run is forgotten; an aborted one is kept", POSIX_HARNESS, () => {
  const done = setup({ ...copilot, labels: copilotRec });
  done.run(end("complete"));
  assert.equal(done.set(done.calls())["revive.session"], "");
  for (const reason of ["abort", "error", "timeout"]) {
    const kept = setup({ ...copilot, labels: copilotRec });
    kept.run(end(reason), settle(process.pid));
    assert.deepEqual(kept.calls(), [], reason);
  }
});

test("a Copilot session is resumable once its session-state folder exists", () => {
  const home = mkdtempSync(join(tmpdir(), "revive-copilot-"));
  const before = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try {
    assert.equal(hasTranscript({ agent: "copilot", session: ID }), false);
    mkdirSync(join(home, "session-state", ID), { recursive: true });
    assert.equal(hasTranscript({ agent: "copilot", session: ID }), true);
  } finally {
    if (before === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = before;
  }
});

// Hook input captured from copilot 1.0.111 (see test/fixtures/copilot/README.md).
const fixture = (name) => JSON.parse(readFileSync(resolve("test/fixtures/copilot", `${name}.json`), "utf8"));

test("Copilot's captured hook input reads like Claude Code's; a camelCase hook's does not", () => {
  const started = hookPayload(fixture("session-start"));
  assert.equal(started.event, "SessionStart");
  assert.equal(started.session, "2e9bf9fd-76cc-4d7c-be8d-662501107f55");
  assert.equal(started.cwd, "/w");
  assert.equal(hookPayload(fixture("session-end-complete")).reason, "complete");
  const exited = hookPayload(fixture("session-end-user-exit"));
  assert.equal(exited.event, "SessionEnd");
  assert.equal(exited.reason, "user_exit");
  const camel = hookPayload(fixture("session-start-camel"));
  assert.equal(camel.event, null);
  assert.equal(camel.session, null);
});

test("Copilot's captured hook input, end to end: recorded, then forgotten or settled", POSIX_HARNESS, () => {
  const { run, calls, set } = setup(copilot);
  run(fixture("session-start"));
  assert.equal(set(calls())["revive.session"], "2e9bf9fd-76cc-4d7c-be8d-662501107f55");
  const done = setup({ ...copilot, labels: { ...copilotRec, "revive.session": "2e9bf9fd-76cc-4d7c-be8d-662501107f55" } });
  done.run(fixture("session-end-complete"));
  assert.equal(done.set(done.calls())["revive.session"], "");
  const exitRec = { ...copilotRec, "revive.session": "ad28e5ff-a952-42ca-b130-4f8eb8990801" };
  const hangup = setup({ ...copilot, labels: exitRec });
  hangup.run(fixture("session-end-user-exit"), settle(deadPid()));
  assert.deepEqual(hangup.calls(), []);
  const clear = setup({ ...copilot, labels: exitRec });
  clear.run(fixture("session-end-user-exit"), settle(process.pid));
  assert.equal(clear.set(clear.calls())["revive.session"], "");
});

test("omp's SessionStart is remembered with the command line its extension sends", POSIX_HARNESS, () => {
  // omp renames its process `omp`: the foreground shows no flags.
  const { run, calls, set } = setup({ bin: "omp", argv: ["omp"], app: "omp" });
  const transcript = `/home/me/.omp/agent/sessions/-w/2026-01-01T00-00-00-000Z_${ID}.jsonl`;
  run({ ...start, transcript_path: transcript, argv: ["omp", "--model", "opus", "-e", "/x.ts", "fix it"] });
  const got = set(calls());
  assert.equal(got["revive.agent"], "omp");
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.flags"], '["--model","opus"]');
  assert.equal(got["revive.transcript"], transcript);
});

test("check resumes into the folder's real path, and only hints at a session it can't resume by itself", POSIX_HARNESS, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "revive-check-")));
  const work = join(dir, "work");
  mkdirSync(work);
  symlinkSync(work, join(dir, "link"));
  const config = join(dir, "config");
  mkdirSync(join(config, "projects", work.replace(/[^A-Za-z0-9]/g, "-")), { recursive: true });
  writeFileSync(join(config, "projects", work.replace(/[^A-Za-z0-9]/g, "-"), `${ID}.jsonl`), "{}\n");
  const check = (labels, env = { CLAUDE_CONFIG_DIR: config }) => {
    writeFileSync(join(dir, "labels.json"), JSON.stringify(labels));
    rmSync(join(dir, "label.log"), { force: true });
    writeFileSync(join(dir, "hc"), `#!/usr/bin/env node
const fs = require("fs"); const [cmd, t, ...rest] = process.argv.slice(2);
if (cmd === "get") console.log(JSON.stringify({ address: t, state: "live", pid: 4242, labels: JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "labels.json"))}, "utf8")) }));
else if (cmd === "label") fs.appendFileSync(${JSON.stringify(join(dir, "label.log"))}, rest.join(" ") + "\\n");
`);
    chmodSync(join(dir, "hc"), 0o755);
    const out = execFileSync("node", [ENGINE, "check", "--shell", "4242"], { encoding: "utf8", env: { ...base, REVIVE_HC: join(dir, "hc"), HC_TERMINAL_ID: "t1", ...env } });
    return { out, labelled: existsSync(join(dir, "label.log")) ? readFileSync(join(dir, "label.log"), "utf8") : "" };
  };
  const rec = { "revive.agent": "claude", "revive.session": ID, "revive.shell": "1", "revive.cwd": join(dir, "link") };
  const ok = check(rec);
  assert.match(ok.out, new RegExp(`cd -- ${work.replace(/[/.]/g, "\\$&")} && REVIVE_RESUME='[^']*' claude --resume ${ID}`));
  // The shell sets the variable itself: its own folder, so the need is met.
  assert.match(check({ ...rec, "revive.needs": '["CLAUDE_CONFIG_DIR"]' }).out, /claude --resume/);
  const hinted = check({ ...rec, "revive.needs": '["CLAUDE_CONFIG_DIR"]' }, {});
  assert.doesNotMatch(hinted.out, /--resume/);
  assert.match(hinted.out, /not resuming Claude Code session .*CLAUDE_CONFIG_DIR/);
  assert.match(hinted.labelled, /revive\.failed=\d+/, "said once: the next shell stays quiet");
  const gone = check({ ...rec, "revive.cwd": join(dir, "gone") });
  assert.match(gone.out, /folder is missing or not yours/);
});

/**
 * A fake `hc` that only notes each call and the CLAUDE_CODE_* names it got.
 * A real one with no core running starts one, in the caller's environment.
 */
function callLog() {
  const dir = mkdtempSync(join(tmpdir(), "revive-core-"));
  const hc = join(dir, "hc");
  writeFileSync(hc, `#!/usr/bin/env node
const fs = require("fs");
const names = Object.keys(process.env).filter((k) => k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE");
fs.appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, JSON.stringify({ args: process.argv.slice(2), names }) + "\\n");
console.log("{}");
`);
  chmodSync(hc, 0o755);
  const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const hook = (env) => execFileSync("node", [ENGINE, "hook"], {
    input: JSON.stringify(start),
    env: { ...base, HC_TERMINAL_ID: "t1", REVIVE_HC: hc, CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1", ...env },
  });
  return { dir, calls, hook };
}

test("a hook that runs while herdr-core is down never calls hc, which would start a core", () => {
  const { dir, calls, hook } = callLog();
  hook({ HC_TERMINAL_SOCKET: join(dir, "gone.sock") });
  assert.deepEqual(calls(), []);
});

test("a hook with herdr-core up calls hc, without the agent's CLAUDE_CODE_* variables", POSIX_HARNESS, async () => {
  const { dir, calls, hook } = callLog();
  const sock = join(dir, "core.sock");
  const server = createServer((c) => c.end());
  await new Promise((ok) => server.listen(sock, ok));
  try {
    await new Promise((ok, fail) => {
      const child = execFile("node", [ENGINE, "hook"], {
        env: { ...base, HC_TERMINAL_ID: "t1", REVIVE_HC: join(dir, "hc"), HC_TERMINAL_SOCKET: sock, CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1" },
      }, (err) => (err ? fail(err) : ok()));
      child.stdin.end(JSON.stringify(start));
    });
  } finally { server.close(); }
  const got = calls();
  assert.ok(got.length > 0, "the core is up: the hook asks it");
  assert.deepEqual(got.flatMap((c) => c.names), []);
  // Without HC_TERMINAL_SOCKET (an older hc), the hook still runs as before.
  rmSync(join(dir, "calls.log"));
  const env = { ...base };
  delete env.HC_TERMINAL_SOCKET;
  execFileSync("node", [ENGINE, "hook"], { input: JSON.stringify(start), env: { ...env, HC_TERMINAL_ID: "t1", REVIVE_HC: join(dir, "hc") } });
  assert.ok(calls().length > 0);
});

/**
 * A terminal whose program is a wrapper (Kiro CLI's pty wrapper, `script`)
 * that runs the shell as its child: `check` runs in that shell, and the fake
 * hc reports the wrapper's pid as the terminal's.
 */
function wrapped({ marked = false, operation = "check" } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "revive-wrap-")));
  writeFileSync(join(dir, "hc"), `#!/usr/bin/env node
const [cmd, t] = process.argv.slice(2);
if (cmd === "get") console.log(JSON.stringify({ address: t, state: "live", pid: Number(process.env.WRAP),
  status: { app: "codex" }, foreground: { pid: Number(process.env.WRAPPED_SHELL), argv: ["sh"] },
  labels: { "revive.agent": "codex", "revive.session": ${JSON.stringify(ID)}, "revive.shell": "1", "revive.cwd": ${JSON.stringify(dir)} } }));
if (cmd === "send") require("node:fs").writeFileSync(${JSON.stringify(join(dir, "sent"))}, process.argv[4]);
`);
  chmodSync(join(dir, "hc"), 0o755);
  // The wrapper, then the shell it starts. `marked`: the wrapper is itself a
  // shell that ran Revive's block, and the inner one was started by hand.
  writeFileSync(join(dir, "wrap"), `#!/bin/sh
WRAP=$$; export WRAP
${marked ? "REVIVE_SHELL=$$; export REVIVE_SHELL" : "unset REVIVE_SHELL"}
sh -c 'WRAPPED_SHELL=$$; export WRAPPED_SHELL; node ${ENGINE} ${operation === "check" ? "check --shell $$" : "resume t1"}; true'
`);
  chmodSync(join(dir, "wrap"), 0o755);
  const out = execFileSync(join(dir, "wrap"), [], { encoding: "utf8", env: { ...base, REVIVE_HC: join(dir, "hc"), HC_TERMINAL_ID: "t1", REVIVE_DEBUG: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  return operation === "resume" && existsSync(join(dir, "sent")) ? readFileSync(join(dir, "sent"), "utf8") : out;
}

test("a shell a wrapper runs as its child is the terminal's own, and resumes", POSIX_HARNESS, () => {
  assert.match(wrapped(), new RegExp(`codex resume ${ID}`));
});

test("manual Resume accepts a wrapper's idle child shell, including a stale agent report", POSIX_HARNESS, () => {
  assert.match(wrapped({ operation: "resume" }), new RegExp(`codex resume ${ID}`));
});

test("a shell started by hand inside the terminal's own shell doesn't resume", POSIX_HARNESS, () => {
  assert.equal(wrapped({ marked: true }), "");
});

// ── Muse ────────────────────────────────────────────────────────────────────

// Muse's hooks run without HC_TERMINAL_ID: the one installed for Muse finds
// its terminal from the process tree.
const MUSE_ID = "01a1f4d6-1e4d-7322-9f7b-c29ea7491e16";
const museFixture = (name) => JSON.parse(readFileSync(resolve("test/fixtures/muse", `${name}.json`), "utf8"));
const muse = { bin: "muse-bin-1.4.24-R9131.1", argv: ["/Users/me/.local/bin/muse-bin-1.4.24-R9131.1", "--model", "m1", "--approval-mode", "never", "--workspace", "/x", "fix it"], hookArgs: "--agent muse" };
const museRec = { ...remembered, "revive.agent": "muse", "revive.session": MUSE_ID };
// Muse's hooks get no HC_TERMINAL_SOCKET either: the hook checks the default
// core's socket, here one that answers (a Unix socket accepts a connection
// into its backlog while this process waits in execFileSync).
const museCoreDir = mkdtempSync(join(tmpdir(), "revive-muse-core-"));
const museCore = join(museCoreDir, "core.sock");
// Only where the Muse tests run (POSIX_HARNESS): Windows refuses a Unix socket in its temp folder.
if (!WINDOWS) {
  const museCoreServer = createServer((c) => c.end());
  await new Promise((ok) => museCoreServer.listen(museCore, ok));
  museCoreServer.unref();
}
const noTerminalId = (env = {}) => ({ env: { HC_TERMINAL_ID: "", HC_TERMINAL_SOCKET: "", REVIVE_HC_SOCKET: museCore, ...env } });

test("Muse's SessionStart is remembered on the terminal whose foreground runs it, without HC_TERMINAL_ID", POSIX_HARNESS, () => {
  const { run, calls, set } = setup(muse);
  run(museFixture("session-start"), noTerminalId());
  const got = set(calls());
  assert.equal(calls()[0][0], "revive.agent=muse");
  assert.equal(got["revive.agent"], "muse");
  assert.equal(got["revive.session"], MUSE_ID);
  assert.equal(got["revive.cwd"], "/w");
  assert.equal(got["revive.flags"], '["--model","m1","--approval-mode","never"]');
});

test("Muse's resume SessionStart keeps the record and its resumed mark", POSIX_HARNESS, () => {
  const { run, calls, set } = setup({ ...muse, argv: ["/Users/me/.local/bin/muse-bin-1.4.24-R9131.1", "resume", MUSE_ID], labels: { ...museRec, "revive.resumed": "123" } });
  run(museFixture("session-start-resume"), noTerminalId());
  const got = set(calls());
  assert.equal(got["revive.session"], MUSE_ID);
  assert.equal(got["revive.resumed"], "123");
});

test("only the hook installed for Muse looks for its terminal; any other still needs HC_TERMINAL_ID", POSIX_HARNESS, () => {
  const other = setup({ ...muse, hookArgs: "" });
  other.run(museFixture("session-start"), noTerminalId());
  assert.deepEqual(other.calls(), []);
  const claude = setup({ hookArgs: "--agent claude" });
  claude.run(start, noTerminalId());
  assert.deepEqual(claude.calls(), []);
});

test("Muse's hook never calls hc while the default core is down, which would start one", POSIX_HARNESS, () => {
  const { run, calls } = setup({ ...muse, labels: museRec });
  run(museFixture("session-start"), noTerminalId({ REVIVE_HC_SOCKET: join(museCoreDir, "gone.sock") }));
  run(museFixture("session-end-exit"), noTerminalId({ REVIVE_HC_SOCKET: join(museCoreDir, "gone.sock"), ...settle(process.pid).env }));
  assert.deepEqual(calls(), []);
});

test("Muse's hook is recorded on the nearest terminal above it, not one listed first whose shell is further up", POSIX_HARNESS, () => {
  const { run, calls, set, state, targets } = setup(muse);
  // t0's shell is this test process, an ancestor of every hook the test runs
  // (as a terminal is of a core started by hand inside it).
  state({ extra: { t0: { pid: process.pid, foreground: { pid: process.pid, argv: ["node"] } } } });
  run(museFixture("session-start"), noTerminalId());
  assert.equal(set(calls())["revive.session"], MUSE_ID);
  assert.deepEqual([...new Set(targets())], ["t1"]);
});

test("Muse's hook records nothing when no terminal runs it in its foreground", POSIX_HARNESS, () => {
  const { run, calls, state } = setup(muse);
  state({ fg: deadPid() });
  run(museFixture("session-start"), noTerminalId());
  assert.deepEqual(calls(), []);
});

test("Muse's /exit (other) forgets the session once its shell outlives it; a hangup keeps it", POSIX_HARNESS, () => {
  const exit = setup({ ...muse, labels: museRec });
  exit.state({ fg: deadPid() });
  exit.run(museFixture("session-end-exit"), noTerminalId(settle(process.pid).env));
  assert.deepEqual(exit.calls(), [], "no foreground agent: the hook can't tell whose it is");
  const kept = setup({ ...muse, labels: museRec });
  kept.run(museFixture("session-end-exit"), noTerminalId(settle(deadPid()).env));
  assert.deepEqual(kept.calls(), [], "the shell died with it: a reboot or a core restart");
  const cleared = setup({ ...muse, labels: museRec });
  cleared.run(museFixture("session-end-exit"), noTerminalId(settle(process.pid).env));
  assert.equal(cleared.set(cleared.calls())["revive.session"], "", "the same Muse still there: the person ended this session");
});

test("Muse's captured hook input reads like Claude Code's", () => {
  const started = hookPayload(museFixture("session-start"));
  assert.equal(started.event, "SessionStart");
  assert.equal(started.session, MUSE_ID);
  assert.equal(started.cwd, "/w");
  assert.equal(started.agent, null);
  const ended = hookPayload(museFixture("session-end-exit"));
  assert.equal(ended.event, "SessionEnd");
  assert.equal(ended.reason, "other");
});

test("a Muse that a tool call runs below the foreground Muse doesn't own the terminal", () => {
  const bin = "/Users/me/.local/bin/muse-bin-1.4.24-R9131.1";
  const table = new Map([
    [10, { ppid: 9, argv: ["node", "/x/revive.mjs", "hook", "--agent", "muse"] }],
    [9, { ppid: 8, argv: [bin, "exec", "x"] }],
    [8, { ppid: 7, argv: ["sh", "-c", "muse exec x"] }],
    [7, { ppid: 6, argv: [bin, "fix it"] }],
    [6, { ppid: 1, argv: ["-zsh"] }],
  ]);
  assert.equal(hookOwner(table, 9, 7).owned, false);
  assert.deepEqual(hookOwner(table, 7, 7), { owned: true, agent: 7 });
});

// ── Antigravity CLI (agy) ───────────────────────────────────────────────────

test("agy hook prints {} on stdout even outside a Herdr terminal", () => {
  const out = execFileSync(process.execPath, [ENGINE, "hook", "--agent", "agy"], {
    input: JSON.stringify({ hookEventName: "SessionStart", conversationId: ID }),
    encoding: "utf8",
    env: { ...base, HC_TERMINAL_ID: "" },
  });
  assert.equal(out, "{}\n");
});

const agyStart = {
  hookEventName: "SessionStart",
  conversationId: ID,
  workspacePaths: ["/w"],
  transcriptPath: `/Users/me/.gemini/antigravity-cli/brain/${ID}/.system_generated/logs/transcript.jsonl`,
};
const agyStop = { ...agyStart, hookEventName: "Stop" };

test("agy SessionStart records camelCase payload with workspacePaths fallback and prints {}", POSIX_HARNESS, () => {
  const agy = setup({ bin: "agy", argv: ["agy", "--model", "gemini-4", "--dangerously-skip-permissions"], app: "antigravity", hookArgs: "--agent agy" });
  const stdout = agy.run(agyStart).toString("utf8");
  assert.equal(stdout, "{}\n");
  const got = agy.set(agy.calls());
  assert.equal(got["revive.agent"], "agy");
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.cwd"], "/w");
  assert.equal(got["revive.flags"], '["--model","gemini-4","--dangerously-skip-permissions"]');
});

test("agy Stop records an unrecorded session and returns early once recorded without scanning processes", POSIX_HARNESS, () => {
  const unrecorded = setup({ bin: "agy", argv: ["agy", "--model", "gemini-4"], app: "antigravity", hookArgs: "--agent agy" });
  assert.equal(unrecorded.run(agyStop, { env: { XDG_STATE_HOME: unrecorded.dir } }).toString("utf8"), "{}\n");
  assert.equal(unrecorded.set(unrecorded.calls())["revive.session"], ID);

  // Even when fg no longer owns the hook, Stop returns immediately after reading labels (no hookOwner/processes debug output).
  const already = setup({
    bin: "agy",
    argv: ["agy", "--model", "gemini-4"],
    app: "antigravity",
    hookArgs: "--agent agy",
    labels: { ...remembered, "revive.agent": "agy", "revive.session": ID },
  });
  already.state({ fg: deadPid() });
  const stopped = spawnSync(join(already.dir, "outer", "agy"), [], {
    input: JSON.stringify(agyStop),
    encoding: "utf8",
    env: { ...base, HC_TERMINAL_ID: "t1", REVIVE_HC: join(already.dir, "hc"), FAKE_FG: "", REVIVE_DEBUG: "1" },
  });
  assert.equal(stopped.status, 0);
  assert.equal(stopped.stdout, "{}\n");
  assert.equal(stopped.stderr, "");
  assert.deepEqual(already.calls(), []);
});

test("agy -p leaves any remembered session alone and still prints {}", POSIX_HARNESS, () => {
  const oneShot = setup({
    bin: "agy",
    argv: ["agy", "-p", "hi"],
    app: "antigravity",
    hookArgs: "--agent agy",
    labels: { ...remembered, "revive.agent": "agy", "revive.session": ID },
  });
  assert.equal(oneShot.run({ ...agyStart, conversationId: "11111111-2222-4333-8444-555566667777" }).toString("utf8"), "{}\n");
  assert.deepEqual(oneShot.calls(), []);
});

test("agy detached watcher settles when agy exits and its shell survives, and keeps on hangup", POSIX_HARNESS, async () => {
  const agyRec = { ...remembered, "revive.agent": "agy", "revive.session": ID };
  const agyOpts = { bin: "agy", argv: ["agy"], app: "antigravity", hookArgs: "--agent agy", labels: agyRec };
  // Once outer's hook finishes, FAKE_FG (outer's pid) has exited, so watch sees it dead and settles via outlived.
  const exited = setup(agyOpts);
  exited.run(agyStart, { env: { REVIVE_WATCH_MS: "50", REVIVE_SETTLE_MS: "150", FAKE_PID: String(process.pid), XDG_STATE_HOME: exited.dir } });
  const initialCalls = exited.calls().length;
  for (let i = 0; i < 60 && exited.calls().length <= initialCalls; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(exited.calls().length > initialCalls, "watcher clears the session after agy exits");
  assert.equal(exited.set([exited.calls().at(-1)])["revive.session"], "");

  // When the terminal's shell died too (reboot / core restart), watch runs settle (hc get) and keeps the record.
  const reboot = setup(agyOpts);
  reboot.run(agyStart, { env: { REVIVE_WATCH_MS: "50", REVIVE_SETTLE_MS: "100", FAKE_PID: String(deadPid()), XDG_STATE_HOME: reboot.dir } });
  const afterHookGets = reboot.gets().length;
  const rebootCalls = reboot.calls().length;
  const watchDir = join(reboot.dir, "herdr-revive", "watch");
  const stampGone = () => !existsSync(watchDir) || readdirSync(watchDir).length === 0;
  for (let i = 0; i < 60 && (reboot.gets().length <= afterHookGets || !stampGone()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(reboot.gets().length > afterHookGets, "watcher ran outlived check before asserting");
  assert.ok(stampGone(), "watcher exited after settle");
  assert.equal(reboot.calls().length, rebootCalls, "hangup leaves the remembered session intact");
});

test("agy reuses the watcher for the same session and supersedes it when switching conversations", POSIX_HARNESS, async () => {
  const dir = mkdtempSync(join(tmpdir(), "revive-agy-dedup-"));
  const S2 = "11111111-2222-4333-8444-555566667777";
  const hc = join(dir, "hc");
  writeFileSync(join(dir, "state.json"), JSON.stringify({ labels: {} }));
  writeFileSync(hc, `#!/usr/bin/env node
const fs = require("fs"), dir = ${JSON.stringify(dir)};
const [cmd, t, ...rest] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
if (cmd === "get") {
  console.log(JSON.stringify({ address: t, state: "live", pid: ${process.pid}, cwd: "/w", labels: state.labels,
    status: { app: "antigravity", state: "working" },
    foreground: { pid: Number(process.env.AGY_PID), argv: ["agy"], cwd: "/w" } }));
} else if (cmd === "label") {
  const patch = Object.fromEntries(rest.map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  state.labels = { ...state.labels, ...patch };
  fs.writeFileSync(dir + "/state.json", JSON.stringify(state));
}
`);
  chmodSync(hc, 0o755);
  const agyScript = join(dir, "agy");
  writeFileSync(agyScript, `#!/bin/sh
export AGY_PID=$$
node ${JSON.stringify(ENGINE)} hook --agent agy <<EOF
${JSON.stringify(agyStart)}
EOF
while [ ! -f ${JSON.stringify(join(dir, "step2"))} ]; do sleep 0.05; done
node ${JSON.stringify(ENGINE)} hook --agent agy <<EOF
${JSON.stringify(agyStart)}
EOF
touch ${JSON.stringify(join(dir, "step2.done"))}
while [ ! -f ${JSON.stringify(join(dir, "step3"))} ]; do sleep 0.05; done
node ${JSON.stringify(ENGINE)} hook --agent agy <<EOF
${JSON.stringify({ ...agyStart, conversationId: S2 })}
EOF
touch ${JSON.stringify(join(dir, "step3.done"))}
while [ ! -f ${JSON.stringify(join(dir, "exit"))} ]; do sleep 0.05; done
`);
  chmodSync(agyScript, 0o755);
  const child = execFile(agyScript, [], { env: { ...base, HC_TERMINAL_ID: "t1", REVIVE_HC: hc, REVIVE_WATCH_MS: "50", REVIVE_SETTLE_MS: "50", XDG_STATE_HOME: dir } });
  const watchDir = join(dir, "herdr-revive", "watch");
  const alivePid = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  try {
    let stampFile = null;
    for (let i = 0; i < 60 && !stampFile; i++) {
      const entries = existsSync(watchDir) ? readdirSync(watchDir) : [];
      if (entries.length) stampFile = join(watchDir, entries[0]);
      else await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(stampFile, "watcher wrote its state file");
    const [pid1, ses1] = readFileSync(stampFile, "utf8").trim().split("\n");
    assert.equal(ses1, ID);
    writeFileSync(join(dir, "step2"), "");
    for (let i = 0; i < 60 && !existsSync(join(dir, "step2.done")); i++) await new Promise((r) => setTimeout(r, 50));
    const [pidAfterSame] = readFileSync(stampFile, "utf8").trim().split("\n");
    assert.equal(pidAfterSame, pid1, "same session reuses the existing watcher");
    writeFileSync(join(dir, "step3"), "");
    for (let i = 0; i < 60 && !existsSync(join(dir, "step3.done")); i++) await new Promise((r) => setTimeout(r, 50));
    let pid2 = pid1;
    for (let i = 0; i < 60 && pid2 === pid1; i++) {
      pid2 = readFileSync(stampFile, "utf8").trim().split("\n")[0];
      if (pid2 === pid1) await new Promise((r) => setTimeout(r, 50));
    }
    assert.notEqual(pid2, pid1, "new conversation starts a replacement watcher");
    for (let i = 0; i < 40 && alivePid(Number(pid1)); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alivePid(Number(pid1)), false, "superseded watcher exits cleanly");
    writeFileSync(join(dir, "exit"), "");
    await new Promise((r) => child.once("close", r));
    for (let i = 0; i < 60 && (existsSync(stampFile) || JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).labels["revive.session"] !== ""); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).labels["revive.session"], "", "active watcher settles new session on exit");
  } finally {
    child.kill();
  }
});
