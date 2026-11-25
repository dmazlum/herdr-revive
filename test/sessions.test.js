// Finding a running agent's session from the files it writes, for a session
// started before Revive's hooks were installed. Fake stores in a temp home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDirs, claudeProject, claudeStartFolder, findSession, sessionDir } from "../mods/revive/lib/sessions.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const CWD = "/Users/me/code/my.app";
const T0 = Date.parse("2026-10-31T10:00:00Z");
const at = (path, ms) => utimesSync(path, ms / 1000, ms / 1000);

const home = () => mkdtempSync(join(tmpdir(), "revive-sessions-"));

test("store folders follow HOME and the agents' own variables", () => {
  const dirs = agentDirs({ HOME: "/h" });
  assert.equal(dirs.claude, join("/h", ".claude"));
  assert.equal(dirs.factory, join("/h", ".factory"));
  assert.equal(dirs.cursor, join("/h", ".cursor"));
  assert.equal(agentDirs({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" }).claude, "/c");
});

test("each agent's per-folder store is named after the folder", () => {
  const dirs = agentDirs({ HOME: "/h" });
  assert.equal(sessionDir("droid", dirs, CWD), join("/h", ".factory", "sessions", "-Users-me-code-my-app"));
  assert.equal(sessionDir("cursor", dirs, CWD), join("/h", ".cursor", "chats", createHash("md5").update(CWD).digest("hex")));
  assert.equal(sessionDir("codex", dirs, CWD), null);
});

test("Claude Code's session is read from its pid file", () => {
  const h = home();
  mkdirSync(join(h, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(h, ".claude", "sessions", "4242.json"), JSON.stringify({ sessionId: A }));
  const dirs = agentDirs({ HOME: h });
  assert.equal(findSession("claude", { dirs, pid: 4242 }), A);
  assert.equal(findSession("claude", { dirs, pid: 1 }), null);
});

test("Copilot CLI's session is the one its process holds a lock in", () => {
  const h = home();
  for (const [id, pid] of [[A, 4242], [B, 77]]) {
    mkdirSync(join(h, ".copilot", "session-state", id), { recursive: true });
    writeFileSync(join(h, ".copilot", "session-state", id, `inuse.${pid}.lock`), "");
  }
  const dirs = agentDirs({ HOME: h });
  assert.equal(findSession("copilot", { dirs, pid: 4242 }), A);
  assert.equal(findSession("copilot", { dirs, pid: 1 }), null);
  assert.equal(agentDirs({ HOME: h, COPILOT_HOME: "/c" }).copilot, "/c");
});

test("droid: the newest session file for the folder written since the agent started", () => {
  const h = home();
  const dirs = agentDirs({ HOME: h });
  const dir = sessionDir("droid", dirs, CWD);
  mkdirSync(dir, { recursive: true });
  for (const [id, ms] of [[A, T0 - 60_000], [B, T0 + 5_000], [C, T0 + 9_000]]) {
    writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
    at(join(dir, `${id}.jsonl`), ms);
  }
  // Not sessions: another kind of file, a bad name.
  writeFileSync(join(dir, `${C}.settings.json`), "{}");
  at(join(dir, `${C}.settings.json`), T0 + 99_000);
  writeFileSync(join(dir, "bad id.jsonl"), "{}");
  at(join(dir, "bad id.jsonl"), T0 + 99_000);
  // Another folder's newer session.
  const other = sessionDir("droid", dirs, "/elsewhere");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, `${A}.jsonl`), "{}");
  at(join(other, `${A}.jsonl`), T0 + 99_000);

  assert.equal(findSession("droid", { dirs, cwd: CWD, startedMs: T0 }), C);
  assert.equal(findSession("droid", { dirs, cwd: CWD, startedMs: T0 + 60_000 }), null, "nothing written since it started");
  assert.equal(findSession("droid", { dirs, cwd: "/nowhere", startedMs: T0 }), null);
  assert.equal(findSession("droid", { dirs, cwd: null, startedMs: T0 }), null);
});

test("cursor: the newest chat folder for the workspace written since the agent started", () => {
  const h = home();
  const dirs = agentDirs({ HOME: h });
  const dir = sessionDir("cursor", dirs, CWD);
  for (const [id, ms] of [[A, T0 - 60_000], [B, T0 + 5_000], [C, T0 + 2_000]]) {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "store.db"), "");
    at(join(dir, id, "store.db"), ms);
    at(join(dir, id), Math.min(ms, T0 - 120_000));
  }
  // The chat written last is the one in use, even if its folder is older.
  assert.equal(findSession("cursor", { dirs, cwd: CWD, startedMs: T0 }), B);
  mkdirSync(join(dir, "not-a-chat id"));
  assert.equal(findSession("cursor", { dirs, cwd: CWD, startedMs: T0 }), B);
  assert.equal(findSession("cursor", { dirs, cwd: CWD, startedMs: T0 + 60_000 }), null);
  assert.equal(findSession("cursor", { dirs, cwd: "/nowhere", startedMs: T0 }), null);
});

test("an agent without a finder finds nothing", () => {
  assert.equal(findSession("codex", { dirs: agentDirs({ HOME: home() }), pid: 1, cwd: CWD, startedMs: T0 }), null);
  assert.equal(findSession("vim", { dirs: agentDirs({ HOME: home() }) }), null);
});

