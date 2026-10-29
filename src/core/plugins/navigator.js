'use strict'

const { Movements, goals } = require('mineflayer-pathfinder')

// movement layer. wraps mineflayer-pathfinder behind three verbs
// (goto / come / follow) and exposes a single `task` label for the console.
// canDig stays false on purpose: click-to-move must never grief terrain.
function attachNavigator (unit, bot) {
  const movements = new Movements(bot)
  movements.canDig = false
  bot.pathfinder.setMovements(movements)

  const state = {
    task: 'idle',
    followName: null,
    followTimer: null,
    dispose () { halt() }
  }

  function halt () {
    if (state.followTimer) { clearInterval(state.followTimer); state.followTimer = null }
    state.followName = null
    try { bot.pathfinder.stop() } catch (e) { /* not moving */ }
    try { bot.pathfinder.setGoal(null) } catch (e) { /* no goal */ }
    state.task = 'idle'
  }

  function setGoal (x, y, z) {
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1))
  }

  bot.on('goal_reached', () => {
    if (state.task !== 'idle') {
      state.task = 'idle'
      unit.log('arrived')
      unit.emit('state', unit.snapshot())
    }
  })

  bot.on('path_update', (r) => {
    if (r && r.status === 'noPath' && state.task !== 'idle') {
      unit.log('no path to target')
      halt()
      unit.emit('state', unit.snapshot())
    }
  })

  async function goto (x, y, z, source) {
    const targetY = y === null || y === undefined
      ? Math.floor(bot.entity.position.y)
      : Math.floor(y)
    setGoal(Math.floor(x), targetY, Math.floor(z))
    state.task = 'goto'
    const at = `${Math.floor(x)} ${targetY} ${Math.floor(z)}`
    unit.log(`moving to ${at}`)
    unit.emit('state', unit.snapshot())
    return { ok: true, reply: `moving to ${at}` }
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

  async function come (player, source) {
    const p = player ? playerEntity(player) : nearestPlayer()
    if (!p) {
      const msg = player ? `i cannot see player "${player}"` : 'no other players in range'
      unit.reply(msg, source)
      return { ok: false, error: msg }
    }
    const e = p.entity.position
    setGoal(Math.floor(e.x), Math.floor(e.y), Math.floor(e.z))
    state.task = 'goto'
    unit.log(`moving to ${p.username}`)
    unit.emit('state', unit.snapshot())
    return { ok: true, reply: `moving to ${p.username}` }
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
    state.followName = player
    state.task = 'follow'
    unit.log(`following ${player}`)
    unit.emit('state', unit.snapshot())
    return { ok: true, reply: `following ${player}` }
  }

  if (state.followTimer) clearInterval(state.followTimer)
  state.followTimer = setInterval(() => {
    if (state.task !== 'follow' || !state.followName) return
    const p = playerEntity(state.followName)
    if (p && p.entity) {
      const e = p.entity.position
      try { bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(e.x), Math.floor(e.y), Math.floor(e.z), 2), true) } catch (err) { /* mid-path */ }
    }
  }, 2000)

  state.goto = goto
  state.come = come
  state.follow = follow
  state.stop = halt
  return state
}

module.exports = { attachNavigator }
