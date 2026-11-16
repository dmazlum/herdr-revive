Hook input captured from copilot 1.0.111 on macOS, byte for byte except `cwd`
(set to `/w`). `session-start.json` and `session-end-complete.json` are a
`copilot -p` run; `session-end-user-exit.json` is an interactive session sent
SIGTERM. All three came from hooks registered as `SessionStart`/`SessionEnd`.
`session-start-camel.json` is the same `SessionStart` from a hook registered as
`sessionStart`: camelCase event names get camelCase fields and no
`hook_event_name`, which Revive does not read.
