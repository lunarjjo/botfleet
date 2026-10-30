'use strict'

// the movement layer. sits on the pilot engine — an original javascript
// implementation of the pathfinding architecture popularized by baritone
// (goals, A* with movement costs, splicing, stuck recovery, best partial
// paths) — and exposes the movement verbs (goto / come / follow) plus the
// baritone-style processes: mine, build, farm and explore. one `task`
// label for the UI.

const { Pilot } = require('../pilot/pilot')
const { loadBlueprint } = require('../../util/blueprintStore')

function attachNavigator (unit, bot) {
  const pilot = new Pilot({ bot, unit, deps: unit.deps })

  const state = {
    pilot,
    task: 'idle',
    dispose () {
      halt()
      pilot.dispose()
    }
  }

  pilot.on('task', () => {
    state.task = pilot.task === 'idle' ? 'idle' : pilot.task
    unit.emit('state', unit.snapshot())
  })

  pilot.on('log', (text) => unit.log(text))

  pilot.on('path', (info) => {
    const n = info.points ? info.points.length : 0
    unit.log(`path: ${n} blocks${info.partial ? ' (partial)' : ''} -> ${info.goal}`)
    unit.emit('state', unit.snapshot())
  })

  pilot.on('progress', (p) => {
    if (p.total > 0 && p.index === p.total) return // arrival logs elsewhere
  })

  pilot.on('arrived', (info) => {
    unit.log(`arrived (${info && info.goal ? info.goal : 'target'})`)
    state.task = 'idle'
    unit.emit('state', unit.snapshot())
  })

  pilot.on('failed', () => {
    state.task = 'idle'
    unit.emit('state', unit.snapshot())
  })

  function halt () {
    try { pilot.stop() } catch (e) { /* already gone */ }
    state.task = 'idle'
  }

  function playerEntity (name) {
    const p = bot.players && bot.players[name]
    return p && p.entity ? p : null
  }

  function nearestPlayer () {
    let best = null
    let bestD = Infinity
    for (const p of Object.values(bot.players || {})) {
      if (p.username === bot.username || !p.entity) continue
      const dx = p.entity.position.x - bot.entity.position.x
      const dz = p.entity.position.z - bot.entity.position.z
      const d = dx * dx + dz * dz
      if (d < bestD) { bestD = d; best = p }
    }
    return best
  }

  function posOfTarget (t) {
    return {
      x: Math.floor(t.position.x),
      y: Math.floor(t.position.y),
      z: Math.floor(t.position.z)
    }
  }

  async function goto (x, y, z, source) {
    const r = await pilot.goto(x, y, z)
    state.task = pilot.task
    const at = (y === null || y === undefined)
      ? `${Math.floor(x)} ${Math.floor(z)}`
      : `${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`
    if (r.ok) unit.log(`moving to ${at}${pilot.partial ? ' (partial path)' : ''}`)
    else unit.reply('no path to target', source)
    unit.emit('state', unit.snapshot())
    return r
  }

  async function come (player, source) {
    const p = player ? playerEntity(player) : nearestPlayer()
    if (!p) {
      const msg = player ? `i cannot see player "${player}"` : 'no other players in range'
      unit.reply(msg, source)
      return { ok: false, error: msg }
    }
    const r = await pilot.come(posOfTarget(p.entity))
    state.task = pilot.task
    unit.log(`moving to ${p.username}`)
    unit.emit('state', unit.snapshot())
    return r
  }

  async function follow (player, source) {
    if (!player) {
      halt()
      unit.log('stopped following')
      return { ok: true, reply: 'follow off' }
    }
    if (!playerEntity(player)) {
      const msg = `i cannot see player "${player}"`
      unit.reply(msg, source)
      return { ok: false, error: msg }
    }
    pilot.follow(() => {
      const p = playerEntity(player)
      return p && p.entity ? posOfTarget(p.entity) : null
    }, 2)
    state.task = 'follow'
    unit.log(`following ${player}`)
    unit.emit('state', unit.snapshot())
    return { ok: true, reply: `following ${player}` }
  }

  async function mine (names, count, source) {
    const r = pilot.mine(names, count)
    state.task = pilot.task
    if (!r.ok) unit.reply(r.error || 'cannot mine that', source)
    unit.emit('state', unit.snapshot())
    return r
  }

  async function build (args, source) {
    if (!bot.entity) {
      const msg = 'i have no position yet'
      unit.reply(msg, source)
      return { ok: false, error: msg }
    }
    const loaded = loadBlueprint(args.blueprint)
    if (!loaded.ok) {
      unit.reply(loaded.error, source)
      return { ok: false, error: loaded.error }
    }
    const bp = loaded.blueprint
    const mine = bot.entity.position
    const origin = {
      x: args.x === null ? Math.floor(mine.x) : Math.floor(args.x),
      y: args.y === null ? Math.floor(mine.y) : Math.floor(args.y),
      z: args.z === null ? Math.floor(mine.z) : Math.floor(args.z)
    }
    const r = pilot.build(bp, origin)
    state.task = pilot.task
    if (!r.ok) unit.reply(r.error || 'cannot build that', source)
    else unit.log(`building ${bp.name} at ${origin.x} ${origin.y} ${origin.z} (${bp.placements.length} cells)`)
    unit.emit('state', unit.snapshot())
    return r
  }

  async function farm (radius, source) {
    const r = pilot.farm(radius || 24)
    state.task = pilot.task
    if (!r.ok) unit.reply(r.error || 'cannot farm here', source)
    unit.emit('state', unit.snapshot())
    return r
  }

  async function explore (radius, source) {
    const r = pilot.explore(radius || 48)
    state.task = pilot.task
    if (!r.ok) unit.reply(r.error || 'cannot explore from here', source)
    unit.emit('state', unit.snapshot())
    return r
  }

  async function set (key, value, source) {
    const r = pilot.setSetting(key, value)
    if (!r.ok) {
      unit.reply(r.error, source)
      return r
    }
    unit.log(`${key} = ${r.value}`)
    return { ok: true, reply: `${key} = ${r.value}` }
  }

  state.goto = goto
  state.come = come
  state.follow = follow
  state.mine = mine
  state.build = build
  state.farm = farm
  state.explore = explore
  state.set = set
  state.stop = halt
  state.pathPoints = () => pilot.pathPoints()
  state.pilotInfo = () => pilot.info()
  return state
}

module.exports = { attachNavigator }
