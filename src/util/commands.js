'use strict'

// command grammar shared by the in-game chat bridge and the web console.
// pure module: no mineflayer, no timers, no network. everything here is
// unit-tested so both input paths accept exactly the same language.

const MAX_COORD = 29999984 // minecraft world border
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/
const MAX_MESSAGE = 256
const BLOCK_NAME_RE = /^[a-z0-9_]+$/
const MAX_MINE_COUNT = 64
const BLUEPRINT_NAME_RE = /^[a-z0-9_-]{1,48}$/

const COMMANDS = [
  { name: 'come', args: '[player]', help: 'walk to a player (defaults to the commander)' },
  { name: 'follow', args: '<player> | off', help: 'keep following a player, or stop' },
  { name: 'goto', args: '<x> <z> | <x> <y> <z>', help: 'pathfind to coordinates' },
  { name: 'mine', args: '<block> [count]', help: 'pathfind to and dig blocks by name' },
  { name: 'build', args: '<blueprint> [x y z]', help: 'construct a saved blueprint here or at coords' },
  { name: 'farm', args: '[radius]', help: 'harvest and replant mature crops nearby' },
  { name: 'explore', args: '[radius]', help: 'roam unvisited chunk targets within a radius' },
  { name: 'set', args: '<key> <value>', help: 'tune a pilot setting (allowPlace, allowParkour, ...)' },
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
    case 'mine': {
      if (rest.length < 1 || rest.length > 2) return { ok: false, error: 'usage: mine <block> [count]' }
      const block = rest[0].toLowerCase()
      if (!BLOCK_NAME_RE.test(block)) {
        return { ok: false, error: `"${rest[0]}" is not a block name` }
      }
      let count = 1
      if (rest.length === 2) {
        if (!/^\d+$/.test(rest[1]) || Number(rest[1]) < 1 || Number(rest[1]) > MAX_MINE_COUNT) {
          return { ok: false, error: `count must be 1-${MAX_MINE_COUNT}` }
        }
        count = Number(rest[1])
      }
      return { ok: true, name, args: { block, count } }
    }
    case 'build': {
      if (rest.length < 1 || rest.length > 4) {
        return { ok: false, error: 'usage: build <blueprint> [x y z]' }
      }
      const blueprint = rest[0].toLowerCase()
      if (!BLUEPRINT_NAME_RE.test(blueprint)) {
        return { ok: false, error: `"${rest[0]}" is not a blueprint name` }
      }
      const coords = []
      for (const tok of rest.slice(1)) {
        const v = num(tok)
        if (v === null) return { ok: false, error: coordError(tok) }
        coords.push(v)
      }
      if (coords.length !== 0 && coords.length !== 2 && coords.length !== 3) {
        return { ok: false, error: 'usage: build <blueprint> [x y z]' }
      }
      const args = { blueprint, x: null, y: null, z: null }
      if (coords.length === 2) {
        args.x = coords[0]
        args.z = coords[1] // x z form: the y level comes from the unit
      } else if (coords.length === 3) {
        args.x = coords[0]
        args.y = coords[1]
        args.z = coords[2]
      }
      return { ok: true, name, args }
    }
    case 'farm':
    case 'explore': {
      const cap = name === 'farm' ? 48 : 256
      if (rest.length > 1) return { ok: false, error: `usage: ${name} [radius]` }
      let radius = null
      if (rest.length === 1) {
        if (!/^\d+$/.test(rest[0]) || Number(rest[0]) < 1 || Number(rest[0]) > cap) {
          return { ok: false, error: `radius must be 1-${cap}` }
        }
        radius = Number(rest[0])
      }
      return { ok: true, name, args: { radius } }
    }
    case 'set': {
      if (rest.length !== 2) return { ok: false, error: 'usage: set <key> <value>' }
      return { ok: true, name, args: { key: rest[0], value: rest[1] } }
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
