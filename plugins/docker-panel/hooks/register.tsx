import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PaneView, Panel, Snapshot } from '../types'
import type { ActionRun } from './actions'
import { askPrompt, commandRun } from './actions'
import { drawBand } from './band'
import { failureText, isFailing, isRelevantEvent, newFailures, parseStats } from './compose'
import type { Host } from './docker'
import { collect, findComposeFile, lastLine, logTail, projectDirKey, resolveProjectDir } from './docker'
import { CARD_LOG_LINES, PANE_ID, drawPane } from './pane'

const INITIAL: Panel = {
  availability: 'no-compose',
  snapshot: null,
  stats: null,
  busy: null,
  error: null,
  isHidden: false,
}
const HIDDEN_KEY = 'isHidden'
const panel = atom({ plugin: 'docker-panel', key: 'panel' } as const, INITIAL)
const paneView = atom({ plugin: 'docker-panel', key: 'pane' } as const, { expanded: [], logs: {} } as PaneView)

/** Fallback poll: catches edits made outside Claude and anything events missed. */
const POLL_MS = 15_000
/** `docker stats --no-stream` takes about two seconds, so it samples on its own timer. */
const STATS_MS = 10_000
/** How often an open control pane follows the logs of its unfolded cards. */
const LOGS_FOLLOW_MS = 2_000
const EVENT_DEBOUNCE_MS = 400
const EVENTS_RETRY_MS = 10_000
const ACTION_TIMEOUT_MS = 600_000
const COMMAND_LOG_LINES = 40
const COMPOSE_EDIT = /(^|\/)((docker-)?compose[^/]*\.ya?ml|Dockerfile[^/]*|\.env)$/

/** Module-lifetime bookkeeping; a hot reload starts it over, the band's data lives in `panel`. */
const runtime: {
  /** The directory the session runs in. */
  sessionCwd: string
  /** The compose project the band follows: the session's directory unless `/docker-panel use` moved it. */
  cwd: string
  isRefreshing: boolean
  isRefreshPending: boolean
  isActing: boolean
  debounce: Timer | null
  /** Bumped to retire the running events watcher when the project directory changes. */
  eventsGeneration: number
  events: AsyncGenerator<unknown, unknown> | null
} = {
  sessionCwd: '',
  cwd: '',
  isRefreshing: false,
  isRefreshPending: false,
  isActing: false,
  debounce: null,
  eventsGeneration: 0,
  events: null,
}

const QUERY_TIMEOUT_MS = 15_000

function hostFor($: EngineInterface, dir: string = runtime.cwd): Host {
  return {
    cwd: dir,
    docker: args => $.process.run(['docker', ...args], { cwd: dir, timeoutMs: QUERY_TIMEOUT_MS }),
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

async function refreshStats($: EngineInterface): Promise<void> {
  try {
    const snapshot = (await read($, panel)).snapshot
    const ids = snapshot?.services.flatMap(s => (s.status === 'exited' || s.status === 'absent' ? [] : s.containerIds))
    if (!snapshot || !ids?.length) {
      await update($, panel, (p): Panel => ({ ...p, stats: null }))
      return
    }
    const out = await hostFor($).docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids])
    if (out.exitCode !== 0) return
    const stats = parseStats(out.stdout, snapshot)
    await update($, panel, (p): Panel => ({ ...p, stats }))
  } catch (err) {
    $.ui.log(`docker-panel: stats failed: ${String(err)}`, { to: 'debug' })
  }
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE_ID)
}

/** Fetches the logs of every unfolded card. */
async function refreshCardLogs($: EngineInterface): Promise<void> {
  try {
    const { expanded } = await read($, paneView)
    const fetched = await Promise.all(
      expanded.map(async name => [name, await logTail(hostFor($), name, CARD_LOG_LINES)] as const),
    )
    await update($, paneView, (view): PaneView => ({ ...view, logs: { ...view.logs, ...Object.fromEntries(fetched) } }))
  } catch (err) {
    $.ui.log(`docker-panel: logs failed: ${String(err)}`, { to: 'debug' })
  }
}

/** Opens the control pane, unfolding `service`'s logs when one is named; says whether it was placed. */
async function openControl($: EngineInterface, service: string | null): Promise<boolean> {
  if (service) {
    await update($, paneView, (view): PaneView =>
      view.expanded.includes(service) ? view : { ...view, expanded: [...view.expanded, service] },
    )
    await refreshCardLogs($)
  }
  const project = (await read($, panel)).snapshot?.project ?? 'compose'
  const opened = await $.ui.open({ id: PANE_ID, title: `Docker · ${project}` })
  return opened.isPlaced
}

async function toggleLogs($: EngineInterface, service: string): Promise<void> {
  await update($, paneView, (view): PaneView => ({
    ...view,
    expanded: view.expanded.includes(service)
      ? view.expanded.filter(name => name !== service)
      : [...view.expanded, service],
  }))
  await refreshCardLogs($)
}

function scheduleRefresh($: EngineInterface, ms: number): void {
  runtime.debounce?.cancel()
  runtime.debounce = $.clock.after(ms, () => void refresh($))
}

