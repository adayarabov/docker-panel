# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.3] - 2026-10-06

### Changed

- Tests follow the layout of Claude Code's built-in mods: one file per `hooks/` module (`compose`, `actions`, `docker`, `band`, `pane`, `register`), each declaring its tier and one `describe`, with shared fixtures under `tests/fixtures/`, one export a file. New tests cover card actions, `/docker` argument parsing and the More/Less labels.
- The plugin folder carries its own README, as the built-in mods do.
- CI type-checks the plugin against the declarations the engine lays beside it, before running the tests.

## [0.2.2] - 2026-10-06

### Added

- A service with an action running on it says so: its card and chip show `◐ stopping…` (or restarting, starting, rebuilding, recreating) in place of its status, and the card's buttons wait until it is done.
- Pressing an action while another runs now says to wait, instead of doing nothing.

### Changed

- Colours follow Docker: Docker blue for the brand mark and accents, neutral grey chips and frames, and status colours tuned to sit beside the blue.
- In the terminal, each card in the control pane names its service with the same chip as the band.
- The band's chips no longer list published ports; the control pane's cards link them.
- A stopped service's name is dimmed in its control-pane card, as on its chip.
- **More** reads **Less** while the control pane is open and closes it; closing the pane any other way turns it back.
- The band's stack-wide buttons are glyphs: `↻` Restart and `■` Down while it runs, `▶` Up and `⚒` Up --build while it is down (hotkeys `r`, `d`, `u`, `b` as before).

### Fixed

- In a narrow control pane a service's name broke into one letter per row and its usage into several rows; the name's chip no longer shrinks, the status truncates and usage moves whole onto the next row.

## [0.2.1] - 2026-10-06

### Changed

- The terminal band no longer draws its own ×: Claude Code's `[-]` already collapses every band there, and `/docker-panel hide` hides it for good. The desktop keeps the ×.

### Fixed

- "Cannot connect to the Docker daemon" stayed on the band and in the control pane after the daemon came back. The daemon's error now has its own field, cleared by the first successful refresh.
- Stopping a container showed it as crashed: `docker stop` ends a process that ignores SIGTERM with SIGKILL, exit code 137. Exit codes 130, 137 and 143 now read as **stopped** unless Docker reports the out-of-memory killer, which shows as "killed: out of memory".
- Stopped containers no longer show a stale CPU and memory sample in the control pane.

## [0.2.0] - 2026-10-06

### Added

- `/docker-panel use <dir>` points the band at a compose project outside the session's directory, remembered per session directory.
- Control pane beside the transcript, opened by the band's **More** button, `/docker more` or `/docker logs [svc]`: stack-wide Up all / Restart all / Down, then a card per service with its state, image, ports, CPU and memory and its own Start / Stop / Restart / Rebuild (or Recreate) / Ask Claude buttons. Each card unfolds its logs, followed every 2 seconds. The pane scrolls when the cards outgrow it.
- `/docker start <svc>` and `/docker stop <svc>`.
- CPU and memory from `docker stats`, sampled every 10 seconds: the project total on the band, per service in the control pane.

### Changed

- The band is two rows: project, up count, usage, the problem and the actions on row one; the service chips from row two on.
- The band's Logs button is now **More**, and the hover details above the band are gone; both moved into the control pane.

### Fixed

- `/docker` and `/docker-panel` are answered when the session names them with the plugin prefix.

## [0.1.0] - 2026-10-06

### Added

- Status band above the prompt with a chip per Compose service: state, health, exit code, restart count and published ports.
- Hover details per service: Docker's status line, stale reason and the last log lines of a failing service.
- Live updates from `docker compose events`, with a 15-second fallback poll.
- Toasts when a service exits non-zero, crash-loops or turns unhealthy.
- Stale config detection from compose config hashes and Dockerfile modification time.
- Context-aware actions: Up, Up --build, Logs, Restart, Down, Rebuild & up, and Ask Claude.
- `/docker` command for status and actions, `/docker-panel show|hide` and a corner × to hide the band.
- `examples/shop-demo` seven-service demo stack.

[Unreleased]: https://github.com/SKFabric/docker-panel/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/SKFabric/docker-panel/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/SKFabric/docker-panel/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/SKFabric/docker-panel/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/SKFabric/docker-panel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SKFabric/docker-panel/releases/tag/v0.1.0