// A Claude Code transcript: the project it is filed under, and its lines.
const transcript = (dirs, project, id, lines) => {
  mkdirSync(join(dirs.claude, "projects", project), { recursive: true });
  writeFileSync(join(dirs.claude, "projects", project, `${id}.jsonl`), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
};

test("claude: the folder a session started in is the first cwd its transcript records", () => {
  const dirs = agentDirs({ HOME: home() });
  transcript(dirs, "-Users-me-code-my-app", A, [{ type: "mode" }, "{half a line", "\"a string\"", "null", { cwd: CWD }, { cwd: "/Users/me/code/my.app/sub" }]);
  assert.deepEqual(claudeStartFolder({ dirs, session: A, cwd: CWD }), { cwd: CWD });
  // sessions/<pid>.json and the terminal say where it is now; --resume looks
  // only where the conversation is filed, under the folder it started in.
  assert.deepEqual(claudeStartFolder({ dirs, session: A, cwd: "/Users/me/code/my.app/sub" }), { cwd: CWD }, "moved");
  assert.deepEqual(claudeStartFolder({ dirs, session: A }), { cwd: CWD }, "no current folder: found by searching");
});

test("claude: the folder is never taken from the name the transcript is filed under", () => {
  const dirs = agentDirs({ HOME: home() });
  // /Users/me/code/my-app and /Users/me/code/my.app are both -Users-me-code-my-app.
  transcript(dirs, "-Users-me-code-my-app", A, [{ cwd: "/Users/me/code/my-app" }]);
  assert.deepEqual(claudeStartFolder({ dirs, session: A, cwd: CWD }), { cwd: "/Users/me/code/my-app" });
});

test("claude: an entry past the first piece read is still found", () => {
  const dirs = agentDirs({ HOME: home() });
  transcript(dirs, "-Users-me-code-my-app", A, [{ type: "summary", text: "x".repeat(100_000) }, { cwd: CWD }]);
  assert.deepEqual(claudeStartFolder({ dirs, session: A }), { cwd: CWD });
});

// Past 200 characters Claude Code shortens a project's name and adds a hash.
const LONG = "/Users/me/code/" + "a".repeat(100) + "/" + "b".repeat(100) + "/café.app";
const LONG_PROJECT = "-Users-me-code-" + "a".repeat(100) + "-" + "b".repeat(84) + "-i1o417";

test("claude: a project is named as Claude Code names it, shortened past 200 characters", () => {
  assert.equal(claudeProject(CWD), "-Users-me-code-my-app");
  assert.equal(claudeProject("/" + "x".repeat(199)), "-" + "x".repeat(199), "200: kept whole");
  assert.equal(claudeProject("/" + "x".repeat(200)), "-" + "x".repeat(199) + "-d0i18x", "201: shortened");
  assert.equal(claudeProject(LONG), LONG_PROJECT);
});

test("claude: a session in a folder with a long path is found and keeps its folder", () => {
  const dirs = agentDirs({ HOME: home() });
  transcript(dirs, LONG_PROJECT, A, [{ cwd: LONG }]);
  assert.deepEqual(claudeStartFolder({ dirs, session: A, cwd: LONG }), { cwd: LONG });
  assert.deepEqual(claudeStartFolder({ dirs, session: A, cwd: CWD }), { cwd: LONG }, "moved");
  // Filed under the long name cut at 200 without the hash: not where --resume looks.
  transcript(dirs, LONG_PROJECT.slice(0, 200), B, [{ cwd: LONG }]);
  assert.match(claudeStartFolder({ dirs, session: B, cwd: LONG }).why, /doesn't say which folder/);
});

test("claude: two long folders that share their first 200 characters keep their own sessions", () => {
  const dirs = agentDirs({ HOME: home() });
  const other = LONG.replace("café.app", "other");
  assert.equal(claudeProject(other).slice(0, 200), LONG_PROJECT.slice(0, 200));
  assert.notEqual(claudeProject(other), LONG_PROJECT);
  transcript(dirs, claudeProject(other), A, [{ cwd: other }]);
  assert.deepEqual(claudeStartFolder({ dirs, session: A, cwd: LONG }), { cwd: other }, "moved");
  // Filed under one folder's name, started in the other: not where --resume looks.
  transcript(dirs, LONG_PROJECT, B, [{ cwd: other }]);
  assert.match(claudeStartFolder({ dirs, session: B, cwd: LONG }).why, /doesn't say which folder/);
});

test("claude: no transcript, or one that doesn't say its folder, is not resumable", () => {
  const dirs = agentDirs({ HOME: home() });
  assert.match(claudeStartFolder({ dirs, session: A, cwd: CWD }).why, /no message yet/);
  // The first cwd is the one that counts, even when a later one would fit.
  transcript(dirs, "-elsewhere", B, [{ cwd: "/somewhere/else" }, { cwd: "/elsewhere" }]);
  assert.match(claudeStartFolder({ dirs, session: B, cwd: CWD }).why, /doesn't say which folder/);
  transcript(dirs, "-x", C, [{ type: "mode" }, { cwd: "x" }]);
  assert.match(claudeStartFolder({ dirs, session: C }).why, /doesn't say which folder/, "relative");
  assert.match(claudeStartFolder({ dirs, session: "bad id", cwd: CWD }).why, /malformed/);
});

test("Grok's session is the one active_sessions.json lists for its process", () => {
  const h = home();
  mkdirSync(join(h, ".grok"), { recursive: true });
  writeFileSync(join(h, ".grok", "active_sessions.json"), JSON.stringify([
    { session_id: A, pid: 4242, cwd: "/w" },
    { session_id: B, pid: 77, cwd: "/w" },
  ]));
  const dirs = agentDirs({ HOME: h });
  assert.equal(findSession("grok", { dirs, pid: 4242 }), A);
  assert.equal(findSession("grok", { dirs, pid: 1 }), null);
  assert.equal(findSession("grok", { dirs: agentDirs({ HOME: home() }), pid: 4242 }), null);
  assert.equal(agentDirs({ HOME: h, GROK_HOME: "/g" }).grok, "/g");
});
