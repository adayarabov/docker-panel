import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Panel, Snapshot } from '../types'
import type { ActionRun } from './actions'
import { askPrompt, commandRun } from './actions'
import { drawBand } from './band'
import { failureText, isFailing, isRelevantEvent, newFailures } from './compose'
import type { Host } from './docker'
import { collect, findComposeFile, lastLine, logTail } from './docker'

const INITIAL: Panel = { availability: 'no-compose', snapshot: null, busy: null, error: null, isHidden: false }
const HIDDEN_KEY = 'isHidden'
const panel = atom({ plugin: 'docker-panel', key: 'panel' } as const, INITIAL)

/** Fallback poll: catches edits made outside Claude and anything events missed. */
const POLL_MS = 15_000
const EVENT_DEBOUNCE_MS = 400
const EVENTS_RETRY_MS = 10_000
const ACTION_TIMEOUT_MS = 600_000
const COMMAND_LOG_LINES = 40
const COMPOSE_EDIT = /(^|\/)((docker-)?compose[^/]*\.ya?ml|Dockerfile[^/]*|\.env)$/

/** Module-lifetime bookkeeping; a hot reload starts it over, the band's data lives in `panel`. */
const runtime: {
  cwd: string
  isRefreshing: boolean
  isRefreshPending: boolean
  isActing: boolean
  debounce: Timer | null
} = { cwd: '', isRefreshing: false, isRefreshPending: false, isActing: false, debounce: null }

const QUERY_TIMEOUT_MS = 15_000

function hostFor($: EngineInterface): Host {
  return {
    cwd: runtime.cwd,
    docker: args => $.process.run(['docker', ...args], { cwd: runtime.cwd, timeoutMs: QUERY_TIMEOUT_MS }),
    exists: path => $.fs.exists(path),
    mtime: path => $.fs.stat(path).then(
      stat => stat.mtimeMs,
      () => undefined,
    ),
    now: () => $.clock.now(),
  }
}

async function refresh($: EngineInterface): Promise<void> {
  if (runtime.isRefreshing) {
    runtime.isRefreshPending = true
    return
  }
  runtime.isRefreshing = true
  try {
    const result = await collect(hostFor($))
    const previous = (await read($, panel)).snapshot
    if (result.kind === 'ok') {
      for (const line of newFailures(previous, result.snapshot)) $.ui.toast(`docker: ${line}`, { timeoutMs: 8000 })
      // `busy` outlives a reload in state; with no action running here, it is stale.
      await update($, panel, (p): Panel => ({
        ...p,
        availability: 'ok',
        snapshot: result.snapshot,
        busy: runtime.isActing ? p.busy : null,
      }))
    } else if (result.kind === 'no-daemon') {
      await update($, panel, (p): Panel => ({ ...p, availability: 'no-daemon', snapshot: null, error: result.reason }))
    } else {
      await update($, panel, p => ({ ...INITIAL, isHidden: p.isHidden }))
    }
  } catch (err) {
    $.ui.log(`docker-panel: refresh failed: ${String(err)}`, { to: 'debug' })
  } finally {
    runtime.isRefreshing = false
    if (runtime.isRefreshPending) {
      runtime.isRefreshPending = false
      void refresh($)
    }
  }
}

function scheduleRefresh($: EngineInterface, ms: number): void {
  runtime.debounce?.cancel()
  runtime.debounce = $.clock.after(ms, () => void refresh($))
}

/** Follows `docker compose events` for the session; starts it again when it ends. */
async function watchEvents($: EngineInterface): Promise<void> {
  try {
    if (await findComposeFile(hostFor($))) {
      let buffered = ''
      const events = $.process.spawn({ argv: ['docker', 'compose', 'events', '--json'], cwd: runtime.cwd })
      for await (const { stream, text } of events) {
        if (stream !== 'stdout') continue
        buffered += text
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        if (lines.some(isRelevantEvent)) scheduleRefresh($, EVENT_DEBOUNCE_MS)
      }
    }
  } catch (err) {
    $.ui.log(`docker-panel: events stream failed: ${String(err)}`, { to: 'debug' })
  }
  $.clock.after(EVENTS_RETRY_MS, () => void watchEvents($))
}

