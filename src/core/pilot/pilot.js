'use strict'

// the pilot: the per-unit brain that ties the goal system, the search and
// the executor together, the way baritone's pathing process does.
//
//   goto(x, z) / goto(x, y, z)   plan and walk (GoalXZ / GoalBlock)
//   come(player)                 one-shot GoalNear on a player
//   follow(player, radius)       continuous GoalFollow with live replans
//   mine(names, count)           path to the nearest match, dig, repeat
//   stop()                       halt everything
//
// when the executor reports a splice (the world changed under the plan),
// the pilot replans from the bot's actual position toward the same goal.
// unreachable goals degrade to the best partial path — walk as close as
// the loaded world allows — exactly baritone's contract.

const { EventEmitter } = require('events')
const { WorldView } = require('./world')
const { generate, DEFAULTS: MOVE_DEFAULTS } = require('./moves')
const { search, DEFAULTS: SEARCH_DEFAULTS } = require('./astar')
const { Executor } = require('./executor')
const { GoalBlock, GoalNear, GoalXZ, GoalFollow } = require('./goals')
const { runBuilder } = require('./builder')
const { runFarm } = require('./farm')
const { runExplore } = require('./explore')

const FOLLOW_REFRESH_MS = 1500
const REPLAN_DEBOUNCE_MS = 400
const MAX_CONSECUTIVE_FAILS = 3
const MAX_PATH_POINTS = 256

// long-running processes that own their arrival handling (the way the
// mine loop does). while one is active the pilot must not reset the task
// on every executor arrival/failure — the job loop decides when it ends.
const JOB_TASKS = new Set(['mine', 'build', 'farm', 'explore'])

class Pilot extends EventEmitter {
  constructor ({ bot, unit, deps, settings }) {
    super()
    this.bot = bot
    this.unit = unit
    this.deps = deps
    this.s = Object.assign({}, MOVE_DEFAULTS, SEARCH_DEFAULTS, settings || {})
    this.view = WorldView.fromBot(bot, deps)
    this.goal = null
    this.task = 'idle'
    this.goalLabel = ''
    this.partial = false
    this.lastReplanAt = 0
    this.replanPending = false
    this.consecutiveFails = 0
    this.pathPointsCache = []
    this.followTimer = null
    this.mineLoop = null
    this.jobSeq = 0
    this.activeJob = 0
    this.executor = new Executor({ bot, view: this.view, settings: this.s, Vec3: deps.Vec3 })
    this.wire()
  }

  wire () {
    this.executor.on('progress', (p) => {
      this.emit('progress', p)
    })
    this.executor.on('log', (text) => this.emit('log', text))
    this.executor.on('arrived', () => this.onArrived())
    this.executor.on('failed', (info) => {
      this.emit('log', `path failed: ${(info && info.reason) || 'unknown'}`)
      this.emit('failed', info || null)
      if (this.activeJob !== 0 || this.task === 'follow' || this.task === 'idle') return
      this.task = 'idle'
      this.goal = null
      this.emit('task')
    })
    this.executor.on('splice', () => this.scheduleReplan())
    this.executor.on('noMaterial', () => this.onNoMaterial())
    this.executor.on('stuck', (info) => {
      this.emit('log', `stuck (${info.events}) — recovering`)
    })
  }

  // a placement failed because the inventory has nothing placeable. for
  // plain movement tasks degrade to planning without placing (digging
  // and detours still work); processes handle their own material errors.
  onNoMaterial () {
    if (this.activeJob !== 0) return
    if (this.task === 'idle' || this.task === 'follow') return
    if (!this.s.allowPlace) return // already degraded for this task
    this.s.allowPlace = false
    this.placeDegraded = true
    this.emit('log', 'out of placeable blocks — planning without placing')
    this.replan()
  }

  // ---- planning --------------------------------------------------------

  pos () {
    const e = this.bot.entity
    return e && e.position ? e.position : null
  }

  node () {
    const p = this.pos()
    if (!p) return null
    return { x: Math.floor(p.x), y: Math.floor(p.y + 0.06), z: Math.floor(p.z) }
  }

