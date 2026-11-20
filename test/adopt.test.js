// `revive.mjs adopt`: the record a running agent's SessionStart would have
// written, for one started before Revive was installed. A fake `hc` serves the
// terminals from terminals.json and applies the labels it is given; the
// agents' files are in a temporary home. Never the real `hc`: REVIVE_HC is
// always the fake, so no live terminal is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRecord, resumeLine } from "../mods/revive/lib/core.js";
import { POSIX_HARNESS, WINDOWS } from "./helpers/platform.js";

const ENGINE = resolve("mods/revive/revive.mjs");
const A = "0c8b28eb-1111-4222-8333-444455556666";
const B = "1d9c39fc-2222-4333-8444-555566667777";
const C = "2eadf00d-3333-4444-8555-666677778888";
const D = "3fbe1111-4444-4555-8666-777788889999";
const dashed = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const re = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The terminals' program: a real process, so `ps` gives its start time.
const SHELL = process.pid;
const since = WINDOWS ? "" : execFileSync("ps", ["-o", "lstart=", "-p", String(SHELL)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim().split(/\s+/).join(" ");

const base = { ...process.env };
// Install must not reach a real muse on the test machine: an empty REVIVE_MUSE means no Muse.
base.REVIVE_MUSE = "";
for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "REVIVE_SHELL", "ZDOTDIR"]) delete base[k];

/** A temporary home, a fake hc and helpers to add terminals and agent files. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "revive-adopt-")));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  const terminals = [];
  const state = join(root, "terminals.json");
  const log = join(root, "labels.log");
  const hc = join(root, "hc");
  writeFileSync(hc, `#!/usr/bin/env node
const fs = require("fs");
const [cmd, t, ...rest] = process.argv.slice(2);
const all = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const one = all.find((x) => x.address === t);
if (cmd === "ls") console.log(JSON.stringify({ terminals: all.map((x) => ({ address: x.address })) }));
else if (cmd === "get") { if (!one) process.exit(1); console.log(JSON.stringify(one)); }
else if (cmd === "label") {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([t, ...rest]) + "\\n");
  for (const kv of rest) { const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) one.labels[k] = v; else delete one.labels[k]; }
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(all));
}
`);
  chmodSync(hc, 0o755);
  const folder = (name, mode = 0o700) => {
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
    chmodSync(p, mode);
    return p;
  };
  let pid = 50_000;
  /** A live terminal whose foreground runs `argv` in `cwd`, with Claude Code's sessions/<pid>.json saying `session`. */
  const terminal = ({ address = `t${terminals.length + 1}`, argv, cwd, session = null, labels = {}, where = null }) => {
    const fg = ++pid;
    if (session) writeFileSync(join(home, ".claude", "sessions", `${fg}.json`), JSON.stringify({ pid: fg, sessionId: session, cwd }));
    terminals.push({ address, state: "live", pid: SHELL, cwd, labels: { ...(where ? { where } : {}), ...labels }, foreground: { pid: fg, argv, cwd } });
    writeFileSync(state, JSON.stringify(terminals));
    return address;
  };
  /** A Claude Code transcript filed under `project`'s folder, its lines naming `cwd`. */
  const transcript = (id, project, cwd = project) => {
    const dir = join(home, ".claude", "projects", dashed(project));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), [{ type: "mode", sessionId: id }, { type: "attachment", cwd }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  const env = (extra = {}) => ({ ...base, HOME: home, USERPROFILE: home, REVIVE_HC: hc, ...extra });
  const run = (args, extra = {}) => spawnSync("node", [ENGINE, ...args], { encoding: "utf8", env: env(extra) });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const labelsOf = (t) => JSON.parse(readFileSync(state, "utf8")).find((x) => x.address === t).labels;
  return { root, home, hc, folder, terminal, transcript, run, calls, labelsOf, env };
}

test("adopt writes the labels the hook would have, for each running agent nobody recorded", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  const t = w.terminal({ argv: ["claude", "--model", "opus", "--settings", "/s.json", "--dangerously-skip-permissions", "fix it"], cwd: work, session: A, where: "api / main" });
  w.transcript(A, work);
  const before = Date.now();
  const r = w.run(["adopt"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Remembered 1 running session:\n {2}t1 \(api \/ main\) {2}Claude Code 0c8b28eb {2}\S+work\n$/);
  const labels = w.labelsOf(t);
  assert.equal(labels["revive.agent"], "claude");
  assert.equal(labels["revive.session"], A);
  assert.equal(labels["revive.cwd"], work);
  // Through the carry list: --settings is left behind, as by the hook.
  assert.equal(labels["revive.flags"], '["--model","opus","--dangerously-skip-permissions"]');
  assert.equal(labels["revive.shell"], String(SHELL));
  assert.equal(labels["revive.since"], since);
  assert.ok(Number(labels["revive.at"]) >= before);
  for (const k of ["needs", "transcript", "env", "resumed", "failed"]) assert.equal(labels[`revive.${k}`], undefined, k);
  assert.equal(labels.where, "api / main", "other labels stay");
  // Read back, it is a record like any other, resumed in its folder.
  const rec = readRecord(labels);
  assert.match(resumeLine(rec, { unattended: true }), new RegExp(`^cd -- ${re(work)} && REVIVE_RESUME=\\S+ claude --model opus --resume ${A}$`));
  // Running it again finds nothing more to do.
  assert.equal(w.run(["adopt"]).stdout, "No running session to remember.\n");
  assert.equal(w.calls().length, 1);
});

