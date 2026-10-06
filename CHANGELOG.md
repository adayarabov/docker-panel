# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/SKFabric/docker-panel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SKFabric/docker-panel/releases/tag/v0.1.0
