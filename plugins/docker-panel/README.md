# docker-panel

A Docker Compose band above the prompt, and a control pane beside the
transcript. The band appears in any session directory holding
`compose.yaml`, `compose.yml`, `docker-compose.yaml` or
`docker-compose.yml` (or the directory `/docker-panel use <dir>` names) and
stays away everywhere else.

The band's first row sums the project up: its name, how many services are
up, the stack's CPU and memory, the one problem worth knowing about (a
crash, a crash loop, a failing healthcheck, a config or Dockerfile changed
since the containers started) and the actions that fit it: `↻` restart and
`■` down while it runs, `▶` up and `⚒` up --build while it is down, Ask
Claude and a restart of the failing service, or Rebuild & up for stale ones.
The service chips start on the second row and wrap; a chip says what an
action on its service is doing (`◐ stopping…`) until it is done. **More**
opens the control pane and reads **Less** while it is open; the pane's own
`×` or `Esc` turn it back. In the terminal the band is a bordered panel
that Claude Code's `[-]` collapses; in the desktop app it sits in the
app's card with a `×` that hides it until `/docker-panel show`.

The control pane carries the stack-wide actions and one card per service:
its state, image, published ports as `localhost` links, CPU and memory
while it runs, and its own Start / Stop / Restart / Rebuild (or Recreate)
buttons, with Ask Claude when it crashed. A card unfolds its last log lines
on demand and follows them every two seconds while the pane is open. Cards
never squeeze a service's name in a narrow pane; the body scrolls when they
outgrow it.

State comes from `docker compose events` (container lifecycle only, not the
healthcheck `exec_*` noise), refreshed 400 ms after the last event, with a
15-second poll behind it for edits made elsewhere; `docker stats` samples
usage every ten seconds on its own timer, because one sample takes about
two. A Claude edit to a compose file, a Dockerfile or `.env` refreshes at
once. A stopped container is told from a crashed one by its exit code:
130, 137 and 143 are stop signals (`docker stop` ends a process that
ignores SIGTERM with SIGKILL), unless Docker reports the OOM killer. Ask
Claude puts the failure and the service's last log lines into the prompt;
it submits nothing.

Compose actions run off a timer rather than in the press that asked for
them, since `down` on containers that ignore SIGTERM outlasts a press's
dispatch budget; their outcome arrives as a toast and on the band. One runs
at a time; a press meanwhile says to wait.

## Commands

| Command | What it does |
| --- | --- |
| `/docker` | Status: every service with its ports and problems |
| `/docker up [svc]`, `start <svc>` | `docker compose up -d` |
| `/docker stop [svc]`, `restart [svc]`, `down` | The compose verbs of the same name (`down` keeps volumes) |
| `/docker rebuild [svc]` | `up -d --build` for the named service, or the stale ones |
| `/docker more`, `logs [svc]` | Opens the control pane, `svc`'s logs unfolded; the last 40 lines into the transcript where no pane fits |
| `/docker-panel show`, `hide` | The band, remembered across sessions |
| `/docker-panel use <dir>` | Follow the compose project in another directory, remembered per session directory; `use .` goes back |

## Testing

    claude plugin test plugins/docker-panel

A test file is named for what it covers under `hooks/` (`compose.test.ts`
beside `hooks/compose.ts`), declares the tier the mod loads in, and holds
one `describe` titled with that name; what several tests share sits under
`tests/fixtures/`, one export a file. `fixtures/fake-docker.ts` answers the
docker CLI beneath the mod from a `World` a test can swap mid-test, and
holds compose actions on a gate so a test can look while one runs.

Type-check against the declarations the engine lays beside the mod when it
loads it (`.claude-plugin/types/`):

    tsc -p plugins/docker-panel

## Layout

| Path | What it holds |
| --- | --- |
| `hooks/register.tsx` | Hook wiring: session start, the refresh loop, events, stats, commands, actions |
| `hooks/band.tsx` | The band's drawing and the palette |
| `hooks/pane.tsx` | The control pane's drawing |
| `hooks/compose.ts` | Pure parsing of docker CLI output and state derivation |
| `hooks/docker.ts` | Docker CLI queries behind a small `Host` interface |
| `hooks/actions.ts` | Which buttons a state offers and what they run |
| `types/index.d.ts` | The mod's `$.state` contract |

The engine lets `$` reach only functions declared in the file that uses it,
so everything outside `register.tsx` is pure or takes a `Host`.

Early access: function-hook mods load only where Claude Code enables them,
and the API may change between releases.