test("adopt skips recorded terminals, one-shot runs, unknown sessions and other machines", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  w.transcript(A, work);
  w.transcript(B, work);
  const recorded = { "revive.agent": "claude", "revive.session": C, "revive.shell": "1" };
  w.terminal({ argv: ["claude"], cwd: work, session: A, labels: recorded });
  w.terminal({ argv: ["claude", "-p", "summarize"], cwd: work, session: B });
  w.terminal({ argv: ["claude"], cwd: work, session: "bad id; rm -rf ~" });
  w.terminal({ argv: ["claude"], cwd: work });
  w.terminal({ argv: ["codex", "--yolo"], cwd: work });
  w.terminal({ argv: ["/bin/zsh", "-l"], cwd: work });
  w.terminal({ address: "box/t1", argv: ["claude"], cwd: work, session: A });
  const r = w.run(["adopt"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls(), [], "nothing written");
  assert.equal(r.stdout, [
    "No running session to remember.",
    "Not remembered:",
    "  t2  Claude Code: a one-shot run, with no session to bring back",
    "  t3  Claude Code: Revive can't find its session from its files",
    "  t4  Claude Code: Revive can't find its session from its files",
    "  t5  Codex: only a running Claude Code session can be remembered; start it again to record it",
    "",
  ].join("\n"), "a recorded terminal, a shell and another machine's terminal say nothing");
});

test("adopt uses the folder the transcript says the agent started in when it moved", POSIX_HARNESS, () => {
  const w = world();
  const start = w.folder("app");
  const now = w.folder("app/packages/api");
  // sessions/<pid>.json and the terminal say where the agent is now; the
  // transcript is filed under the folder it started in, which --resume needs.
  const t = w.terminal({ argv: ["claude"], cwd: now, session: A });
  w.transcript(A, start);
  assert.equal(w.run(["adopt"]).status, 0);
  assert.equal(w.labelsOf(t)["revive.cwd"], start);
});

test("adopt reads the folder from the transcript, not from the name it is filed under", POSIX_HARNESS, () => {
  const w = world();
  // Both are filed under the same name: …-a-my-proj.
  const start = w.folder("a/my-proj");
  const now = w.folder("a/my/proj");
  assert.equal(dashed(start), dashed(now));
  const t = w.terminal({ argv: ["claude"], cwd: now, session: A });
  w.transcript(A, start);
  assert.equal(w.run(["adopt"]).status, 0);
  assert.equal(w.labelsOf(t)["revive.cwd"], start);
});

test("adopt skips a session with no transcript, one that doesn't say its folder, and one whose folder fails the check", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  const open = w.folder("open", 0o777);
  // No message yet: no transcript.
  w.terminal({ argv: ["claude"], cwd: work, session: A });
  // Filed under a folder its first cwd doesn't name, and one with no cwd at all.
  const dir = join(w.home, ".claude", "projects", "-elsewhere");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${B}.jsonl`), `${JSON.stringify({ cwd: "/somewhere/else" })}\n${JSON.stringify({ cwd: "/elsewhere" })}\n`);
  w.terminal({ argv: ["claude"], cwd: work, session: B });
  writeFileSync(join(dir, `${D}.jsonl`), `${JSON.stringify({ type: "mode", sessionId: D })}\n`);
  w.terminal({ argv: ["claude"], cwd: work, session: D });
  // A folder anyone can write to, as resume refuses it.
  w.transcript(C, open);
  w.terminal({ argv: ["claude"], cwd: open, session: C });
  const r = w.run(["adopt"]);
  assert.deepEqual(w.calls(), []);
  assert.match(r.stdout, /t1 {2}Claude Code: it has no message yet, so there is nothing to resume/);
  assert.match(r.stdout, /t2 {2}Claude Code: its transcript doesn't say which folder it started in/);
  assert.match(r.stdout, /t3 {2}Claude Code: its transcript doesn't say which folder it started in/);
  assert.match(r.stdout, /t4 {2}Claude Code: its folder \S+open is missing, not yours, or writable by others/);
});

test("one session is adopted into one terminal only", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  w.transcript(A, work);
  w.transcript(B, work);
  w.terminal({ argv: ["claude"], cwd: work, session: A, labels: { "revive.agent": "claude", "revive.session": A } });
  w.terminal({ argv: ["claude"], cwd: work, session: A });
  w.terminal({ argv: ["claude"], cwd: work, session: B });
  w.terminal({ argv: ["claude"], cwd: work, session: B });
  const r = w.run(["adopt"]);
  assert.deepEqual(w.calls(), []);
  assert.match(r.stdout, /t2 {2}Claude Code: its session is already remembered in another terminal/);
  assert.match(r.stdout, /t3 {2}Claude Code: another terminal holds the same session/);
  assert.match(r.stdout, /t4 {2}Claude Code: another terminal holds the same session/);
});

test("adopt leaves Droid alone even when the dialog finds its session", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  const store = join(w.home, ".factory", "sessions", dashed(work));
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${D}.jsonl`), "{}\n");
  const t = w.terminal({ argv: ["droid", "--auto", "high", "fix it"], cwd: work });
  // The newest file in its folder's store: shown, never recorded.
  const list = JSON.parse(execFileSync("node", [ENGINE, "list"], { encoding: "utf8", env: w.env() })).entries[0];
  assert.equal(list.rec.session, D);
  const r = w.run(["adopt"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls(), []);
  assert.equal(w.labelsOf(t)["revive.session"], undefined);
  assert.match(r.stdout, /t1 {2}Droid: only a running Claude Code session can be remembered/);
});

