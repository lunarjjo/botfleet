'use strict'

// command grammar shared by the in-game chat bridge and the web console.
// pure module: no mineflayer, no timers, no network. everything here is
// unit-tested so both input paths accept exactly the same language.

const MAX_COORD = 29999984 // minecraft world border
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/
const MAX_MESSAGE = 256

const COMMANDS = [
  { name: 'come', args: '[player]', help: 'walk to a player (defaults to the commander)' },
  { name: 'follow', args: '<player> | off', help: 'keep following a player, or stop' },
  { name: 'goto', args: '<x> <z> | <x> <y> <z>', help: 'pathfind to coordinates' },
  { name: 'stop', args: '', help: 'halt movement and clear the current task' },
  { name: 'where', args: '', help: 'report current coordinates' },
  { name: 'say', args: '<message>', help: 'send a chat message' },
  { name: 'drop', args: '[all]', help: 'drop one stack, or the whole inventory' },
  { name: 'eat', args: '', help: 'eat once from the inventory' },
  { name: 'help', args: '', help: 'list commands' }
]

function num (token) {
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(token)) return null
  const v = Number(token)
  return Number.isFinite(v) ? v : null
}

function coordError (token) {
  return `"${token}" is not a coordinate`
}

// parse a raw line into { ok, name, args } or { ok: false, error }.
// accepts an optional leading "/" and is case-insensitive.
function parseCommand (raw) {
  const line = String(raw == null ? '' : raw).trim()
  if (line === '') return { ok: false, error: 'empty command' }
  const body = line.startsWith('/') ? line.slice(1) : line
  const parts = body.split(/\s+/)
  const name = parts[0].toLowerCase()
  const rest = parts.slice(1)

  switch (name) {
    case 'come': {
      if (rest.length > 1) return { ok: false, error: 'usage: come [player]' }
      if (rest.length === 1 && !NAME_RE.test(rest[0])) {
        return { ok: false, error: `"${rest[0]}" is not a player name` }
      }
      return { ok: true, name, args: { player: rest[0] || null } }
    }
    case 'follow': {
      if (rest.length !== 1) return { ok: false, error: 'usage: follow <player> | follow off' }
      if (rest[0].toLowerCase() === 'off') return { ok: true, name, args: { player: null } }
      if (!NAME_RE.test(rest[0])) {
        return { ok: false, error: `"${rest[0]}" is not a player name` }
      }
      return { ok: true, name, args: { player: rest[0] } }
    }
    case 'goto': {
      if (rest.length !== 2 && rest.length !== 3) {
        return { ok: false, error: 'usage: goto <x> <z> | goto <x> <y> <z>' }
      }
      const x = num(rest[0])
      if (x === null) return { ok: false, error: coordError(rest[0]) }
      let y = null
      let z
      if (rest.length === 3) {
        y = num(rest[1])
        if (y === null) return { ok: false, error: coordError(rest[1]) }
        z = num(rest[2])
      } else {
        z = num(rest[1])
      }
      if (z === null) return { ok: false, error: coordError(rest[rest.length - 1]) }
      for (const v of [x, y, z]) {
        if (v !== null && Math.abs(v) > MAX_COORD) {
          return { ok: false, error: `coordinates must stay within ${MAX_COORD}` }
        }
      }
      return { ok: true, name, args: { x, y, z } }
    }
    case 'stop':
    case 'where':
    case 'eat':
    case 'help': {
      if (rest.length !== 0) return { ok: false, error: `${name} takes no arguments` }
      return { ok: true, name, args: {} }
    }
    case 'say': {
      const message = rest.join(' ')
      if (message === '') return { ok: false, error: 'usage: say <message>' }
      if (message.length > MAX_MESSAGE) {
        return { ok: false, error: `message longer than ${MAX_MESSAGE} characters` }
      }
      return { ok: true, name, args: { message } }
    }
    case 'drop': {
      if (rest.length > 1) return { ok: false, error: 'usage: drop [all]' }
      if (rest.length === 1 && rest[0].toLowerCase() !== 'all') {
        return { ok: false, error: 'usage: drop [all]' }
      }
      return { ok: true, name, args: { all: rest.length === 1 } }
    }
    default: {
      const hint = suggest(name)
      return { ok: false, error: hint ? `unknown command "${name}" — did you mean "${hint}"?` : `unknown command "${name}"` }
    }
  }
}

function suggest (name) {
  for (const c of COMMANDS) {
    if (c.name.startsWith(name.slice(0, 3))) return c.name
  }
  return null
}

function helpLines () {
  return COMMANDS.map(c => (c.args ? `${c.name} ${c.args} — ${c.help}` : `${c.name} — ${c.help}`))
}

module.exports = { parseCommand, COMMANDS, helpLines, MAX_COORD, NAME_RE, MAX_MESSAGE }
