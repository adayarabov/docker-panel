// The band above the prompt. Row one carries what matters at a glance (project,
// how many services are up, CPU/RAM, the problem if any, actions and ×); the
// service chips start on row two and wrap. Per-service detail and control live
// in the pane that More opens.
import type { Elements, RenderSurface } from 'claude-code'

import type { Panel, Service, ServiceStatus, Stats } from '../types'
import type { Action } from './actions'
import { actionsFor, noteFor } from './actions'
import { formatUsage, isFailing, isRunning, severityOf, upSummary } from './compose'

export type Els = Elements[RenderSurface]

/**
 * Docker blue for the brand mark and accents, neutral grey for chips and frames
 * so the colour stays on what matters. Docker's brand defines no status colours,
 * so green, amber and red stay semantic, toned to sit beside the blue.
 */
export const COLOR = {
  ok: '#3ec48a',
  warn: '#f4b740',
  bad: '#f05d5e',
  idle: '#7a8ba8',
  accent: '#2496ed',
  frame: '#4a505c',
  cardFrame: '#4a505c',
  chip: '#262a33',
  /** Text on a chip: a soft grey in the chip's own tone rather than plain white. */
  chipText: '#d6d9df',
}

const GLYPH: Record<ServiceStatus, string> = {
  healthy: '●',
  running: '●',
  starting: '◐',
  restarting: '✕',
  unhealthy: '✕',
  exited: '○',
  stopped: '○',
  created: '○',
  paused: '◌',
  absent: '○',
}

const MAX_LOG_LINE = 200
export const ERROR_LINE = /error|fatal|panic|exception|traceback/i

export function statusColor(service: Service): string {
  if (isFailing(service)) return COLOR.bad
  if (service.status === 'healthy' || service.status === 'running') return COLOR.ok
  if (service.status === 'starting') return COLOR.warn
  return COLOR.idle
}

export function glyphOf(service: Service): string {
  return isFailing(service) ? '✕' : GLYPH[service.status]
}

function chipDetail(service: Service): string | null {
  if (service.status === 'exited' && service.exitCode !== 0) {
    return service.restarts ? `exited(${service.exitCode}) ↻${service.restarts}` : `exited(${service.exitCode})`
  }
  if (service.status === 'unhealthy' || service.status === 'restarting' || service.status === 'starting') {
    return service.restarts ? `${service.status} ↻${service.restarts}` : service.status
  }
  if (service.stale) return 'stale'
  return null
}

/** The verb of an action running on this one service ("stopping"), or null. */
export function pendingVerb(panel: Panel, service: Service): string | null {
  return panel.busyService === service.name ? panel.busyVerb : null
}

function Chip(els: Els, surface: RenderSurface, service: Service, pending: string | null) {
  const { Box, Text } = els
  const isTerminal = surface === 'terminal'
  const detail = pending ? `${pending}…` : chipDetail(service)
  const color = pending ? COLOR.warn : statusColor(service)
  return (
    <Box
      key={`chip-${service.name}`}
      flexDirection="row"
      flexShrink={0}
      paddingX={isTerminal ? 1 : 0}
      backgroundColor={isTerminal ? COLOR.chip : undefined}
    >
      <Text color={color}>{pending ? '◐' : glyphOf(service)} </Text>
      <Text color={isTerminal ? COLOR.chipText : undefined} dimColor={!isFailing(service) && !isRunning(service)}>
        {service.name}
      </Text>
      {detail && <Text color={color}> {detail}</Text>}
    </Box>
  )
}

function ActionButton(els: Els, action: Action, onPress: (action: Action) => void) {
  const { Button } = els
  return (
    <Button
      key={`act-${action.key}`}
      label={action.label}
      hotkey={action.hotkey}
      variant={action.isPrimary ? 'primary' : undefined}
      onPress={() => onPress(action)}
    />
  )
}

export type BandHandlers = {
  onAction: (action: Action) => void
  /** The corner ×: hides the band until `/docker-panel show`. */
  onClose: () => void
}

/**
 * The desktop's ×. The terminal draws its own `[-]` collapse mark on every band,
 * so a second control there would only crowd it; `/docker-panel hide` remains.
 */
function CloseButton(els: Els, surface: RenderSurface, onClose: () => void) {
  if (surface === 'terminal') return null
  const { Button } = els
  return <Button key="close" label="×" plain role="dismiss" dimColor onPress={onClose} />
}

/** The terminal gets a bordered panel; the desktop frames the band in its own card. */
function frameProps(surface: RenderSurface, color: string) {
  const isTerminal = surface === 'terminal'
  return {
    borderStyle: isTerminal ? 'round' : undefined,
    borderColor: isTerminal ? color : undefined,
    paddingX: isTerminal ? 1 : 0,
  }
}

export function drawBand(els: Els, surface: RenderSurface, panel: Panel, handlers: BandHandlers) {
  const { Box, Text } = els

  if (panel.availability === 'no-daemon' || !panel.snapshot) {
    return (
      <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" {...frameProps(surface, COLOR.frame)}>
        <Box flexDirection="row">
          <Text color={COLOR.accent}>⬢ docker </Text>
          <Text dimColor>{panel.daemonError ?? 'daemon is not reachable'}</Text>
        </Box>
        {CloseButton(els, surface, handlers.onClose)}
      </Box>
    )
  }

  const snapshot = panel.snapshot
  const isTerminal = surface === 'terminal'
  const severity = severityOf(snapshot)
  const frame = severity === 'failing' ? COLOR.bad : severity === 'stale' ? COLOR.warn : COLOR.frame
  const note = panel.error ?? noteFor(snapshot)
  const noteColor = panel.error || severity === 'failing' ? COLOR.bad : severity === 'stale' ? COLOR.warn : COLOR.idle
  const showsNote = note !== null && severity !== 'down'

  return (
    <Box flexDirection="column" {...frameProps(surface, frame)}>
      <Box key="summary" flexDirection="row" flexWrap="nowrap" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row" flexShrink={1} minWidth={0} columnGap={2}>
          <Text bold color={COLOR.accent} wrap="truncate-end">
            ⬢ {snapshot.project}
          </Text>
          <Text dimColor>{upSummary(snapshot)}</Text>
          {panel.stats && severity !== 'down' && <Text dimColor>{formatUsage(panel.stats.total)}</Text>}
          {showsNote && (
            <Text bold={severity === 'failing'} color={noteColor} wrap="truncate-end">
              ▲ {note}
            </Text>
          )}
        </Box>
        <Box flexDirection="row" flexShrink={0} columnGap={1}>
          {panel.busy ? (
            <Text color={COLOR.accent}>… {panel.busy}</Text>
          ) : (
            actionsFor(snapshot, { isPaneOpen: panel.isPaneOpen }).map(action =>
              ActionButton(els, action, handlers.onAction),
            )
          )}
          {CloseButton(els, surface, handlers.onClose)}
        </Box>
      </Box>
      <Box key="services" flexDirection="row" flexWrap="wrap" columnGap={isTerminal ? 1 : 2}>
        {snapshot.services.map(service => Chip(els, surface, service, pendingVerb(panel, service)))}
      </Box>
    </Box>
  )
}
