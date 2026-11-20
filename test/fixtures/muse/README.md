Hook input captured from muse 1.4.24 on macOS, from a plugin's `SessionStart`
and `SessionEnd` hooks, byte for byte except `cwd` (set to `/w`).
`session-start.json` came at a new session's first answer (`source: "startup"`),
`session-start-resume.json` at the first message after `muse resume <id>`, and
`session-end-exit.json` from `/exit`. A session whose process got SIGHUP sent no
`SessionEnd`. The hooks ran as children of the `muse-bin-<version>` process in
the terminal's foreground, with a reduced environment: no `HC_TERMINAL_ID`, but
`MUSE_SESSION_ID`, `MUSE_THREAD_ID` and the plugin's own variables.
