// The band above the prompt: a bordered panel of service chips and actions.
// Hovering a chip reveals that service's details above the chip row; the
// surface does it alone (a hover scope), so no hook runs on hover.
import type { Elements, RenderSurface } from 'claude-code'

import type { Panel, Service, ServiceStatus } from '../types'
import type { Action } from './actions'
import { actionsFor, noteFor } from './actions'
import { isFailing, severityOf } from './compose'

type Els = Elements[RenderSurface]

const COLOR = {
  ok: '#5ccf8a',
  warn: '#e8b64c',
  bad: '#f07070',
  idle: '#7b8290',
  accent: '#6ea2ff',
  frame: '#4a505c',
  chip: '#262a33',
  chipHot: '#3a4252',
}

const GLYPH: Record<ServiceStatus, string> = {
  healthy: '●',
  running: '●',
  starting: '◐',
  restarting: '✕',
  unhealthy: '✕',
  exited: '○',
  created: '○',
  paused: '◌',
  absent: '○',
}

const MAX_LOG_LINE = 200
const ERROR_LINE = /error|fatal|panic|exception|traceback/i

function statusColor(service: Service): string {
  if (isFailing(service)) return COLOR.bad
  if (service.status === 'healthy' || service.status === 'running') return COLOR.ok
  if (service.status === 'starting') return COLOR.warn
  return COLOR.idle
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

function scopeOf(service: Service): string {
  return `svc-${service.name}`.slice(0, 64)
}

function Chip(els: Els, surface: RenderSurface, service: Service) {
  const { Box, Text, Link } = els
  const isTerminal = surface === 'terminal'
  const detail = chipDetail(service)
  const scope = scopeOf(service)
  return (
    <Box
      key={`chip-${service.name}`}
      flexDirection="row"
      paddingX={isTerminal ? 1 : 0}
      backgroundColor={isTerminal ? COLOR.chip : undefined}
      hover={isTerminal ? { scope, backgroundColor: COLOR.chipHot } : { scope }}
    >
      <Text color={statusColor(service)}>{isFailing(service) ? '✕' : GLYPH[service.status]} </Text>
      <Text dimColor={!isFailing(service) && (service.status === 'absent' || service.status === 'exited')}>
        {service.name}
      </Text>
      {service.ports.map(port => (
        <Text dimColor>
          :<Link href={`http://localhost:${port}`}>{String(port)}</Link>
        </Text>
      ))}
      {detail && <Text color={statusColor(service)}> {detail}</Text>}
    </Box>
  )
}

function Details(els: Els, service: Service) {
  const { Box, Text } = els
  const facts = [
    service.statusText,
    service.restarts ? `${service.restarts} restarts` : null,
    service.stale === 'config' ? 'compose config changed since start' : null,
    service.stale === 'image' ? 'Dockerfile changed since image build' : null,
  ].filter(Boolean)
  return (
    <Box
      flexDirection="column"
      display="none"
      hover={{ scope: scopeOf(service), display: 'flex' }}
      paddingBottom={1}
    >
      <Text wrap="truncate-end">
        <Text bold color={statusColor(service)}>
          {service.name}
        </Text>
        <Text dimColor> · {facts.join(' · ')}</Text>
      </Text>
      {service.logTail.map(line => {
        const isError = ERROR_LINE.test(line)
        return (
          <Text dimColor={!isError} color={isError ? COLOR.bad : undefined} wrap="truncate-end">
            {line.slice(0, MAX_LOG_LINE)}
          </Text>
        )
      })}
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

function CloseButton(els: Els, onClose: () => void) {
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
      <Box flexDirection="row" justifyContent="space-between" {...frameProps(surface, COLOR.frame)}>
        <Box flexDirection="row">
          <Text color={COLOR.accent}>⬢ docker </Text>
          <Text dimColor>{panel.error ?? 'daemon is not reachable'}</Text>
        </Box>
        {CloseButton(els, handlers.onClose)}
      </Box>
    )
  }

  const snapshot = panel.snapshot
  const isTerminal = surface === 'terminal'
  const severity = severityOf(snapshot)
  const frame = severity === 'failing' ? COLOR.bad : severity === 'stale' ? COLOR.warn : COLOR.frame
  const note = panel.error ?? noteFor(snapshot)
  const noteColor = panel.error || severity === 'failing' ? COLOR.bad : severity === 'stale' ? COLOR.warn : COLOR.idle

  const controls = panel.busy ? (
    <Text color={COLOR.accent}>… {panel.busy}</Text>
  ) : (
    actionsFor(snapshot).map(action => ActionButton(els, action, handlers.onAction))
  )

  // Row one: chips on the left, wrapping inside their own column, and the
  // corner × pinned top right. With nothing to report the actions sit beside
  // the ×; with a note, row two carries the note left and the actions right.
  return (
    <Box flexDirection="column" {...frameProps(surface, frame)}>
      {snapshot.services.map(service => Details(els, service))}
      <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="flex-start" columnGap={2}>
        <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1} minWidth={0} columnGap={isTerminal ? 1 : 2}>
          <Text bold color={COLOR.accent}>
            ⬢ {snapshot.project}
          </Text>
          {snapshot.services.map(service => Chip(els, surface, service))}
        </Box>
        <Box flexDirection="row" flexShrink={0} columnGap={1}>
          {!note && controls}
          {CloseButton(els, handlers.onClose)}
        </Box>
      </Box>
      {note && (
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
          <Text bold={severity === 'failing'} color={noteColor}>
            {severity === 'down' ? note : `▲ ${note}`}
          </Text>
          <Box flexDirection="row" flexShrink={0} columnGap={1}>
            {controls}
          </Box>
        </Box>
      )}
    </Box>
  )
}
