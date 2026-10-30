'use strict'

const { EventEmitter } = require('events')
const { parseCommand, helpLines } = require('../util/commands')
const { loadBlueprint } = require('../util/blueprintStore')
const { attachNavigator } = require('./plugins/navigator')
const { attachScout } = require('./plugins/scout')
const { attachSurvivor } = require('./plugins/survivor')
const { attachCommander } = require('./plugins/commander')

const HEARTBEAT_MS = 1000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000

// one named bot ("unit") of the fleet. owns the mineflayer instance, the
// plugin set, the heartbeat and the reconnect loop. emits:
//   'state'  — full snapshot, at least once per second
//   'log'    — { text } one console line for the web feed
//   'event'  — { kind, text, data? } chat / death / kicked / spawn / end
//   'radar'  — frame objects produced by the scout plugin
class Unit extends EventEmitter {
  constructor (opts, deps) {
    super()
    const o = opts || {}
    this.deps = deps
    this.name = o.name
    this.host = o.host || '127.0.0.1'
    this.port = o.port || 25565
    this.version = o.version || false
    this.autoReconnect = o.autoReconnect !== false

    this.bot = null
    this.status = 'offline' // spawning | online | reconnecting | offline
    this.spawnedAt = 0
    this.reconnectAttempts = 0
    this.stopped = true
    this.timers = new Set()
    this.plugins = []

    this.navigator = null
    this.scout = null
    this.survivor = null
  }

  // ---- lifecycle -------------------------------------------------------

  connect () {
    this.stopped = false
    this.reconnectAttempts = 0
    this._spawnBot()
  }

  _spawnBot () {
    this.status = this.reconnectAttempts > 0 ? 'reconnecting' : 'spawning'
    this._emitState()

    const bot = this.deps.createBot({
      host: this.host,
      port: this.port,
      username: this.name,
      version: this.version || false,
      auth: 'offline',
      hideErrors: true
    })
    this.bot = bot

    bot.once('spawn', () => this._onSpawn())
    bot.on('end', () => this._onEnd())
    bot.on('kicked', (reason) => {
      this.emit('event', { kind: 'kicked', text: `kicked: ${String(reason).slice(0, 200)}` })
    })
    bot.on('error', (err) => {
      this.emit('event', { kind: 'error', text: `error: ${String(err.message || err).slice(0, 200)}` })
    })
    bot.on('death', () => {
      this.emit('event', { kind: 'death', text: 'died' })
      this._emitState()
    })
    bot.on('health', () => this._emitState())
  }

  _onSpawn () {
    this.status = 'online'
    this.spawnedAt = Date.now()
    this.reconnectAttempts = 0
    this.emit('event', { kind: 'spawn', text: `spawned at ${this._posText()}` })

    this.navigator = attachNavigator(this, this.bot)
    this.scout = attachScout(this, this.bot)
    this.survivor = attachSurvivor(this, this.bot)
    this.plugins = [this.navigator, this.scout, this.survivor, attachCommander(this, this.bot)]

    const hb = setInterval(() => this._emitState(), HEARTBEAT_MS)
    this.timers.add(hb)
    this._emitState()
  }

  _onEnd () {
    this._clearPlugins()
    this.navigator = null
    this.scout = null
    this.survivor = null
    this.bot = null

    if (this.stopped || !this.autoReconnect) {
      this.status = 'offline'
      this.emit('event', { kind: 'end', text: 'disconnected' })
      this._emitState()
      return
    }

    this.reconnectAttempts += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS)
    this.status = 'reconnecting'
    this.emit('event', { kind: 'end', text: `disconnected — reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})` })
    this._emitState()