/** Follows `docker compose events` for the session; starts it again when it ends. */
async function watchEvents($: EngineInterface, generation: number): Promise<void> {
  try {
    if (await findComposeFile(hostFor($))) {
      let buffered = ''
      const events = $.process.spawn({ argv: ['docker', 'compose', 'events', '--json'], cwd: runtime.cwd })
      // Closing the stream early rejects `result`; that is how a retired watcher ends.
      events.result.catch(() => undefined)
      runtime.events = events
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
  if (generation === runtime.eventsGeneration) {
    $.clock.after(EVENTS_RETRY_MS, () => void watchEvents($, generation))
  }
}

/** Starts a fresh events watcher for `runtime.cwd`, retiring the one before it. */
function restartEvents($: EngineInterface): void {
  runtime.eventsGeneration += 1
  void runtime.events?.return(undefined)
  runtime.events = null
  void watchEvents($, runtime.eventsGeneration)
}

/** `/docker-panel use <dir>`: follow the compose project in `dir`, remembered for this session directory. */
async function useProjectDir($: EngineInterface, arg: string): Promise<string> {
  const dir = resolveProjectDir(runtime.sessionCwd, arg)
  const file = await findComposeFile(hostFor($, dir))
  if (!file) return `No compose file in ${dir}.`
  runtime.cwd = dir
  await $.store.set(projectDirKey(runtime.sessionCwd), dir)
  restartEvents($)
  await refresh($)
  return `The Docker band now follows ${dir}/${file}.`
}

async function perform($: EngineInterface, run: ActionRun): Promise<string> {
  const snapshot = (await read($, panel)).snapshot
  if (run.kind === 'ask') {
    if (!snapshot) return 'No compose project here.'
    await $.prompt.fill({ text: askPrompt(snapshot, run.service), mode: 'append' })
    return `Put ${run.service}'s failure into the prompt.`
  }
  if (run.kind === 'more') {
    // Where no pane can be placed, the logs come into the transcript instead.
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

async function followLogs($: EngineInterface): Promise<void> {
  if ((await read($, paneView)).expanded.length > 0 && (await isPaneOpen($))) await refreshCardLogs($)
}

/** `/docker [status|up|down|restart|rebuild|logs] [svc]`. */
async function dockerCommand($: EngineInterface, args: string): Promise<string> {
  const run = commandRun(args, (await read($, panel)).snapshot)
  if (run?.kind === 'compose') {
    // Same budget concern as a press: the result arrives as a toast and on the band.
    $.clock.after(0, () => void perform($, run))
    return `Running docker compose ${run.args.join(' ')}…`
  }
  if (run?.kind === 'more') {
    if (await openControl($, run.service)) return 'Opened the Docker control pane.'
    return perform($, run)
  }
  if (run) return perform($, run)
  await refresh($)
  const fresh = (await read($, panel)).snapshot
  return fresh ? statusText(fresh) : 'No compose file in this directory, or docker is not reachable.'
}

/** `/docker-panel [show|hide|use <dir>]`. */
async function panelCommand($: EngineInterface, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  if (verb === 'hide' || verb === 'show') return setHidden($, verb === 'hide')
  if (verb === 'use') return useProjectDir($, rest.join(' '))
  const { isHidden } = await read($, panel)
  return (
    `The Docker band is ${isHidden ? 'hidden' : 'shown'} and follows ${runtime.cwd}. ` +
    'Use /docker-panel show, hide, or use <dir>.'
  )
}

/** Band buttons: Logs opens the pane, compose actions run off a timer. */
async function press($: EngineInterface, run: ActionRun): Promise<void> {
  if (run.kind === 'more') {
    await openControl($, run.service)
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
    runtime.sessionCwd = e.cwd
    const saved = await $.store.get(projectDirKey(e.cwd)).catch(() => undefined)
    runtime.cwd = typeof saved === 'string' ? saved : e.cwd
    await $.command.register({
      name: 'docker',
      description: 'Docker Compose status and actions for this project',
      argumentHint: '[status|more|up|down|start|stop|restart|rebuild|logs [svc]]',
    })
    await $.command.register({
      name: 'docker-panel',
      description: 'Show or hide the Docker band, or point it at a compose project in another directory',
      argumentHint: '[show|hide|use <dir>]',
    })
    const isHidden = (await $.store.get(HIDDEN_KEY).catch(() => false)) === true
    await update($, panel, p => ({ ...p, isHidden }))
    await refresh($)
    restartEvents($)
    void refreshStats($)
    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(STATS_MS, () => void refreshStats($))
    $.clock.every(LOGS_FOLLOW_MS, () => void followLogs($))
    return started
  })

  // One hook for both commands, matched by name inside: a session may spell a
  // plugin's command with its plugin prefix (`docker-panel:docker`).
  on('command.run', async ($, e, next) => {
    const name = e.command.replace(/^docker-panel:/, '')
    try {
      if (name === 'docker') return { text: await dockerCommand($, e.args) }
      if (name === 'docker-panel') return { text: await panelCommand($, e.args) }
    } catch (err) {
      return { text: `docker-panel: /${name} ${e.args} failed: ${String(err)}` }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const [state, view] = [await read($, panel), await read($, paneView)]
    return drawPane($.ui.resolve(e), e.surface, state, view, {
      onAction: action => void press($, action.run),
      onToggleLogs: service => void toggleLogs($, service),
    })
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
