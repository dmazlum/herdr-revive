// Revive on Windows. The decisions (program names, PowerShell quoting, the
// resume script, Windows command lines and process tables) are plain functions
// and are tested everywhere. What needs Windows itself (PowerShell running the
// scripts Revive writes, Win32_Process, folder ACLs, the profile install) runs
// only there, with a temporary home and profile: never the person's own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agentKey, hookPayload, hookOwner, isShell, isPowerShell, promptShell, ownShell, idleWrappedShell, psQuote, psJoin, resumeLine, resumeScriptPwsh,
  needsCommand, needsHint, notResumingLine, splitCommandLine, parseWinProcesses, readRecord, labelArgs, shouldResume,
} from "../mods/revive/lib/core.js";
import { engineWord, hasCopilotHooks, pwshBlock, shellBlock, vetRecord, withCopilotHooks, withShellBlock, winOwners, winProcesses } from "../mods/revive/revive.mjs";
import { claudeProject, claudeStartFolder, agentDirs } from "../mods/revive/lib/sessions.js";
import { WINDOWS, WINDOWS_ONLY } from "./helpers/platform.js";

const ENGINE = resolve("mods/revive/revive.mjs");
const ID = "9e458eb4-5b0c-4a63-9d7e-2b9f1c3d4e5f";
// Real paths: a runner's TEMP can be an 8.3 short name (C:\Users\RUNNER~1), which PowerShell reports long.
const temp = (name) => realpathSync.native(mkdtempSync(join(tmpdir(), `revive-win-${name}-`)));
const has = (bin) => spawnSync(bin, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0;
const POWERSHELLS = WINDOWS ? ["pwsh", "powershell"].filter(has) : [];

// ── program names ───────────────────────────────────────────────────────────

test("Windows program paths are recognized: backslashes, .exe and npm's shims, any case", () => {
  assert.equal(agentKey(null, ["C:\\Users\\me\\.local\\bin\\claude.exe", "--model", "opus"]), "claude");
  assert.equal(agentKey(null, ["C:\\Users\\me\\.local\\bin\\CLAUDE.EXE"]), "claude");
  assert.equal(agentKey(null, ["C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"]), "codex");
  assert.equal(agentKey(null, ["C:\\Program Files\\nodejs\\node.exe", "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex"]), "codex");
  assert.equal(agentKey(null, ["C:\\Users\\me\\AppData\\Roaming\\npm\\pi.ps1"]), "pi");
  // pi still only counts as the first word: `ssh pi` is not pi.
  assert.equal(agentKey(null, ["C:\\Windows\\System32\\OpenSSH\\ssh.exe", "pi"]), null);
  assert.equal(agentKey(null, ["C:\\Users\\me\\AppData\\Local\\cursor-agent\\versions\\1\\agent.exe"]), "cursor");
  assert.equal(agentKey(null, ["C:\\tools\\agent.exe"]), null, "a bare `agent` outside a Cursor folder is not Cursor");
  assert.equal(agentKey(null, ["C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.EXE", "--model", "m"]), "agy");
  // POSIX words are read as before: case matters there.
  assert.equal(agentKey(null, ["/usr/local/bin/claude"]), "claude");
  assert.equal(agentKey(null, ["/usr/local/bin/Claude"]), null);
});

test("PowerShell and cmd are shells; herdr-core's PowerShell waits at its prompt", () => {
  const herdrPwsh = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoExit", "-Command", "$global:__hc_prompt = $function:prompt"];
  assert.ok(isShell(herdrPwsh));
  assert.ok(isPowerShell(herdrPwsh));
  assert.ok(isShell(["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]));
  assert.ok(isShell(["C:\\WINDOWS\\system32\\cmd.exe"]));
  assert.ok(!isPowerShell(["C:\\WINDOWS\\system32\\cmd.exe"]));
  assert.ok(promptShell(herdrPwsh), "-NoExit keeps it at its prompt after the -Command");
  assert.ok(promptShell(["pwsh.exe", "-noe", "-c", "x"]), "parameters may be shortened, in any case");
  assert.ok(promptShell(["powershell.exe", "-NoLogo", "-NoProfile"]));
  assert.ok(!promptShell(["pwsh.exe", "-Command", "claude"]), "a -Command without -NoExit runs and quits");
  assert.ok(!promptShell(["pwsh.exe", "-c", "claude"]));
  assert.ok(!promptShell(["pwsh.exe", "-File", "x.ps1"]));
  assert.ok(!promptShell(["powershell.exe", "-EncodedCommand", "ZQBjAGgAbwA="]));
  assert.ok(promptShell(["cmd.exe"]));
  assert.ok(promptShell(["cmd.exe", "/k", "echo"]));
  assert.ok(!promptShell(["cmd.exe", "/c", "claude"]));
  // POSIX shells are judged as before.
  assert.ok(promptShell(["-zsh"]));
  assert.ok(!promptShell(["bash", "-c", "x"]));
});

test("a hook is the foreground agent's through Git Bash's two shells, and a tool call's is not", () => {
  // Claude Code runs its hooks through Git Bash on Windows: node <- bash <- bash <- claude.exe <- pwsh.
  const table = new Map([
    [100, { ppid: 1, argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoExit", "-Command", "x"] }],
    [200, { ppid: 100, argv: ["C:\\Users\\me\\.local\\bin\\claude.exe", "--model", "opus"] }],
    [300, { ppid: 200, argv: ["C:\\Program Files\\Git\\bin\\bash.exe", "-c", "node \"C:\\m\\revive.mjs\" hook"] }],
    [310, { ppid: 300, argv: ["C:\\Program Files\\Git\\usr\\bin\\bash.exe", "-c", "node \"C:\\m\\revive.mjs\" hook"] }],
    [320, { ppid: 310, argv: ["C:\\Program Files\\nodejs\\node.exe", "C:\\m\\revive.mjs", "hook"] }],
    // `claude -p` run by the agent as a tool, through PowerShell: its hooks are its own.
    [400, { ppid: 200, argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoProfile", "-Command", "claude -p hi"] }],
    [410, { ppid: 400, argv: ["C:\\Users\\me\\.local\\bin\\claude.exe", "-p", "hi"] }],
    [420, { ppid: 410, argv: ["C:\\Program Files\\Git\\bin\\bash.exe", "-c", "node hook"] }],
  ]);
  assert.deepEqual(hookOwner(table, 310, 200), { owned: true, agent: 200 });
  assert.deepEqual(hookOwner(table, 420, 200), { owned: false, agent: 410 });
});

test("a PowerShell started by hand inside the terminal's own is not the terminal's shell", () => {
  const table = new Map([
    [100, { ppid: 1, argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoExit", "-Command", "x"] }],
    [150, { ppid: 100, argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }],
  ]);
  assert.equal(ownShell(table, 100, 100).own, true);
  // Started by hand from the terminal's own shell, which ran the block and exported REVIVE_SHELL=100.
  assert.equal(ownShell(table, 150, 100, 100).own, false);
  // The terminal's own PowerShell at its prompt is not a wrapper's child shell to type into.
  assert.equal(idleWrappedShell(table, { pid: 150, argv: table.get(150).argv }, 100), false);
});

test("hook payloads with Windows paths still say which agent sent them", () => {
  assert.equal(hookPayload({ transcript_path: "C:\\Users\\me\\.claude\\projects\\C--x\\a.jsonl" }).agent, "claude");
  assert.equal(hookPayload({ transcript_path: "C:\\Users\\me\\.codex\\sessions\\a.jsonl" }).agent, "codex");
  assert.equal(hookPayload({ transcript_path: "C:\\Users\\me\\.pi\\agent\\sessions\\a.jsonl" }).agent, "pi");
  assert.equal(hookPayload({ transcriptPath: "C:\\Users\\me\\.gemini\\antigravity-cli\\brain\\id\\.system_generated\\logs\\transcript.jsonl" }).agent, "agy");
});

// ── PowerShell quoting and the resume script ─────────────────────────────────

test("psQuote leaves plain words bare and quotes everything PowerShell would read", () => {
  const cases = [
    ["claude", "claude"], ["--model", "--model"], ["-m", "-m"], ["--no-tools", "--no-tools"], ["claude-opus-4.5", "claude-opus-4.5"],
    // A dash word that is more than a flag name is quoted: PowerShell splits `-m.x` at the dot.
    ["--model=opus", "'--model=opus'"], ["--model=gpt-5.1", "'--model=gpt-5.1'"], ["-m.x", "'-m.x'"], ["-Dfoo.bar=1", "'-Dfoo.bar=1'"], ["-v1.2", "'-v1.2'"], ["-x:y", "'-x:y'"],
    ["a b", "'a b'"], ["it's", "'it''s'"], ["x\u2019y", "'x\u2019\u2019y'"], ["\u2018q\u201B", "'\u2018\u2018q\u201B\u201B'"],
    ["$env:X", "'$env:X'"], ["$(calc)", "'$(calc)'"], ["`n", "'`n'"], ["@args", "'@args'"], ["a,b", "'a,b'"], ["a;b", "'a;b'"],
    ["", "''"], ["-", "'-'"], ["--", "'--'"], ["C:\\work\\x", "'C:\\work\\x'"],
  ];
  for (const [word, want] of cases) assert.equal(psQuote(word), want, word);
  assert.equal(psJoin(["claude", "--resume", ID]), `& claude --resume ${ID}`);
});

const REC = { agent: "claude", session: ID, cwd: "C:\\work\\it's here", flags: ["--model", "opus", "--dangerously-skip-permissions"], needs: [] };

test("a resume line for PowerShell goes to the folder and runs the agent with &", () => {
  assert.equal(resumeLine(REC, { dialect: "pwsh" }),
    `Set-Location -LiteralPath 'C:\\work\\it''s here'; & claude --model opus --dangerously-skip-permissions --resume ${ID}`);
  assert.equal(resumeLine({ ...REC, cwd: null }, { dialect: "pwsh" }), `& claude --model opus --dangerously-skip-permissions --resume ${ID}`);
  // An unattended line leaves the bypass out, as in POSIX.
  assert.equal(resumeLine(REC, { dialect: "pwsh", unattended: true }), `Set-Location -LiteralPath 'C:\\work\\it''s here'; & claude --model opus --resume ${ID}`);
  // POSIX is unchanged.
  assert.match(resumeLine(REC), /^cd -- 'C:\\work\\it'\\''s here' && claude /);
});

test("the command to run by hand for a record with needs, in PowerShell", () => {
  const rec = { agent: "pi", session: "C:\\Users\\me\\.pi\\s\\a.jsonl", cwd: "C:\\w", flags: [], needs: ["--session-dir"] };
  assert.equal(needsCommand({ ...rec, session: ID }, { dialect: "pwsh" }), `Set-Location -LiteralPath 'C:\\w'; & pi --session-dir <folder> --session ${ID}`);
  assert.match(needsHint({ ...rec, session: ID }, { dialect: "pwsh" }), /^Fill in --session-dir, then run: Set-Location/);
});

test("the PowerShell resume script: note, folder, the agent's context for its process only, failure check", () => {
  const script = resumeScriptPwsh(REC, "C:\\mods\\revive\\revive.mjs");
  assert.match(script, /^& \{\n/);
  assert.match(script, /'↻ Revive'/);
  assert.match(script, /without --dangerously-skip-permissions/);
  assert.match(script, /try \{ Set-Location -LiteralPath 'C:\\work\\it''s here' -ErrorAction Stop \}/);
  assert.match(script, /\$env:REVIVE_RESUME = '\{"agent":"claude","session":"[^"]+","flags":\["--model","opus","--dangerously-skip-permissions"\]\}'/);
  assert.match(script, new RegExp(`& claude --model opus --resume ${ID}\\n`), "the bypass is not on the command line");
  assert.match(script, /Remove-Item Env:REVIVE_RESUME/);
  assert.match(script, /& node 'C:\\mods\\revive\\revive.mjs' failed/);
  assert.equal(resumeScriptPwsh({ ...REC, session: "bad id;calc" }, "x"), "", "a malformed session id gives no script");
  assert.equal(resumeScriptPwsh({ ...REC, agent: "vim" }, "x"), "");
  assert.match(notResumingLine(REC, "it was started with CLAUDE_CONFIG_DIR", { dialect: "pwsh" }), /^& \{\n[\s\S]*\[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8[\s\S]*\[Console\]::Out\.WriteLine\([\s\S]*\$__revive_oe[\s\S]*\}$/);
  assert.match(script, /\[Console\]::OutputEncoding = \$__revive_oe[^\n]*\n[\s\S]*& claude/, "the console's own encoding is back before the agent starts");
});

test("pwshBlock is ASCII only, for Windows PowerShell 5.1, which reads a profile without a BOM as ANSI", () => {
  assert.ok(/^[\x00-\x7f]*$/.test(pwshBlock("C:\\m\\revive.mjs")));
  assert.match(pwshBlock("C:\\m\\it's\\revive.mjs"), /Test-Path -LiteralPath 'C:\\m\\it''s\\revive\.mjs'/);
});

test("the profile block is added once, keeps the person's lines, and comes out whole; POSIX blocks are unchanged", () => {
  const mine = "Set-Alias g git\r\nImport-Module posh-git\r\n";
  const once = withShellBlock(mine, { kind: "pwsh" });
  assert.ok(once.startsWith(mine.trimEnd()));
  assert.equal(withShellBlock(once, { kind: "pwsh" }), once, "installing again changes nothing");
  assert.equal((once.match(/# >>> herdr-revive >>>/g) ?? []).length, 1);
  assert.equal(withShellBlock(once, { remove: true, kind: "pwsh" }).trimEnd(), mine.trimEnd());
  assert.equal(withShellBlock("", { kind: "powershell" }), `${pwshBlock()}\n`);
  assert.equal(withShellBlock("alias g=git\n"), `alias g=git\n\n${shellBlock()}\n`);
});

// ── Windows command lines and process tables ─────────────────────────────────

test("Windows command lines split the way programs read them", () => {
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoExit -Command "$x = 1; echo \\"hi\\""'),
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoExit", "-Command", '$x = 1; echo "hi"']);
  assert.deepEqual(splitCommandLine("a\\\\b \"c\\\\\" d\\\\\\\"e f\\g"), ["a\\\\b", "c\\", 'd\\"e', "f\\g"]);
  assert.deepEqual(splitCommandLine('a "" b'), ["a", "", "b"]);
  assert.deepEqual(splitCommandLine('"say ""hi"""'), ['say "hi"']);
  assert.deepEqual(splitCommandLine("  a\t b  "), ["a", "b"]);
  assert.deepEqual(splitCommandLine(""), []);
  assert.deepEqual(splitCommandLine(null), []);
});

test("Win32_Process rows become the same table as ps's", () => {
  const rows = [
    { p: 10, pp: 4, s: "2026-11-16T10:00:00.0000000Z", c: '"C:\\x\\claude.exe" --model opus' },
    { p: 0, pp: 0, s: null, c: null },
    { p: 20, pp: 10, s: null, c: null },
  ];
  const table = parseWinProcesses(JSON.stringify(rows));
  assert.deepEqual([...table.keys()], [10, 20]);
  assert.deepEqual(table.get(10), { ppid: 4, since: "2026-11-16T10:00:00.0000000Z", argv: ["C:\\x\\claude.exe", "--model", "opus"] });
  assert.deepEqual(table.get(20), { ppid: 10, since: null, argv: [] });
  assert.equal(parseWinProcesses('{"p":5,"pp":1,"s":"x","c":"a b"}').get(5).argv.length, 2, "one process is one object, not an array");
  assert.equal(parseWinProcesses("not json").size, 0);
  assert.equal(parseWinProcesses("").size, 0);
});

// ── folders ─────────────────────────────────────────────────────────────────

test("on Windows a recorded folder is used by its real path, and only when its ACL is the person's", () => {
  const dir = temp("vet");
  const real = realpathSync(dir);
  const yes = () => new Map([[real, true]]);
  const no = () => new Map([[real, false]]);
  assert.deepEqual(vetRecord({ cwd: dir }, { win: true, owners: yes }), { cwd: real });
  assert.deepEqual(vetRecord({ cwd: dir }, { win: true, owners: no }), { cwd: null, cwdRefused: dir });
  assert.deepEqual(vetRecord({ cwd: join(dir, "gone") }, { win: true, owners: yes }), { cwd: null, cwdRefused: join(dir, "gone") });
  const file = join(dir, "f");
  writeFileSync(file, "");
  assert.equal(vetRecord({ cwd: file }, { win: true, owners: () => new Map([[realpathSync(file), true]]) }).cwdRefused, file, "a file is not a folder");
});

test("winOwners: the person's own folder passes; a missing one, or one Everyone may write to, doesn't", WINDOWS_ONLY, () => {
  const mine = realpathSync(temp("owner"));
  const open = realpathSync(temp("open"));
  // Everyone (S-1-1-0) may write: anyone could put a hook or a config there.
  execFileSync("icacls", [open, "/grant", "*S-1-1-0:(OI)(CI)(W)"], { stdio: "ignore" });
  const got = winOwners([mine, open, join(mine, "missing")]);
  assert.equal(got.get(mine), true);
  assert.equal(got.get(open), false);
  assert.equal(got.get(join(mine, "missing")), false);
});

// Windows PowerShell 5.1 writes a JSON array as one object: every folder was refused when asked about several (#70).
for (const ps of POWERSHELLS) {
  test(`winOwners under ${ps}: several folders at once, each answered`, () => {
    const a = temp("own-a"), b = temp("own-b");
    const script = `import { winOwners } from ${JSON.stringify(pathToFileURL(ENGINE).href)};
      process.stdout.write(JSON.stringify([...winOwners(JSON.parse(process.argv[1]))]));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify([a, b, join(a, "missing")])],
      { env: { ...process.env, REVIVE_PS: ps }, encoding: "utf8" });
    assert.deepEqual(new Map(JSON.parse(out)), new Map([[a, true], [b, true], [join(a, "missing"), false]]));
  });
}

test("Windows: a folder whose owner PowerShell couldn't tell in time is refused for now, not marked failed (#71)", () => {
  const dir = temp("unknown");
  const rec = vetRecord({ agent: "claude", session: ID, cwd: dir, auto: true }, { win: true, owners: () => new Map([[dir, null]]) });
  assert.equal(rec.cwd, null);
  assert.equal(rec.cwdUnknown, true);
  const v = shouldResume(rec, { pid: 2, shellPid: 2 });
  assert.equal(v.go, false);
  assert.equal(v.hint, true);
  assert.equal(v.retry, true);
  const no = vetRecord({ agent: "claude", session: ID, cwd: dir, auto: true }, { win: true, owners: () => new Map([[dir, false]]) });
  assert.equal(no.cwdUnknown, undefined);
  assert.equal(shouldResume(no, { pid: 2, shellPid: 2 }).retry, undefined);
});

test("Claude Code's start folder is read from a transcript that names a Windows folder", WINDOWS_ONLY, () => {
  const home = temp("start");
  const cwd = "C:\\work\\my.app";
  const store = join(home, ".claude", "projects", "C--work-my-app");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${ID}.jsonl`), `${JSON.stringify({ type: "user", cwd })}\n`);
  assert.deepEqual(claudeStartFolder({ dirs: agentDirs({ USERPROFILE: home }), session: ID, cwd: "C:\\elsewhere" }), { cwd });
  assert.equal(agentDirs({ USERPROFILE: "C:\\Users\\me", HOME: "/c/Users/me" }).claude, "C:\\Users\\me\\.claude", "USERPROFILE, not Git Bash's HOME");
});

test("Copilot's hooks on Windows also have the powershell command Copilot runs there", () => {
  const doc = withCopilotHooks({ hooks: { SessionStart: [{ type: "command", powershell: "theirs.ps1", timeoutSec: 5 }] } }, { win: true });
  const ours = doc.hooks.SessionStart.at(-1);
  assert.match(ours.powershell, /^node (\S+|'[^']*') hook --agent copilot$/);
  assert.ok(ours.powershell.includes(ENGINE));
  assert.match(ours.bash, /revive\.mjs.* hook --agent copilot$/);
  assert.equal(doc.hooks.SessionStart[0].powershell, "theirs.ps1", "someone else's entry is kept");
  assert.ok(hasCopilotHooks(doc));
  assert.deepEqual(withCopilotHooks(doc, { win: true }), doc, "nothing to change the second time");
  // An entry written before the powershell command existed is brought up to date.
  const old = withCopilotHooks({}, { win: false });
  assert.equal(old.hooks.SessionStart[0].powershell, undefined);
  assert.equal(withCopilotHooks(old, { win: true }).hooks.SessionStart.filter((h) => h.powershell?.includes("revive.mjs")).length, 1);
  const removed = withCopilotHooks(doc, { remove: true, win: true });
  assert.deepEqual(removed.hooks.SessionStart, [{ type: "command", powershell: "theirs.ps1", timeoutSec: 5 }]);
});

// A 227-character Windows folder, and the project name Claude Code 2.1.325 gave it on Windows 11.
const LONG_WIN = "C:\\workspace\\tmp\\" + "a".repeat(100) + "\\" + "b".repeat(100) + "\\café.app";
const LONG_WIN_PROJECT = "C--workspace-tmp-" + "a".repeat(100) + "-" + "b".repeat(82) + "-ff8uth";

test("a Windows folder past 200 characters is named as Claude Code names it", () => {
  assert.equal(claudeProject(LONG_WIN), LONG_WIN_PROJECT);
});

test("Claude Code's start folder is found for a Windows folder past 200 characters", WINDOWS_ONLY, () => {
  const home = temp("long");
  const store = join(home, ".claude", "projects", LONG_WIN_PROJECT);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${ID}.jsonl`), `${JSON.stringify({ type: "user", cwd: LONG_WIN })}\n`);
  const dirs = agentDirs({ USERPROFILE: home });
  assert.deepEqual(claudeStartFolder({ dirs, session: ID, cwd: LONG_WIN }), { cwd: LONG_WIN });
  assert.deepEqual(claudeStartFolder({ dirs, session: ID, cwd: "C:\\elsewhere" }), { cwd: LONG_WIN }, "moved");
});

// ── the process table ───────────────────────────────────────────────────────

test("winProcesses reads this process from Win32_Process: its parent, start time and command line", WINDOWS_ONLY, async () => {
  const all = await winProcesses(null);
  const me = all.get(process.pid);
  assert.ok(me, "this process is in the table");
  assert.equal(me.ppid, process.ppid);
  assert.equal(agentKey(null, me.argv), null);
  assert.match(me.argv[0], /node(\.exe)?$/i);
  assert.ok(Number.isFinite(Date.parse(me.since)), "its start time parses");
  const one = await winProcesses([process.pid, process.ppid]);
  assert.deepEqual([...one.keys()].sort(), [process.pid, process.ppid].sort());
  assert.equal(one.get(process.pid).since, me.since, "the same start time each time: it tells a new process from an old one");
  assert.equal((await winProcesses([])).size, 0);
});

// ── PowerShell running what Revive writes ────────────────────────────────────

/** Runs a script in one PowerShell, without any profile; stdout, stderr and the exit code. */
function ps(shell, script, env = {}) {
  // From a file: PowerShell reads `-Command -` line by line, which splits blocks.
  // With a BOM, so Windows PowerShell 5.1 reads it as UTF-8, as a profile would need.
  const file = join(temp("script"), "s.ps1");
  writeFileSync(file, `\ufeff${script}\n`);
  const r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-File", file], { encoding: "utf8", env: { ...process.env, ...env, PSModulePath: shell === "powershell" ? "" : process.env.PSModulePath } });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

/** A stand-in engine: notes how it was run in `log`, and prints `print` (as UTF-8) for the block to run. */
function fakeEngine(dir, print = "") {
  const engine = join(dir, "engine.mjs");
  writeFileSync(engine, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(dir, "engine.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(${JSON.stringify(print)});
`);
  return engine;
}

/** A stand-in hc (a PowerShell script: the block runs REVIVE_HC with &) that prints `json` for `get`. */
function fakeHc(dir, json) {
  const hc = join(dir, "hc.ps1");
  writeFileSync(hc, `Write-Output '${JSON.stringify(json).replace(/'/g, "''")}'\n`);
  return hc;
}

for (const shell of POWERSHELLS) {
  test(`${shell}: every word psJoin writes reaches a native program whole`, () => {
    const dir = temp("argv");
    const script = join(dir, "argv.js");
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const words = ["--model", "--model=gpt-5.1", "-m.x", "-Dfoo.bar=1", "-v1.2", "-x:y", "-a,b", "--effort=high", "claude-opus-4.5", "a b", "it's", "x’y", "$HOME", "`n", "@args"];
    const r = ps(shell, psJoin([process.execPath, script, ...words]));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out.trim()), words);
  });

  test(`${shell}: the profile block parses`, () => {
    const r = ps(shell, `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:BLOCK, [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`, { BLOCK: pwshBlock(ENGINE) });
    assert.equal(r.code, 0, r.out + r.err);
  });

  test(`${shell}: outside herdr the block does nothing`, () => {
    const dir = temp("outside");
    const engine = fakeEngine(dir);
    const r = ps(shell, `${pwshBlock(engine)}\n"shell:$env:REVIVE_SHELL"`, { HC_TERMINAL_ID: "" });
    assert.equal(r.out.trim(), "shell:");
    assert.ok(!existsSync(join(dir, "engine.log")), "node was not started");
  });

  test(`${shell}: with nothing remembered the block doesn't start node, says why, and marks the shell`, () => {
    const dir = temp("nothing");
    const engine = fakeEngine(dir);
    const hc = fakeHc(dir, { address: "t1", labels: { where: "x" } });
    const r = ps(shell, `${pwshBlock(engine)}\n"shell:$env:REVIVE_SHELL pid:$PID"`, { HC_TERMINAL_ID: "t1", REVIVE_HC: hc, REVIVE_DEBUG: "1", REVIVE_SHELL: "" });
    assert.match(r.err, /revive: nothing remembered on t1/);
    const [, mark, pid] = r.out.trim().match(/shell:(\d+) pid:(\d+)/);
    assert.equal(mark, pid);
    assert.ok(!existsSync(join(dir, "engine.log")));
  });

  test(`${shell}: a shell started from one that ran the block doesn't resume`, () => {
    const dir = temp("nested");
    const engine = fakeEngine(dir);
    const hc = fakeHc(dir, { address: "t1", labels: { "revive.session": ID } });
    // This PowerShell's parent is the node running the test: as if that were the outer shell.
    const r = ps(shell, pwshBlock(engine), { HC_TERMINAL_ID: "t1", REVIVE_HC: hc, REVIVE_DEBUG: "1", REVIVE_SHELL: String(process.pid) });
    assert.match(r.err, /a shell started inside the terminal's own shell/);
    assert.ok(!existsSync(join(dir, "engine.log")));
  });

  test(`${shell}: with a session remembered the block asks check, in PowerShell, and runs what it prints`, () => {
    const dir = temp("check");
    const engine = fakeEngine(dir, "[Console]::Out.WriteLine('RAN ↻ ' + $PID)\n");
    const hc = fakeHc(dir, { address: "t1", labels: { "revive.session": ID } });
    const r = ps(shell, `${pwshBlock(engine)}\n"pid:$PID"`, { HC_TERMINAL_ID: "t1", REVIVE_HC: hc, REVIVE_SHELL: "" });
    const pid = r.out.match(/pid:(\d+)/)[1];
    const [args] = readFileSync(join(dir, "engine.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(args, ["check", "--shell", pid, "--dialect", "pwsh"]);
    assert.ok(r.out.includes(`RAN ↻ ${pid}`), `the script ran in the shell itself, its UTF-8 intact: ${r.out}`);
  });

  test(`${shell}: a broken check never stops the shell from starting`, () => {
    const dir = temp("broken");
    const engine = fakeEngine(dir, "this is not ( PowerShell\n");
    const hc = fakeHc(dir, { address: "t1", labels: { "revive.session": ID } });
    const r = ps(shell, `${pwshBlock(engine)}\n'still here'`, { HC_TERMINAL_ID: "t1", REVIVE_HC: hc, REVIVE_SHELL: "" });
    assert.match(r.out, /still here/);
    assert.equal(r.code, 0);
  });

  test(`${shell}: the resume script runs the agent in its folder with its context, then takes the context away`, () => {
    const dir = temp("resume");
    // A folder name with everything PowerShell would read: quotes, typographic quotes, $, a backtick, spaces.
    const cwd = join(dir, "it's ’ $HOME `n here");
    mkdirSync(cwd);
    const engine = fakeEngine(dir);
    const rec = { agent: "claude", session: ID, cwd, flags: ["--model", "$(New-Item -Path pwned)", "--dangerously-skip-permissions"], needs: [] };
    const agent = `function claude { $global:seen = @{ args = @($args); cwd = (Get-Location).ProviderPath; ctx = $env:REVIVE_RESUME } }`;
    const r = ps(shell, `${agent}\n${resumeScriptPwsh(rec, engine)}\n$seen | ConvertTo-Json -Compress\n"after:[$env:REVIVE_RESUME]"`, { REVIVE_RESUME: "" });
    const seen = JSON.parse(r.out.split("\n").find((l) => l.startsWith("{")));
    assert.deepEqual(seen.args, ["--model", "$(New-Item -Path pwned)", "--resume", ID], "values arrive as they are, and the bypass is left out");
    assert.equal(seen.cwd, cwd);
    assert.deepEqual(JSON.parse(seen.ctx), { agent: "claude", session: ID, flags: rec.flags });
    assert.match(r.out, /after:\[\]/, "the context was for the agent only");
    assert.ok(!existsSync(join(cwd, "pwned")) && !existsSync(join(process.cwd(), "pwned")), "nothing in a value ran");
    assert.match(r.out, /↻ Revive.*resuming .*Claude Code/);
    assert.match(r.out, /without --dangerously-skip-permissions/);
    assert.ok(!existsSync(join(dir, "engine.log")), "a good start reports no failure");
  });

  test(`${shell}: an agent that quits at once with an error is reported as failed; a missing folder runs nothing`, () => {
    const dir = temp("fail");
    const engine = fakeEngine(dir);
    const quick = `function claude { $global:LASTEXITCODE = 1 }`;
    ps(shell, `${quick}\n${resumeScriptPwsh({ agent: "claude", session: ID, cwd: dir, flags: [] }, engine)}`);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "engine.log"), "utf8").trim()), ["failed"]);

    const dir2 = temp("gone");
    const engine2 = fakeEngine(dir2);
    const r = ps(shell, `function claude { 'AGENT RAN' }\n${resumeScriptPwsh({ agent: "claude", session: ID, cwd: join(dir2, "gone"), flags: [] }, engine2)}\n'after'`);
    assert.doesNotMatch(r.out, /AGENT RAN/);
    assert.match(r.out, /after/, "the shell goes on");
    assert.match(r.out, /not resuming Claude Code session 9e458eb4: its folder is gone/);
  });

  test(`${shell}: every agent's resume script and note run, whatever its name (a one-word name like pi included)`, () => {
    for (const agent of ["claude", "codex", "pi", "omp", "droid", "cursor"]) {
      const dir = temp(`agent-${agent}`);
      const engine = fakeEngine(dir);
      const bin = { claude: "claude", codex: "codex", pi: "pi", omp: "omp", droid: "droid", cursor: "cursor-agent" }[agent];
      const rec = { agent, session: ID, cwd: dir, flags: [], needs: [] };
      const r = ps(shell, `function ${bin} { 'AGENT ' + ($args -join ' ') }\n${resumeScriptPwsh(rec, engine)}\n${notResumingLine(rec, "why", { dialect: "pwsh" })}`);
      assert.equal(r.code, 0, `${agent}: ${r.out}${r.err}`);
      assert.doesNotMatch(r.err, /ParseException|Unexpected token|Missing/, `${agent}: ${r.err}`);
      assert.match(r.out, new RegExp(`AGENT .*${ID}`), `${agent}: ${r.out}`);
      assert.match(r.out, /not resuming .* session 9e458eb4: why\./, `${agent}: ${r.out}`);
    }
  });
  test(`${shell}: the note Revive prints when it won't resume runs as it is`, () => {
    const rec = { agent: "claude", session: ID };
    const r = ps(shell, notResumingLine(rec, "it's $(calc) `n", { dialect: "pwsh" }));
    assert.match(r.out, /not resuming Claude Code session 9e458eb4: it's \$\(calc\) `n\./);
    assert.equal(r.code, 0);
  });
}

// ── install ─────────────────────────────────────────────────────────────────

/** A temporary home and PowerShell profiles; the engine runs with them only. */
function winHome({ pi = false } = {}) {
  const home = temp("home");
  mkdirSync(join(home, ".claude"));
  if (pi) mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const pwsh = join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  const powershell = join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
  const env = { ...process.env, HOME: home, USERPROFILE: home, REVIVE_PWSH_PROFILE: pwsh, REVIVE_POWERSHELL_PROFILE: powershell, HC_TERMINAL_SOCKET: "" };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "HC_TERMINAL_ID"]) delete env[k];
  const run = (...args) => execFileSync(process.execPath, [ENGINE, ...args], { encoding: "utf8", env });
  return { home, pwsh, powershell, run, env };
}

test("install on Windows: Claude Code's hooks with a double-quoted engine, and the block in PowerShell's profile", WINDOWS_ONLY, () => {
  const w = winHome();
  mkdirSync(join(w.home, "Documents", "PowerShell"), { recursive: true });
  writeFileSync(w.pwsh, "Set-Alias g git\r\n");
  writeFileSync(join(w.home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  const out = w.run("install");
  assert.match(out, /Microsoft\.PowerShell_profile\.ps1/);
  const settings = JSON.parse(readFileSync(join(w.home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, `node "${ENGINE}" hook`);
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, `node "${ENGINE}" hook`);
  assert.equal(engineWord(ENGINE, w.home, true), `"${ENGINE}"`);
  const profile = readFileSync(w.pwsh, "utf8");
  assert.ok(profile.startsWith("Set-Alias g git"), "the person's lines stay first");
  assert.ok(profile.includes(pwshBlock(ENGINE)));
  assert.ok(existsSync(`${w.pwsh}.revive-backup`));
  assert.ok(!existsSync(w.powershell), "only the PowerShell herdr-core starts gets the block");
  const doctor = JSON.parse(w.run("doctor"));
  assert.equal(doctor.claude, true);
  assert.deepEqual(doctor.shell, { pwsh: true, powershell: false });
  assert.ok(typeof doctor.executionPolicy === "string" && doctor.executionPolicy.length);
  assert.match(w.run("install"), /Nothing to change/, "installing again changes nothing");

  w.run("uninstall");
  assert.equal(readFileSync(w.pwsh, "utf8").trim(), "Set-Alias g git");
  const after = JSON.parse(readFileSync(join(w.home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(after, { theme: "dark" });
});

test("install --powershell writes Windows PowerShell 5.1's profile and keeps its byte-order mark", WINDOWS_ONLY, () => {
  const w = winHome();
  mkdirSync(join(w.home, "Documents", "WindowsPowerShell"), { recursive: true });
  writeFileSync(w.powershell, "\ufeff# mine: ação\r\n");
  w.run("install", "--powershell");
  const text = readFileSync(w.powershell, "utf8");
  assert.ok(text.startsWith("\ufeff# mine: ação"), "the BOM stays, so 5.1 still reads the accents");
  assert.ok(text.includes("# >>> herdr-revive >>>"));
  assert.deepEqual(JSON.parse(w.run("doctor")).shell, { pwsh: false, powershell: true });
  w.run("uninstall");
  assert.ok(readFileSync(w.powershell, "utf8").startsWith("\ufeff# mine: ação"));
  assert.ok(!readFileSync(w.powershell, "utf8").includes("herdr-revive"));
});

test("pi's extension on Windows is a file that loads the mod's, and only that file is taken out", WINDOWS_ONLY, async () => {
  const w = winHome({ pi: true });
  w.run("install", "--no-shell");
  const target = join(w.home, ".pi", "agent", "extensions", "herdr-revive.ts");
  const stub = readFileSync(target, "utf8");
  assert.match(stub.split("\n")[0], /herdr-revive: pi extension/);
  assert.ok(stub.includes(JSON.stringify(pathToFileURL(resolve("mods/revive/pi/revive.ts")).href)));
  assert.equal(JSON.parse(w.run("doctor")).pi, true);
  // It loads, and gives pi the extension's own function (where this Node runs TypeScript,
  // as pi's loader does; Node 20 doesn't).
  if (process.features.typescript) {
    const ext = await import(pathToFileURL(target).href);
    assert.equal(typeof ext.default, "function");
  }
  assert.match(w.run("install", "--no-shell"), /Nothing to change/);
  w.run("uninstall");
  assert.ok(!existsSync(target));

  // Someone else's file at that path is left alone.
  writeFileSync(target, "// mine\n");
  const r = spawnSync(process.execPath, [ENGINE, "install", "--no-shell"], { encoding: "utf8", env: w.env });
  assert.match(r.stderr, /is not Revive's pi extension; Revive won't replace it/);
  w.run("uninstall");
  assert.equal(readFileSync(target, "utf8"), "// mine\n");
});

test("a CLI is found on Windows' PATH by its PATHEXT name", WINDOWS_ONLY, () => {
  const w = winHome();
  const bin = join(w.home, "bin");
  mkdirSync(bin);
  mkdirSync(join(w.home, ".factory"));
  writeFileSync(join(bin, "droid.cmd"), "@echo off\r\n");
  const env = { ...w.env, PATH: `${bin};${process.env.PATH}` };
  execFileSync(process.execPath, [ENGINE, "install", "--no-shell"], { encoding: "utf8", env });
  assert.match(readFileSync(join(w.home, ".factory", "settings.json"), "utf8"), /hook --agent droid/);
});

test("labels written for a Windows terminal read back the same", () => {
  const labels = Object.fromEntries(labelArgs({ agent: "claude", session: ID, cwd: "C:\\w\\x", flags: JSON.stringify(["--model", "opus"]), shell: 100, since: "2026-11-16T10:00:00.0000000Z" }).map((a) => a.split(/=(.*)/s).slice(0, 2)));
  const rec = readRecord(labels);
  assert.equal(rec.cwd, "C:\\w\\x");
  assert.deepEqual(rec.flags, ["--model", "opus"]);
  assert.equal(rec.since, "2026-11-16T10:00:00.0000000Z");
});