    const t = setTimeout(() => {
      if (!this.stopped) this._spawnBot()
    }, delay)
    this.timers.add(t)
  }

  stop () {
    this.stopped = true
    this._clearPlugins()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    if (this.bot) {
      try { this.bot.quit() } catch (e) { /* socket already gone */ }
      this.bot = null
    }
    this.status = 'offline'
    this._emitState()
  }

  _clearPlugins () {
    for (const p of this.plugins) {
      try { p && p.dispose && p.dispose() } catch (e) { /* ignore */ }
    }
    this.plugins = []
  }

  // ---- state -----------------------------------------------------------

  _pos () {
    const e = this.bot && this.bot.entity
    if (!e || !e.position) return null
    const p = e.position
    return { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) }
  }

  _posText () {
    const p = this._pos()
    return p ? `${p.x} ${p.y} ${p.z}` : 'unknown'
  }

  snapshot () {
    const bot = this.bot
    let players = []
    let entities = 0
    if (bot && bot.entity) {
      if (bot.players) players = Object.keys(bot.players).filter((n) => n !== this.name)
      if (bot.entities) entities = Object.keys(bot.entities).length
    }
    const p = this._pos()
    const nav = this.navigator
    return {
      name: this.name,
      status: this.status,
      host: this.host,
      port: this.port,
      version: bot && bot.version ? bot.version : (this.version || 'auto'),
      uptime: this.status === 'online' && this.spawnedAt ? Math.floor((Date.now() - this.spawnedAt) / 1000) : 0,
      reconnectAttempts: this.reconnectAttempts,
      health: bot && typeof bot.health === 'number' ? bot.health : null,
      food: bot && typeof bot.food === 'number' ? bot.food : null,
      position: p,
      yaw: bot && bot.entity && typeof bot.entity.yaw === 'number' ? +bot.entity.yaw.toFixed(2) : null,
      task: nav ? nav.task : 'idle',
      pilot: nav && nav.pilotInfo ? nav.pilotInfo() : null,
      path: nav && nav.pathPoints ? nav.pathPoints() : [],
      players,
      entities
    }
  }

  _emitState () {
    this.emit('state', this.snapshot())
  }

  log (text) {
    this.emit('log', { text: String(text) })
  }

  reply (text, source) {
    if (source && source !== 'web' && this.bot) {
      try { this.bot.chat(text) } catch (e) { /* not spawned */ }
    }
    this.log(text)
  }

  // ---- commands --------------------------------------------------------

  async command (text, source = 'web') {
    const parsed = parseCommand(text)
    if (!parsed.ok) {
      this.reply(`invalid command: ${parsed.error} — try "help"`, source)
      return { ok: false, error: parsed.error }
    }
    const { name, args } = parsed
    try {
      switch (name) {
        case 'help': {
          for (const line of helpLines()) this.log(line)
          return { ok: true, reply: `${helpLines().length} commands — see console feed` }
        }
        case 'where': {
          const s = this.snapshot()
          const at = s.position ? `i am at ${s.position.x} ${s.position.y} ${s.position.z}` : 'i have no position yet'
          this.reply(`${at} (task: ${s.task})`, source)
          return { ok: true, reply: at }
        }
        case 'say': {
          if (!this.bot || !this.bot.entity) throw new Error('not online')
          this.bot.chat(args.message)
          this.log(`said: ${args.message}`)
          return { ok: true, reply: 'sent' }
        }
        case 'stop': {
          if (this.navigator) this.navigator.stop()
          this.log('halted')
          return { ok: true, reply: 'stopped' }
        }
        case 'goto': {
          if (!this.navigator) throw new Error('not online')
          return this.navigator.goto(args.x, args.y, args.z, source)
        }
        case 'mine': {
          if (!this.navigator) throw new Error('not online')
          return this.navigator.mine([args.block], args.count, source)
        }
        case 'build': {
          if (!this.navigator) throw new Error('not online')
          return this.navigator.build(args, source)
        }
        case 'farm': {
          if (!this.navigator) throw new Error('not online')
          return this.navigator.farm(args.radius, source)
        }
        case 'explore': {
          if (!this.navigator) throw new Error('not online')
          return this.navigator.explore(args.radius, source)
        }
        case 'set': {
          if (!this.navigator) throw new Error('not online')
          return this.navigator.set(args.key, args.value, source)
        }
        case 'come': {
          if (!this.navigator) throw new Error('not online')
          return this.navigator.come(args.player || (source !== 'web' ? source : null), source)
        }
        case 'follow': {
          if (!this.navigator) throw new Error('not online')
          return this.navigator.follow(args.player, source)
        }
        case 'drop': {
          if (!this.bot || !this.bot.inventory) throw new Error('not online')
          const items = this.bot.inventory.items()
          if (items.length === 0) { this.reply('inventory is empty', source); return { ok: true, reply: 'empty' } }
          const victims = args.all ? items : [items[0]]
          for (const it of victims) await this.bot.tossStack(it)
          this.log(`dropped ${victims.length} stack(s)`)
          return { ok: true, reply: `dropped ${victims.length}` }
        }
        case 'eat': {
          if (!this.survivor) throw new Error('not online')
          return this.survivor.eatOnce(source)
        }
        default:
          throw new Error(`unhandled command "${name}"`)
      }
    } catch (err) {
      const msg = String(err.message || err)
      this.reply(`command failed: ${msg}`, source)
      return { ok: false, error: msg }
    }
  }
}

module.exports = { Unit, HEARTBEAT_MS }