test("a session found under this process's CLAUDE_CONFIG_DIR records that it needs it, by name", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  const config = join(w.home, ".claude");
  const t = w.terminal({ argv: ["claude"], cwd: work, session: A });
  w.transcript(A, work);
  assert.equal(w.run(["adopt"], { CLAUDE_CONFIG_DIR: config }).status, 0);
  assert.equal(w.labelsOf(t)["revive.needs"], '["CLAUDE_CONFIG_DIR"]');
});

test("--dry-run prints the labels it would write and writes none", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  w.terminal({ argv: ["claude", "--model", "opus"], cwd: work, session: A });
  w.transcript(A, work);
  const r = w.run(["adopt", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls(), []);
  assert.match(r.stdout, /^Would remember 1 running session:\n {2}t1 {2}Claude Code 0c8b28eb/);
  assert.match(r.stdout, new RegExp(`label t1 revive\\.agent=claude revive\\.session=${A} revive\\.cwd=\\S+work 'revive\\.flags=\\["--model","opus"\\]'`));
  assert.match(r.stdout, new RegExp(`revive\\.shell=${SHELL} 'revive\\.since=${since}' revive\\.at=\\d+`));
});

test("adopt T adopts that terminal only, and says why when it won't", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  w.transcript(A, work);
  w.transcript(B, work);
  w.terminal({ argv: ["claude"], cwd: work, session: A });
  w.terminal({ argv: ["claude"], cwd: work, session: B });
  w.terminal({ argv: ["claude", "-p", "x"], cwd: work, session: C });
  w.terminal({ argv: ["zsh"], cwd: work });
  const r = w.run(["adopt", "t2"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c[0]), ["t2"]);
  const fail = (t) => { const x = w.run(["adopt", t]); assert.equal(x.status, 1); return x.stderr.trim(); };
  assert.equal(fail("t2"), "t2 already has a remembered session.");
  assert.equal(fail("t3"), "Won't remember Claude Code in t3: a one-shot run, with no session to bring back.");
  assert.equal(fail("t4"), "No agent session in t4.");
  assert.equal(fail("t9"), "t9 is not a live terminal on this computer.");
  assert.deepEqual(w.calls().map((c) => c[0]), ["t2"]);
});

test("the dialog's list gives a moved session the folder it started in, for Fork", POSIX_HARNESS, () => {
  const w = world();
  const start = w.folder("app");
  const now = w.folder("app/packages/api");
  w.terminal({ argv: ["claude"], cwd: now, session: A });
  w.transcript(A, start);
  const entry = JSON.parse(execFileSync("node", [ENGINE, "list", "--focus", "t1"], { encoding: "utf8", env: w.env() })).entries[0];
  assert.equal(entry.unrecorded, true);
  assert.equal(entry.rec.cwd, start);
});