  planNow (goal) {
    const start = this.node()
    if (!start) return { status: 'nopos' }
    if (goal.isMet(start.x, start.y, start.z)) {
      return { status: 'found', moves: [], nodes: [start], cost: 0 }
    }
    return search(start, goal, (n) => generate(this.view, n, this.s), {
      maxNodes: this.s.maxNodes,
      timeoutMs: this.s.timeoutMs
    })
  }

  async launch (goal, taskLabel) {
    this.goal = goal
    this.task = taskLabel
    this.goalLabel = goal.label()
    this.partial = false
    this.consecutiveFails = 0
    this.partialPrevEnd = null
    if (this.placeDegraded) {
      this.placeDegraded = false
      this.s.allowPlace = true
    }
    // the world around a fresh spawn loads in over a couple of seconds;
    // a plan against an all-fog world fails honestly but pointlessly, so
    // give the chunks a moment to arrive before declaring no path
    let r = this.planNow(goal)
    for (let tries = 0; r.status !== 'found' && r.status !== 'partial' && tries < 2; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      r = this.planNow(goal)
    }
    if (process.env.BOTFLEET_DEBUG_PLAN === '1') {
      this.emit('log', `plan ${r.status}: ${r.moves ? r.moves.length : 0} moves, ${r.expanded || 0} nodes, endH ${Number(r.endHeuristic || 0).toFixed(1)}`)
    }
    if (r.status === 'found' || r.status === 'partial') {
      this.partial = r.status === 'partial'
      this.pathPointsCache = nodesToPoints(r.nodes)
      if (this.partial && !this.trackPartialEnd(r)) return { ok: true, reply: 'already as close as the world allows' }
      this.executor.run(r.moves)
      if (this.partial) this.emit('log', `partial path: heading as close as the loaded world allows`)
      this.emit('path', {
        points: this.pathPointsCache,
        goal: this.goalLabel,
        partial: this.partial,
        cost: Math.round(r.cost * 10) / 10
      })
      this.emit('task')
      return { ok: true, reply: `moving to ${this.goalLabel}` }
    }
    this.task = 'idle'
    this.goal = null
    this.emit('task')
    return { ok: false, error: 'no path to target' }
  }

  // a partial path that ends in the same place twice means the loaded
  // world genuinely runs out — stop there instead of replanning forever
  trackPartialEnd (r) {
    const end = r.moves.length ? r.moves[r.moves.length - 1].to : r.nodes[r.nodes.length - 1]
    const k = end.x + ',' + end.y + ',' + end.z
    if (this.partialPrevEnd && this.partialPrevEnd === k) {
      this.emit('log', 'partial arrival: the goal lies beyond the loaded world')
      this.executor.stop()
      this.task = 'idle'
      this.goal = null
      this.emit('arrived', { goal: this.goalLabel, partial: true })
      this.emit('task')
      return false
    }
    this.partialPrevEnd = k
    return true
  }

  scheduleReplan () {
    if (!this.goal || this.replanPending) return
    const now = Date.now()
    const wait = Math.max(0, REPLAN_DEBOUNCE_MS - (now - this.lastReplanAt))
    this.replanPending = true
    setTimeout(() => {
      this.replanPending = false
      this.replan()
    }, wait)
  }

  replan () {
    if (!this.goal || this.task === 'idle') return
    const r = this.planNow(this.goal)
    if (r.status === 'found' || r.status === 'partial') {
      this.lastReplanAt = Date.now()
      this.partial = r.status === 'partial'
      this.pathPointsCache = nodesToPoints(r.nodes)
      if (this.partial && !this.trackPartialEnd(r)) return
      this.executor.replans++
      this.executor.run(r.moves)
      this.emit('path', { points: this.pathPointsCache, goal: this.goalLabel, partial: this.partial })
    } else {
      this.consecutiveFails++
      this.emit('log', `replan failed (${this.consecutiveFails}/${MAX_CONSECUTIVE_FAILS})`)
      if (this.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        this.executor.stop()
        this.executor.emit('failed', { reason: 'no path' })
      } else {
        setTimeout(() => this.replan(), 600)
      }
    }
  }

