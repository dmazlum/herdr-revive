// Finding a running agent's session from the files it writes, for one started
// before Revive's hooks were installed: the dialog can then fork it (where the
// agent forks) and show it, and, for Claude Code and Codex, `revive.mjs adopt`
// can write the record its hook would have. The hooks stay the record; this is
// only the fallback. Engine-only (Node's fs): the dialog never imports it.
//
// An agent without a finder here finds nothing, and that is fine: adding an
// agent to Revive is its entry in core.js's AGENTS, its hook target in
// revive.mjs, and optionally a finder below.

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { codexPrompt, validId } from "./core.js";

/** A folder as Claude Code and Droid name its store: every non-alphanumeric a dash. */
const dashed = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/**
 * The name of the folder Claude Code keeps a working folder's transcripts in,
 * under `projects/`: the dashed folder, or, past 200 characters, its first 200
 * and a dash and a hash of the folder (31-based over UTF-16 code units, as an
 * int32, in base 36). Read off Claude Code 2.1.325 and checked by hand on
 * macOS against the folder it made for a 226-character path.
 */
export function claudeProject(cwd) {
  const name = dashed(cwd);
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (hash << 5) - hash + cwd.charCodeAt(i) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** Where each agent keeps its files, from the environment. */
export function agentDirs(env = process.env) {
  // Windows keeps the home folder in USERPROFILE; a HOME there (Git Bash's) may be a POSIX-style path.
  const home = (process.platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || "";
  return {
    claude: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    factory: join(home, ".factory"),
    cursor: join(home, ".cursor"),
    copilot: env.COPILOT_HOME || join(home, ".copilot"),
    codex: env.CODEX_HOME || join(home, ".codex"),
  };
}

/**
 * The folder an agent keeps one working folder's sessions in, or null.
 * - droid:  ~/.factory/sessions/<cwd, every non-alphanumeric a dash>/<id>.jsonl
 * - cursor: ~/.cursor/chats/<md5 of the cwd>/<chat id>/store.db
 * Neither layout is documented: both were read off installed copies of those
 * CLIs, and checked by hand on macOS with droid 1.1.0 and cursor-agent
 * 2026.10.22, against sessions those versions wrote. Other versions may differ.
 */
export function sessionDir(key, dirs, cwd) {
  if (!cwd) return null;
  if (key === "droid") return join(dirs.factory, "sessions", dashed(cwd));
  if (key === "cursor") return join(dirs.cursor, "chats", createHash("md5").update(cwd).digest("hex"));
  return null;
}

const mtime = (path) => { try { return statSync(path).mtimeMs; } catch { return 0; } };
const list = (dir) => { try { return readdirSync(dir); } catch { return []; } };

/**
 * The newest of `candidates` ([id, mtime]) written since the agent started.
 * `ps` gives start times to the second, so a second of slack.
 */
function newest(candidates, startedMs) {
  const since = Number.isFinite(startedMs) ? startedMs - 1000 : -Infinity;
  let best = null;
  for (const [id, ms] of candidates) {
    if (!validId(id) || ms < since) continue;
    if (!best || ms > best[1]) best = [id, ms];
  }
  return best?.[0] ?? null;
}

const FINDERS = {
  /** Claude Code keeps `sessions/<pid>.json` for each interactive process. */
  claude: ({ dirs, pid }) => {
    try {
      const id = JSON.parse(readFileSync(join(dirs.claude, "sessions", `${pid}.json`), "utf8")).sessionId;
      return validId(id) ? id : null;
    } catch { return null; }
  },
  droid: ({ dirs, cwd, startedMs }) => {
    const dir = sessionDir("droid", dirs, cwd);
    if (!dir) return null;
    const files = list(dir).filter((f) => f.endsWith(".jsonl"));
    return newest(files.map((f) => [f.slice(0, -".jsonl".length), mtime(join(dir, f))]), startedMs);
  },
  /**
   * Copilot CLI holds `session-state/<id>/inuse.<pid>.lock` while a process
   * has the session open (checked with copilot 1.0.109 on macOS).
   */
  copilot: ({ dirs, pid }) => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const root = join(dirs.copilot, "session-state");
    return list(root).find((id) => validId(id) && existsSync(join(root, id, `inuse.${pid}.lock`))) ?? null;
  },
  // A chat's folder is made once; its store.db is written as the chat goes on.
  cursor: ({ dirs, cwd, startedMs }) => {
    const dir = sessionDir("cursor", dirs, cwd);
    if (!dir) return null;
    return newest(list(dir).map((id) => [id, Math.max(mtime(join(dir, id)), mtime(join(dir, id, "store.db")))]), startedMs);
  },
  /**
   * Codex writes nothing that ties a rollout to its process. A process started
   * with its first message on the command line (`codex "…"`, as `hc run` starts
   * agents) is matched by it: the one rollout in its folder, started since the
   * process, whose first message is that prompt (`codexPrompt`). A rollout
   * there that has no first message yet, or not even its session_meta, may be
   * this process's own while another's already matches: then it finds nothing
   * until that one has written its message. Anything else finds nothing rather
   * than guess. Checked by hand on Windows with codex 0.171.0.
   */
  codex: ({ dirs, cwd, startedMs, argv }) => {
    if (!cwd || !Number.isFinite(startedMs)) return null;
    const prompt = codexPrompt(argv)?.trim();
    if (!prompt) return null;
    const found = new Set();
    for (const file of codexRollouts(dirs.codex, startedMs)) {
      const head = codexHead(file);
      if (head.id === null) return null;
      if (!validId(head.id) || !sameFolder(head.cwd, cwd)) continue;
      if (!(head.at >= startedMs - 1000 && head.at <= startedMs + CODEX_START)) continue;
      if (head.message === null) return null;
      if (head.message.trim() === prompt) found.add(head.id);
    }
    return found.size === 1 ? [...found][0] : null;
  },
};

/**
 * The session a running agent holds, or null. `pid` is the agent's process,
 * `cwd` its folder, `startedMs` when it started, `argv` its command line.
 */
export function findSession(key, { dirs = agentDirs(), pid = null, cwd = null, startedMs = null, argv = null } = {}) {
  const find = Object.prototype.hasOwnProperty.call(FINDERS, key) ? FINDERS[key] : null;
  return find ? find({ dirs, pid, cwd, startedMs, argv }) : null;
}

// A transcript can grow to hundreds of megabytes, and the folder is in one of
// its first entries: it is read a piece at a time, and no further than this.
const PIECE = 64 << 10;
const HEAD = 1 << 20;

/**
 * Calls `visit` with each object entry among a JSONL file's first `limit`
 * bytes, until it returns true. False when the file can't be read.
 */
function eachHeadEntry(path, visit, limit = HEAD) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(limit);
    let size = 0;
    let from = 0;
    while (size < limit) {
      const n = readSync(fd, buf, size, Math.min(PIECE, limit - size), size);
      if (!n) break;
      size += n;
      // Only whole lines: one cut at the end of a piece waits for the next.
      for (let nl = buf.indexOf(10, from); nl !== -1 && nl < size; nl = buf.indexOf(10, from)) {
        const line = buf.subarray(from, nl).toString("utf8");
        from = nl + 1;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry && typeof entry === "object" && visit(entry)) return true;
      }
    }
    return true;
  } catch { return false; }
  finally { if (fd !== null) closeSync(fd); }
}