test("the dialog's list says which sessions nobody recorded Remember can record", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  w.transcript(A, work);
  w.terminal({ argv: ["claude"], cwd: work, session: A });
  w.terminal({ argv: ["claude"], cwd: work, session: B });
  const store = join(w.home, ".factory", "sessions", dashed(work));
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${D}.jsonl`), "{}\n");
  w.terminal({ argv: ["droid"], cwd: work });
  const [ready, empty, droid] = JSON.parse(execFileSync("node", [ENGINE, "list"], { encoding: "utf8", env: w.env() })).entries;
  assert.equal(ready.rememberable, true);
  assert.equal(ready.rememberWhy, undefined);
  assert.equal(empty.rememberable, false);
  assert.equal(empty.rememberWhy, "it has no message yet, so there is nothing to resume");
  assert.equal(droid.unrecorded, true);
  assert.equal(droid.rememberable, undefined, "only Claude Code's");
});

test("the dialog's list shows an adopted session as remembered", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  w.terminal({ argv: ["claude", "--model", "opus"], cwd: work, session: A });
  w.transcript(A, work);
  const list = () => JSON.parse(execFileSync("node", [ENGINE, "list", "--focus", "t1"], { encoding: "utf8", env: w.env() })).entries[0];
  assert.equal(list().unrecorded, true);
  w.run(["adopt", "t1"]);
  const entry = list();
  assert.equal(entry.unrecorded, undefined);
  assert.equal(entry.state, "running");
  assert.deepEqual(entry.rec.flags, ["--model", "opus"]);
  assert.equal(entry.rec.auto, true);
});

// ── install and doctor ──────────────────────────────────────────────────────

test("install says how many running sessions aren't remembered, and remembers none", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  w.transcript(A, work);
  w.transcript(B, work);
  w.terminal({ argv: ["claude", "--model", "opus"], cwd: work, session: A });
  w.terminal({ argv: ["claude"], cwd: work, session: B });
  w.terminal({ argv: ["claude"], cwd: work, session: C, labels: { "revive.agent": "claude", "revive.session": C } });
  w.terminal({ argv: ["codex"], cwd: work });
  const note = "2 running Claude Code sessions aren't remembered yet: revive.mjs adopt --dry-run lists them, and revive.mjs adopt remembers them.\n";
  const r = w.run(["install", "--no-shell"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Updated:\n {2}\S+settings\.json\n/, "the hooks first");
  assert.ok(r.stdout.endsWith(note), r.stdout);
  assert.deepEqual(w.calls(), [], "nothing written to any terminal");
  // Again: nothing to change, and the same count.
  assert.equal(w.run(["install", "--no-shell"]).stdout, `Nothing to change.\n${note}`);
  w.run(["adopt", "t1"]);
  assert.match(w.run(["install", "--no-shell"]).stdout, /^Nothing to change\.\n1 running Claude Code session isn't remembered yet: revive\.mjs adopt --dry-run lists it, and revive\.mjs adopt remembers it\.\n$/);
  w.run(["adopt"]);
  assert.equal(w.run(["install", "--no-shell"]).stdout, "Nothing to change.\n", "nothing left to say");
  assert.doesNotMatch(w.run(["uninstall", "--no-shell"]).stdout, /remember/);
});

test("doctor says how many running sessions aren't remembered", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  w.transcript(A, work);
  w.terminal({ argv: ["claude"], cwd: work, session: A });
  const doctor = (extra) => JSON.parse(w.run(["doctor"], extra).stdout);
  assert.equal(doctor().unremembered, 1);
  assert.equal(doctor({ REVIVE_HC: join(w.root, "no-such-hc") }).unremembered, null, "no hc: unknown");
  assert.deepEqual(w.calls(), []);
});

test("install doesn't ask hc while the terminal's core is down, and installs without hc", POSIX_HARNESS, () => {
  const w = world();
  const work = w.folder("work");
  w.transcript(A, work);
  w.terminal({ argv: ["claude"], cwd: work, session: A });
  // An hc that finds no core starts one: with the socket gone, it isn't asked.
  const log = join(w.root, "asked");
  const spy = join(w.root, "spy-hc");
  writeFileSync(spy, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(w.hc)} "$@"\n`);
  chmodSync(spy, 0o755);
  const down = w.run(["install", "--no-shell"], { REVIVE_HC: spy, HC_TERMINAL_SOCKET: join(w.root, "gone.sock") });
  assert.equal(down.status, 0, down.stderr);
  assert.equal(down.stderr, "");
  assert.doesNotMatch(down.stdout, /remember/);
  assert.equal(existsSync(log), false, "hc never asked");
  assert.equal(JSON.parse(w.run(["doctor"], { REVIVE_HC: spy, HC_TERMINAL_SOCKET: join(w.root, "gone.sock") }).stdout).unremembered, null);
  assert.equal(existsSync(log), false, "nor by doctor");
  const none = w.run(["install", "--no-shell"], { REVIVE_HC: join(w.root, "no-such-hc") });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /Nothing to change/);
  assert.equal(none.stderr, `Couldn't count the running sessions Revive doesn't remember: ${join(w.root, "no-such-hc")} isn't on PATH. revive.mjs adopt --dry-run lists them.\n`);
});
