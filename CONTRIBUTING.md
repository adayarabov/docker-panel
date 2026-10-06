# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Setup

1. Install Claude Code and Docker with the Compose plugin.
2. Clone the repository and open Claude Code in it. The plugin loads through the
   `.claude/skills/docker-panel` symlink and hot-reloads when you save a file.
3. Start the demo stack to have something to look at:

   ```bash
   cd examples/shop-demo && docker compose up -d
   ```

## Layout

| Path | What lives there |
| --- | --- |
| `plugins/docker-panel/hooks/register.tsx` | Hook wiring: session start, refresh loop, events, commands, actions |
| `plugins/docker-panel/hooks/band.tsx` | The band's drawing |
| `plugins/docker-panel/hooks/compose.ts` | Pure parsing of docker CLI output and state derivation |
| `plugins/docker-panel/hooks/docker.ts` | Docker CLI queries behind a small `Host` interface |
| `plugins/docker-panel/hooks/actions.ts` | Which buttons a state offers and what they run |
| `plugins/docker-panel/tests/` | Tests run by `claude plugin test` |

The engine only lets `$` be passed to functions declared in the same file, so
everything outside `register.tsx` is either pure or takes a `Host`.

## Before opening a pull request

```bash
claude plugin validate plugins/docker-panel
claude plugin test plugins/docker-panel
```

- Add or update a test for the behaviour you changed.
- Check the band in both the terminal and the desktop app when you touch `band.tsx`;
  the two surfaces lay out flex rows differently.
- Add a line under `Unreleased` in `CHANGELOG.md`.
- Keep commits in the `type: description` form (`feat:`, `fix:`, `docs:`, ...).

## Reporting bugs

Open an issue with your Claude Code version (`claude --version`), Docker and Compose
versions, the surface (terminal or desktop), and what the band showed. A screenshot
helps a lot.
