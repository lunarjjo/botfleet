'use strict'

const { EventEmitter } = require('events')
const { Unit } = require('./unit')
const real = require('./real')
const { NAME_RE } = require('../util/commands')

function httpError (statusCode, message) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

const HOST_RE = /^[A-Za-z0-9_.:-]{1,253}$/
const VERSION_RE = /^\d+\.\d+(\.\d+)?$/

// the fleet: a registry of named units plus the event hub that turns
// per-unit signals into broadcast frames for the websocket gateway.
class Fleet extends EventEmitter {
  constructor (deps) {
    super()
    this.deps = deps || real
    this.units = new Map()
    this.startedAt = Date.now()
  }

  add (opts) {
    const o = opts || {}
    const name = String(o.name || '')
    if (!NAME_RE.test(name)) throw httpError(400, 'name must match [A-Za-z0-9_]{1,16}')
    const host = String(o.host || '127.0.0.1')
    if (!HOST_RE.test(host)) throw httpError(400, 'host looks invalid')
    const port = Number(o.port || 25565)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'port must be an integer between 1 and 65535')
    let version = o.version || false
    if (version !== false && !VERSION_RE.test(String(version))) throw httpError(400, 'version must look like "1.21.4"')

    if (this.units.has(name)) throw httpError(409, `"${name}" is already in the fleet`)

    const unit = new Unit({ name, host, port, version, autoReconnect: o.autoReconnect !== false }, this.deps)
    unit.on('state', (s) => this.emit('broadcast', Object.assign({ t: 'state' }, s)))
    unit.on('log', (l) => this.emit('broadcast', { t: 'log', name, text: l.text }))
    unit.on('event', (e) => this.emit('broadcast', { t: 'event', name, kind: e.kind, text: e.text }))
    unit.on('radar', (f) => this.emit('broadcast', Object.assign({ t: 'radar', name }, f)))
    this.units.set(name, unit)

    this.emit('broadcast', { t: 'added', name, host, port })
    if (o.connect !== false) unit.connect()
    return unit.snapshot()
  }

  remove (name) {
    const unit = this.units.get(name)
    if (!unit) throw httpError(404, `no unit named "${name}"`)
    unit.stop()
    this.units.delete(name)
    this.emit('broadcast', { t: 'removed', name })
  }

  get (name) {
    return this.units.get(name) || null
  }

  list () {
    return Array.from(this.units.values()).map((u) => u.snapshot())
  }

  command (name, text, source) {
    const unit = this.units.get(name)
    if (!unit) return Promise.reject(httpError(404, `no unit named "${name}"`))
    return unit.command(text, source === undefined ? 'web' : source)
  }

  stopAll () {
    for (const name of Array.from(this.units.keys())) {
      try { this.remove(name) } catch (e) { /* already gone */ }
    }
  }
}

module.exports = { Fleet, httpError }
