'use strict'

// the movement layer. sits on the pilot engine — an original javascript
// implementation of the pathfinding architecture popularized by baritone
// (goals, A* with movement costs, splicing, stuck recovery, best partial
// paths) — and exposes the same three verbs the console always had:
// goto / come / follow, plus mine. one `task` label for the UI.

const { Pilot } = require('../pilot/pilot')

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
    const r = pilot.goto(x, y, z)
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
    const r = pilot.come(posOfTarget(p.entity))
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

  state.goto = goto
  state.come = come
  state.follow = follow
  state.mine = mine
  state.stop = halt
  state.pathPoints = () => pilot.pathPoints()
  state.pilotInfo = () => pilot.info()
  return state
}

module.exports = { attachNavigator }