  onArrived () {
    if (JOB_TASKS.has(this.task)) return // the running job owns arrival
    if (this.task === 'follow') return // the follow timer keeps it going
    if (this.partial && this.goal && this.task === 'goto') {
      // reached the edge of the loaded world: plan again, more may be loaded
      this.replan()
      return
    }
    // arriving into open water is not an arrival — a bot that idles in
    // deep water drowns. step out onto the nearest dry column first.
    const n = this.node()
    if (n && this.view.water(n.x, n.y, n.z)) {
      const land = this.nearestDryCell(n)
      if (land) {
        const r = this.driveTo(new GoalBlock(land.x, land.y, land.z))
        if (r && (r.status === 'found' || r.status === 'partial')) return
      }
    }
    this.emit('arrived', { goal: this.goalLabel })
    this.task = 'idle'
    this.goal = null
    this.pathPointsCache = []
    this.emit('task')
  }

  // nearest standable dry column (feet in air, ground below) within a
  // small ring — the way out of a pool after a water landing
  nearestDryCell (from) {
    let best = null
    let bestD = Infinity
    for (let dx = -10; dx <= 10; dx++) {
      for (let dz = -10; dz <= 10; dz++) {
        const x = from.x + dx
        const z = from.z + dz
        for (let dy = -4; dy <= 8; dy++) {
          const y = from.y + dy
          if (!this.view.known(x, y - 1, z)) continue
          if (this.view.standable(x, y - 1, z) &&
            this.view.passable(x, y, z) && !this.view.water(x, y, z) &&
            this.view.passable(x, y + 1, z)) {
            const d = dx * dx + dy * dy + dz * dz
            if (d < bestD) { bestD = d; best = { x, y, z } }
            break
          }
        }
      }
    }
    return best
  }

  // ---- verbs -----------------------------------------------------------