async function perform($: EngineInterface, run: ActionRun): Promise<string> {
  const snapshot = (await read($, panel)).snapshot
  if (run.kind === 'ask') {
    if (!snapshot) return 'No compose project here.'
    await $.prompt.fill({ text: askPrompt(snapshot, run.service), mode: 'append' })
    return `Put ${run.service}'s failure into the prompt.`
  }
  if (run.kind === 'logs') {
    const lines = await logTail(hostFor($), run.service, COMMAND_LOG_LINES)
    const title = run.service ? `Last ${lines.length} lines of ${run.service}` : `Last ${lines.length} log lines`
    return `${title}:\n\`\`\`\n${lines.join('\n') || '(no output)'}\n\`\`\``
  }
  if (runtime.isActing) return 'Another docker action is still running.'
  runtime.isActing = true
  await update($, panel, p => ({ ...p, busy: run.busy, error: null }))
  try {
    const result = await $.process.run(['docker', 'compose', ...run.args], {
      cwd: runtime.cwd,
      timeoutMs: ACTION_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) {
      const reason = lastLine(result.stderr)
      await update($, panel, p => ({ ...p, error: reason }))
      $.ui.toast(`docker compose ${run.args[0]} failed: ${reason}`, { timeoutMs: 8000 })
      return `docker compose ${run.args.join(' ')} failed: ${reason}`
    }
    $.ui.toast(`docker compose ${run.args.join(' ')}: done`)
    return `docker compose ${run.args.join(' ')}: done`
  } finally {
    runtime.isActing = false
    await update($, panel, p => ({ ...p, busy: null }))
    await refresh($)
  }
}

async function setHidden($: EngineInterface, isHidden: boolean): Promise<string> {
  await $.store.set(HIDDEN_KEY, isHidden)
  await update($, panel, p => ({ ...p, isHidden }))
  return isHidden ? 'Docker band hidden. /docker-panel show brings it back.' : 'Docker band shown.'
}

/** Band buttons; logs go through the command so the output lands in the transcript. */
async function press($: EngineInterface, run: ActionRun): Promise<void> {
  if (run.kind === 'logs') {
    await $.command.run({ command: 'docker', args: `logs ${run.service ?? ''}`.trim() })
    return
  }
  if (run.kind === 'ask') {
    await perform($, run)
    return
  }
  // A compose action can outlast the press's dispatch budget (`down` waits on
  // containers that ignore SIGTERM), so it runs from a timer of its own.
  $.clock.after(0, () => void perform($, run))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    runtime.cwd = e.cwd
    await $.command.register({
      name: 'docker',
      description: 'Docker Compose status and actions for this project',
      argumentHint: '[status|up|down|restart [svc]|rebuild [svc]|logs [svc]]',
    })
    await $.command.register({
      name: 'docker-panel',
      description: 'Show or hide the Docker band above the prompt',
      argumentHint: '[show|hide]',
    })
    const isHidden = (await $.store.get(HIDDEN_KEY).catch(() => false)) === true
    await update($, panel, p => ({ ...p, isHidden }))
    await refresh($)
    void watchEvents($)
    $.clock.every(POLL_MS, () => void refresh($))
    return started
  })

  on('command.run', { command: 'docker' }, async ($, e) => {
    try {
      const run = commandRun(e.args, (await read($, panel)).snapshot)
      if (run?.kind === 'compose') {
        // Same budget concern as a press: the result arrives as a toast and on the band.
        $.clock.after(0, () => void perform($, run))
        return { text: `Running docker compose ${run.args.join(' ')}…` }
      }
      if (run) return { text: await perform($, run) }
      await refresh($)
      const fresh = (await read($, panel)).snapshot
      return { text: fresh ? statusText(fresh) : 'No compose file in this directory, or docker is not reachable.' }
    } catch (err) {
      return { text: `docker-panel: /docker ${e.args} failed: ${String(err)}` }
    }
  })

  on('command.run', { command: 'docker-panel' }, async ($, e) => {
    const verb = e.args.trim()
    if (verb === 'hide' || verb === 'show') return { text: await setHidden($, verb === 'hide') }
    const { isHidden } = await read($, panel)
    return { text: `The Docker band is ${isHidden ? 'hidden' : 'shown'}. Use /docker-panel show or /docker-panel hide.` }
  })

  // A compose file or Dockerfile edited by Claude: check for drift right away.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : null
    if (path && COMPOSE_EDIT.test(path)) scheduleRefresh($, 200)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const state = await read($, panel)
    if (state.availability === 'no-compose' || state.isHidden) return next(e)
    return drawBand($.ui.resolve(e), e.surface, state, {
      onAction: action => void press($, action.run),
      onClose: () => void setHidden($, true),
    })
  })
}

function statusText(snapshot: Snapshot): string {
  const lines = snapshot.services.map(s => {
    const ports = s.ports.length ? ` :${s.ports.join(' :')}` : ''
    const stale = s.stale ? ` (stale: ${s.stale})` : ''
    const trouble = isFailing(s) ? ` — ${failureText(s)}` : ''
    return `- ${s.name}: ${s.statusText}${ports}${stale}${trouble}`
  })
  return `${snapshot.project} (${snapshot.file})\n${lines.join('\n')}`
}