/** The `cwd` of the first entry in a JSONL file that has one, or null. */
function firstCwd(path) {
  let cwd = null;
  eachHeadEntry(path, (entry) => {
    if (!("cwd" in entry)) return false;
    if (typeof entry.cwd === "string") cwd = entry.cwd;
    return true;
  });
  return cwd;
}

// A Codex rollout opens with its instructions and tools, tens or hundreds of
// kilobytes, before the first message.
const CODEX_HEAD = 8 << 20;
// The first message reaches the rollout once Codex has started its tools and
// MCP servers, which can take a while.
const CODEX_START = 2 * 60_000;
const DAY = 24 * 60 * 60_000;

/**
 * The rollout files Codex may have started for a process that started at
 * `startedMs`: under `sessions/YYYY/MM/DD/` (its local date), written since.
 */
function codexRollouts(root, startedMs) {
  const files = new Set();
  for (const ms of [startedMs - DAY, startedMs, startedMs + DAY]) {
    const d = new Date(ms);
    const dir = join(root, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    for (const f of list(dir)) {
      if (f.startsWith("rollout-") && f.endsWith(".jsonl") && mtime(join(dir, f)) >= startedMs - 1000) files.add(join(dir, f));
    }
  }
  return [...files];
}

/** A user message's text in a rollout entry, or null: Codex 0.171's `item_completed`, or the older `user_message` event. */
function codexUserText(entry) {
  if (entry.type !== "event_msg") return null;
  const p = entry.payload;
  if (p?.type === "user_message" && typeof p.message === "string") return p.message;
  if (p?.type !== "item_completed" || p.item?.type !== "UserMessage" || !Array.isArray(p.item.content)) return null;
  return p.item.content.filter((c) => typeof c?.text === "string").map((c) => c.text).join("");
}

/** A rollout's session, folder and start, and its first message: `{ id, cwd, at, message }`. */
function codexHead(path) {
  const head = { id: null, cwd: null, at: null, message: null };
  eachHeadEntry(path, (entry) => {
    if (entry.type === "session_meta" && head.id === null) {
      const p = entry.payload ?? {};
      head.id = p.id ?? p.session_id ?? null;
      head.cwd = typeof p.cwd === "string" ? p.cwd : null;
      head.at = Date.parse(p.timestamp ?? entry.timestamp ?? "");
      return false;
    }
    head.message = codexUserText(entry);
    return head.message !== null;
  }, CODEX_HEAD);
  return head;
}

const sameFolder = (a, b) => {
  if (!a || !b) return false;
  return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
};

/**
 * The folder a running Claude Code session started in, `{ cwd }`, or `{ why }`
 * when it can't be told. That is the folder its hook records and `--resume`
 * (or a fork) needs; `sessions/<pid>.json` and the terminal follow the folder
 * the agent is in now, which can move.
 *
 * It is read from the transcript (`projects/<dir>/<id>.jsonl`): the `cwd` of
 * its first entry that has one. Never from `<dir>`, which can't be turned
 * back into a path (`/a/my-proj` and `/a/my/proj` are both `-a-my-proj`);
 * the current folder's `<dir>` is only where the file is looked for first.
 * No transcript: no message yet, so nothing to resume. Only this process's
 * Claude folder is searched (`dirs`), as for the transcript check.
 */
export function claudeStartFolder({ dirs = agentDirs(), session, cwd = null } = {}) {
  if (!validId(session)) return { why: "its session id is malformed" };
  const projects = join(dirs.claude, "projects");
  const file = `${session}.jsonl`;
  const here = cwd ? join(projects, claudeProject(cwd)) : null;
  const dir = here && existsSync(join(here, file)) ? here
    : list(projects).map((d) => join(projects, d)).find((d) => existsSync(join(d, file)));
  if (!dir) return { why: "it has no message yet, so there is nothing to resume" };
  const start = firstCwd(join(dir, file));
  // A folder filed under another name isn't one `--resume` would look in.
  if (!start || !isAbsolute(start) || join(projects, claudeProject(start)) !== dir) {
    return { why: "its transcript doesn't say which folder it started in" };
  }
  return { cwd: start };
}