  goto (x, y, z) {
    const goal = (y === null || y === undefined)
      ? new GoalXZ(Math.floor(x), Math.floor(z))
      : new GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z))
    return this.launch(goal, 'goto')
  }

  come (target) {
    // target: { x, y, z } from a player entity, one-shot
    const goal = new GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), 1)
    return this.launch(goal, 'goto')
  }

  follow (getPosition, radius) {
    this.stopFollowTimer()
    this.goal = new GoalFollow(getPosition, radius)
    this.task = 'follow'
    this.goalLabel = this.goal.label()
    this.consecutiveFails = 0
    this.replan()
    this.followTimer = setInterval(() => {
      if (this.task !== 'follow') return
      const r = this.planNow(this.goal)
      if (r.status === 'found' || r.status === 'partial') {
        // only replan if meaningfully different from the current plan's end
        const cur = this.executor.queue.length
          ? this.executor.queue[this.executor.queue.length - 1].to
          : null
        const t = this.goal.target()
        if (!cur || !t || Math.abs(cur.x - t.x) + Math.abs(cur.z - t.z) > 2) {
          this.pathPointsCache = nodesToPoints(r.nodes)
          this.executor.replans++
          this.executor.run(r.moves)
          this.emit('path', { points: this.pathPointsCache, goal: this.goalLabel, partial: r.status === 'partial' })
        }
      }
    }, FOLLOW_REFRESH_MS)
    this.emit('task')
    return { ok: true, reply: 'following' }
  }

  stopFollowTimer () {
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = null
    }
  }

  mine (names, count) {
    this.stopFollowTimer()
    this.task = 'mine'
    this.goalLabel = `mine ${names.join(' ')} x${count}`
    this.consecutiveFails = 0
    this.emit('task')
    this.mineLoop = this.mineStep(names, count)
      .then((dug) => {
        this.mineLoop = null
        this.task = 'idle'
        this.goal = null
        this.goalLabel = ''
        this.pathPointsCache = []
        this.emit('log', `mined ${dug} ${names[0]}`)
        this.emit('arrived', { goal: `mine ${names[0]} x${dug}` })
        this.emit('task')
        return dug
      })
      .catch((err) => {
        this.mineLoop = null
        this.task = 'idle'
        this.goal = null
        this.goalLabel = ''
        this.emit('log', `mine failed: ${String(err.message || err).slice(0, 80)}`)
        this.emit('task')
        return 0
      })
    return { ok: true, reply: `mining ${count} x ${names[0]}` }
  }

  async mineStep (names, count) {
    let dug = 0
    for (let i = 0; i < count; i++) {
      const target = this.findNearest(names)
      if (!target) {
        if (dug === 0) throw new Error(`no ${names[0]} in range`)
        break
      }
      this.goal = new GoalNear(target.x, target.y, target.z, 1)
      const r = this.planNow(this.goal)
      if (r.status !== 'found' && r.status !== 'partial') {
        if (dug === 0) throw new Error(`cannot reach any ${names[0]}`)
        break
      }
      this.pathPointsCache = nodesToPoints(r.nodes)
      this.executor.run(r.moves)
      if (r.moves.length > 0) {
        const done = await this.waitArrival()
        if (!done) throw new Error('could not reach the vein')
      }
      await this.digTarget(target)
      await this.waitPickup()
      dug++
      this.emit('progress', { index: dug, total: count })
    }
    return dug
  }

  // give dropped items a moment to reach the inventory before moving on
  // — a bot that walks away from its own drops mines thin air next tick
  async waitPickup () {
    const t0 = Date.now()
    const nearbyItems = () => {
      try {
        return Object.values(this.bot.entities || {}).filter((e) =>
          e && e.name === 'item' && e.position && this.bot.entity &&
          e.position.distanceTo(this.bot.entity.position) < 2.5).length
      } catch (e) { return 0 }
    }
    while (Date.now() - t0 < 1200 && nearbyItems() > 0) {
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  waitArrival () {
    return new Promise((resolve) => {
      // an empty plan finishes synchronously inside run(), before any
      // listener could attach — treat an already-idle executor as arrived
      if (!this.executor.running) {
        resolve(true)
        return
      }
      const to = setTimeout(() => {
        cleanup()
        resolve(false)
      }, 120000)
      const onArrived = () => { cleanup(); resolve(true) }
      const onFailed = () => { cleanup(); resolve(false) }
      const cleanup = () => {
        clearTimeout(to)
        this.executor.removeListener('arrived', onArrived)
        this.executor.removeListener('failed', onFailed)
      }
      this.executor.once('arrived', onArrived)
      this.executor.once('failed', onFailed)
    })
  }

  async digTarget (t) {
    const block = (() => {
      try { return this.bot.world.getBlock(new this.deps.Vec3(t.x, t.y, t.z)) || null } catch (e) { return null }
    })()
    if (!block) return
    try {
      if (this.bot.lookAt) this.bot.lookAt(new this.deps.Vec3(t.x + 0.5, t.y + 0.5, t.z + 0.5))
      await Promise.race([
        this.bot.dig(block),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('dig timeout')), 20000))
      ])
    } catch (e) {
      this.emit('log', `dig failed: ${String(e.message || e).slice(0, 60)}`)
    }
  }

  findNearest (names) {
    const p = this.pos()
    if (!p) return null
    const myX = Math.floor(p.x)
    const myZ = Math.floor(p.z)
    const sameColumn = (x, z) => x === myX && z === myZ
    if (typeof this.bot.findBlocks === 'function') {
      const ids = []
      const reg = this.bot.registry || null
      const blocksByName = reg && reg.blocksByName ? reg.blocksByName : null
      for (const n of names) {
        const meta = blocksByName ? blocksByName[n] : null
        if (meta) ids.push(meta.id)
      }
      if (ids.length > 0) {
        const found = this.bot.findBlocks({ matching: ids, maxDistance: 64, count: 32 })
        if (found && found.length > 0) {
          let best = null
          let bestD = Infinity
          for (const f of found) {
            if (sameColumn(f.x, f.z)) continue // never dig straight down
            const d = (f.x - p.x) ** 2 + (f.y - p.y) ** 2 + (f.z - p.z) ** 2
            if (d < bestD) { bestD = d; best = f }
          }
          if (best) return { x: best.x, y: best.y, z: best.z }
        }
      }
    }
    // fallback: scan the loaded view in a small cube around the bot
    const wanted = new Set(names)
    let best = null
    let bestD = Infinity
    const R = 32
    const cx = Math.floor(p.x)
    const cy = Math.floor(p.y)
    const cz = Math.floor(p.z)
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
          if (sameColumn(cx + dx, cz + dz)) continue
          if (wanted.has(this.view.name(cx + dx, cy + dy, cz + dz))) {
            const d = dx * dx + dy * dy + dz * dz
            if (d < bestD) {
              bestD = d
              best = { x: cx + dx, y: cy + dy, z: cz + dz }
            }
          }
        }
      }
    }
    return best
  }

  // ---- jobs (long-running processes) -----------------------------------

  // run a process to completion in the background. fn receives an alive()
  // closure; the job dies the moment stop() or a newer job flips the
  // sequence. completion, failure and cleanup are logged here so the
  // process functions can stay pure loops.
  async runJob (task, label, fn) {
    this.stopFollowTimer()
    const id = ++this.jobSeq
    this.activeJob = id
    this.task = task
    this.goalLabel = label
    this.consecutiveFails = 0
    this.emit('task')
    const finish = () => {
      if (this.activeJob !== id) return
      this.activeJob = 0
      this.task = 'idle'
      this.goal = null
      this.goalLabel = ''
      this.pathPointsCache = []
      this.emit('task')
    }
    try {
      const out = await fn(() => this.activeJob === id)
      finish()
      return out
    } catch (err) {
      this.executor.stop()
      if (this.activeJob === id) {
        this.emit('log', `${task} failed: ${String(err.message || err).slice(0, 90)}`)
      }
      finish()
      return null
    }
  }

  startJob (task, label, fn) {
    this.runJob(task, label, fn).catch(() => { /* runJob never rejects */ })
  }

  // plan toward a goal and drive there, the way goto does, but callable
  // from inside a job loop (the task label stays the job's).
  driveTo (goal) {
    const r = this.planNow(goal)
    if (r.status !== 'found' && r.status !== 'partial') return r
    this.goal = goal
    this.goalLabel = goal.label()
    this.partial = r.status === 'partial'
    this.pathPointsCache = nodesToPoints(r.nodes)
    if (this.partial && !this.trackPartialEnd(r)) return { status: 'partial-stuck' }
    this.executor.run(r.moves)
    this.emit('path', {
      points: this.pathPointsCache,
      goal: this.goalLabel,
      partial: this.partial,
      cost: Math.round(r.cost * 10) / 10
    })
    return r
  }

  build (blueprint, origin) {
    const o = origin || this.anchorHere()
    this.startJob('build', `build ${blueprint.name}`, (alive) => runBuilder(this, blueprint, o, alive))
    return { ok: true, reply: `building ${blueprint.name} (${blueprint.placements.length} cells)` }
  }

  farm (radius) {
    this.startJob('farm', `farm r${radius}`, (alive) => runFarm(this, radius, alive))
    return { ok: true, reply: `farming within ${radius} blocks` }
  }

  explore (radius) {
    this.startJob('explore', `explore r${radius}`, (alive) => runExplore(this, radius, alive))
    return { ok: true, reply: `exploring within ${radius} blocks` }
  }

  anchorHere () {
    const n = this.node()
    return n ? { x: n.x, y: n.y, z: n.z } : { x: 0, y: 0, z: 0 }
  }

  // ---- process helpers (used by builder / farm / explore) ---------------

  hasItem (name) {
    try {
      const items = this.bot.inventory ? this.bot.inventory.items() : []
      return items.find((it) => it && it.name === name) || null
    } catch (e) { return null }
  }

  countItem (name) {
    try {
      const items = this.bot.inventory ? this.bot.inventory.items() : []
      return items.filter((it) => it && it.name === name)
        .reduce((sum, it) => sum + (it.count || 1), 0)
    } catch (e) { return 0 }
  }

  async equipItem (item) {
    try {
      if (this.bot.equip && item) await this.bot.equip(item, 'hand')
    } catch (e) { /* fakes and edge states may not equip */ }
  }

  botBlockAt (cell) {
    try {
      return this.bot.world.getBlock(new this.deps.Vec3(cell.x, cell.y, cell.z)) || null
    } catch (e) { return null }
  }

  lookAtCell (x, y, z) {
    try {
      if (this.bot.lookAt) return this.bot.lookAt(new this.deps.Vec3(x + 0.5, y + 0.5, z + 0.5))
    } catch (e) { /* ignore */ }
  }

  async placeRefFace (refBlock, face) {
    return this.bot.placeBlock(refBlock, new this.deps.Vec3(face.x, face.y, face.z))
  }

  isNearCell (x, y, z, r) {
    const n = this.node()
    if (!n) return false
    const dx = n.x - x
    const dy = n.y - y
    const dz = n.z - z
    return dx * dx + dy * dy + dz * dz <= r * r
  }

  // dig a single cell (used by the mine loop and the builder). never
  // throws: failures are logged and the caller decides what they mean.
  async digCell (cell) {
    const block = this.botBlockAt(cell)
    if (!block) return false
    try {
      this.lookAtCell(cell.x, cell.y, cell.z)
      await Promise.race([
        this.bot.dig(block),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('dig timeout')), 20000))
      ])
      return true
    } catch (e) {
      this.emit('log', `dig failed: ${String(e.message || e).slice(0, 60)}`)
      return false
    }
  }

  setSetting (key, value) {
    const allowed = {
      allowBreak: 'bool', allowPlace: 'bool', allowParkour: 'bool',
      allowWater: 'bool', allowFallDamage: 'bool',
      maxFallNoDamage: 'int', maxFallWithDamage: 'int', maxWaterLanding: 'int',
      walkCost: 'num', swimCost: 'num', ascendCost: 'num', parkourCost: 'num'
    }
    const kind = allowed[key]
    if (!kind) return { ok: false, error: `unknown setting "${key}"` }
    let v = value
    if (kind === 'bool') {
      if (value === true || value === 'true') v = true
      else if (value === false || value === 'false') v = false
      else return { ok: false, error: `${key} takes true or false` }
    } else {
      v = Number(value)
      if (!Number.isFinite(v) || v < 0 || v > 256) {
        return { ok: false, error: `${key} takes a number 0-256` }
      }
      if (kind === 'int') v = Math.round(v)
    }
    this.s[key] = v
    if (key === 'allowPlace') this.placeDegraded = false // user spoke last
    return { ok: true, value: v }
  }

  stop () {
    this.stopFollowTimer()
    this.activeJob = 0 // any running job sees alive() turn false
    if (this.mineLoop) this.mineLoop = null
    this.goal = null
    this.task = 'idle'
    this.partial = false
    this.pathPointsCache = []
    this.executor.stop()
    this.emit('task')
  }

  dispose () {
    this.stop()
    this.executor.dispose()
    this.removeAllListeners()
  }

  // ---- reporting -------------------------------------------------------

  pathPoints () {
    const pts = this.pathPointsCache
    if (pts.length <= MAX_PATH_POINTS) return pts
    const stride = Math.ceil(pts.length / MAX_PATH_POINTS)
    const out = [pts[0]]
    for (let i = stride; i < pts.length - 1; i += stride) out.push(pts[i])
    out.push(pts[pts.length - 1])
    return out
  }

  info () {
    const e = this.executor.snapshot()
    return {
      task: this.task,
      goal: this.goalLabel,
      partial: this.partial,
      progress: e.index,
      total: e.total,
      replans: e.replans,
      stuck: e.stuckEvents,
      move: e.type,
      running: e.running
    }
  }
}

function nodesToPoints (nodes) {
  const out = []
  for (const n of nodes || []) out.push([n.x, n.y, n.z])
  return out
}

module.exports = { Pilot, MAX_PATH_POINTS }
