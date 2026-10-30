'use strict'

// integration tests for the pilot engine: a real Fleet, a FakeBot with
// kinematic physics, a voxel world. these prove the whole chain —
// command -> navigator -> pilot -> A* -> executor -> controls -> arrival —
// without any network, deterministically.

const test = require('node:test')
const assert = require('node:assert')
const { Fleet } = require('../src/core/fleet')
const { FakeBot, VoxelWorld } = require('./helpers/fake')
const { Vec3 } = require('vec3')

function makeFleet (world) {
  const created = []
  const w = world || flatWorld()
  const deps = {
    createBot: (opts) => { const b = new FakeBot(opts, w); created.push(b); return b },
    Vec3
  }
  return { fleet: new Fleet(deps), created, world: w }
}

function flatWorld () {
  const w = new VoxelWorld()
  w.ground(-30, -30, 30, 30, 63)
  return w
}

function cleanup (fleet) {
  try { fleet.stopAll() } catch (e) { /* noop */ }
}

async function until (fn, label, timeoutMs = 12000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('pilot: goto walks the fake bot to the target', async () => {
  const { fleet, created } = makeFleet()
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    const r = await fleet.command('Scout', 'goto 5 2')
    assert.strictEqual(r.ok, true)
    await until(() => {
      const s = fleet.list()[0]
      return s.task === 'idle' && s.position && Math.abs(s.position.x - 5.5) < 1 && Math.abs(s.position.z - 2.5) < 1
    }, 'scout to arrive at 5,2')
    const s = fleet.list()[0]
    assert.ok(Math.abs(s.position.x - 5) <= 1 && Math.abs(s.position.z - 2) <= 1)
  } finally { cleanup(fleet) }
})

test('pilot: path shows up in snapshots while walking', async () => {
  const { fleet, created } = makeFleet()
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    await fleet.command('Scout', 'goto 12 0')
    const s = fleet.list()[0]
    assert.strictEqual(s.task, 'goto')
    assert.ok(Array.isArray(s.path) && s.path.length >= 2, 'path points are broadcast')
    assert.ok(s.pilot && s.pilot.total >= 2, 'pilot info is broadcast')
    await until(() => fleet.list()[0].task === 'idle', 'goto to finish')
  } finally { cleanup(fleet) }
})

test('pilot: digs through a dirt wall when it is on the way', async () => {
  const w = flatWorld()
  // a long 2-high dirt wall: going around costs 30+ blocks, so digging
  // straight through is clearly the cheapest plan
  for (let z = -8; z <= 8; z++) {
    w.setBlock(6, 64, z, 'dirt')
    w.setBlock(6, 65, z, 'dirt')
  }
  const { fleet, created } = makeFleet(w)
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    await fleet.command('Scout', 'goto 10 0')
    await until(() => {
      const s = fleet.list()[0]
      return s.task === 'idle' && s.position && s.position.x > 9
    }, 'scout to tunnel through the wall', 25000)
    assert.ok(created[0].digs.length >= 1, 'dirt was actually dug')
  } finally { cleanup(fleet) }
})

test('pilot: splices when a wall appears mid-run', async () => {
  const w = flatWorld()
  const { fleet, created } = makeFleet(w)
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    await fleet.command('Scout', 'goto 14 0')
    // a bedrock wall slams down across the path while walking
    setTimeout(() => {
      for (let z = -2; z <= 2; z++) {
        w.setBlock(7, 64, z, 'bedrock')
        w.setBlock(7, 65, z, 'air')
      }
    }, 400)
    await until(() => {
      const s = fleet.list()[0]
      return s.task === 'idle' && s.position && s.position.x > 13
    }, 'scout to reroute around the new wall', 25000)
    const s = fleet.list()[0]
    assert.ok(s.pilot.replans >= 1, 'a splice-driven replan happened')
  } finally { cleanup(fleet) }
})

test('pilot: mines named blocks and counts them', async () => {
  const w = flatWorld()
  w.setBlock(3, 64, 0, 'dirt')
  w.setBlock(5, 64, 0, 'dirt')
  const { fleet, created } = makeFleet(w)
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    const r = await fleet.command('Scout', 'mine dirt 2')
    assert.strictEqual(r.ok, true)
    await until(() => fleet.list()[0].task === 'idle', 'mining to finish', 30000)
    assert.strictEqual(created[0].digs.filter((n) => n === 'dirt').length, 2)
    assert.strictEqual(w.blockAtXYZ(3, 64, 0).name, 'air')
    assert.strictEqual(w.blockAtXYZ(5, 64, 0).name, 'air')
  } finally { cleanup(fleet) }
})

test('pilot: mine reports when nothing is in range', async () => {
  const { fleet, created } = makeFleet()
  const logs = []
  fleet.on('broadcast', (m) => { if (m.t === 'log') logs.push(m.text) })
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    await fleet.command('Scout', 'mine diamond_ore 1')
    await until(() => fleet.list()[0].task === 'idle', 'mine to fail fast')
    assert.ok(logs.some((t) => /no diamond_ore in range/.test(t)))
  } finally { cleanup(fleet) }
})

test('pilot: come walks to a visible player', async () => {
  const { fleet, created } = makeFleet()
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    created[0].players.Relay = { username: 'Relay', entity: { position: new Vec3(8, 64, 3) } }
    await fleet.command('Scout', 'come Relay')
    await until(() => {
      const s = fleet.list()[0]
      return s.task === 'idle' && s.position && Math.hypot(s.position.x - 8, s.position.z - 3) < 2.5
    }, 'scout to come to Relay')
  } finally { cleanup(fleet) }
})

test('pilot: follow keeps up with a moving player', async () => {
  const { fleet, created } = makeFleet()
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    const relay = { username: 'Relay', entity: { position: new Vec3(6, 64, 0) } }
    created[0].players.Relay = relay
    const r = await fleet.command('Scout', 'follow Relay')
    assert.strictEqual(r.ok, true)
    await until(() => {
      const s = fleet.list()[0]
      return s.position && Math.hypot(s.position.x - 6, s.position.z - 0) < 3
    }, 'scout to close in on Relay')
    // relay moves away; the follower should tag along
    relay.entity.position = new Vec3(-6, 64, 0)
    await until(() => {
      const s = fleet.list()[0]
      return s.position && Math.hypot(s.position.x + 6, s.position.z - 0) < 3
    }, 'scout to follow Relay to the new spot', 20000)
    await fleet.command('Scout', 'follow off')
    assert.strictEqual(fleet.list()[0].task, 'idle')
  } finally { cleanup(fleet) }
})

test('pilot: stop halts mid-walk', async () => {
  const { fleet, created } = makeFleet()
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    await fleet.command('Scout', 'goto 20 0')
    await until(() => fleet.list()[0].position && fleet.list()[0].position.x > 2, 'walking to start')
    await fleet.command('Scout', 'stop')
    const s = fleet.list()[0]
    assert.strictEqual(s.task, 'idle')
    const xAtStop = s.position.x
    await new Promise((r) => setTimeout(r, 700))
    const s2 = fleet.list()[0]
    assert.ok(Math.abs(s2.position.x - xAtStop) < 0.6, 'bot actually stopped')
    assert.strictEqual(created[0].controls.forward, false)
  } finally { cleanup(fleet) }
})

test('pilot: goto degrades to a partial path at the edge of the known world', async () => {
  const w = new VoxelWorld()
  w.ground(-4, -4, 4, 4, 63)
  const logs = []
  const { fleet, created } = makeFleet(w)
  fleet.on('broadcast', (m) => { if (m.t === 'log') logs.push(m.text) })
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    await fleet.command('Scout', 'goto 20 0')
    await until(() => fleet.list()[0].task === 'idle', 'partial arrival to settle', 15000)
    const s = fleet.list()[0]
    assert.ok(s.position.x >= 3, 'walked to the eastern edge of the island')
    assert.ok(s.position.x <= 5.5)
    assert.ok(logs.some((t) => /partial/.test(t)), 'partial path was reported')
  } finally { cleanup(fleet) }
})

test('pilot: climbs a staircase world', async () => {
  const w = new VoxelWorld()
  w.fill(-3, 55, -3, 3, 62, 3, 'stone')
  w.fill(-3, 63, -3, 3, 70, 3, 'air')
  w.setBlock(0, 63, 0, 'stone')
  w.setBlock(0, 64, -1, 'stone')
  w.setBlock(0, 65, -2, 'stone')
  w.setBlock(0, 66, -3, 'stone')
  const { fleet, created } = makeFleet(w)
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0.5, 64, 0.5)
    await fleet.command('Scout', 'goto 0 67 -3')
    await until(() => {
      const s = fleet.list()[0]
      return s.task === 'idle' && s.position && s.position.y >= 66.5 && Math.abs(s.position.z + 3) < 1.5
    }, 'scout to climb the stairs', 25000)
  } finally { cleanup(fleet) }
})

test('pilot: swim crossing reaches a far island', async () => {
  const w = new VoxelWorld()
  // home island z:0..1, water z:2..5, far island z:6..9
  w.fill(-2, 63, 0, 2, 63, 1, 'grass_block')
  w.fill(-2, 64, 0, 2, 68, 1, 'air')
  w.fill(-2, 60, 2, 2, 60, 5, 'dirt')
  w.fill(-2, 61, 2, 2, 63, 5, 'water')
  w.fill(-2, 64, 2, 2, 68, 5, 'air')
  w.fill(-2, 63, 6, 2, 63, 9, 'grass_block')
  w.fill(-2, 64, 6, 2, 68, 9, 'air')
  const { fleet, created } = makeFleet(w)
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    await fleet.command('Scout', 'goto 0 8')
    await until(() => {
      const s = fleet.list()[0]
      return s.task === 'idle' && s.position && s.position.z >= 6
    }, 'scout to swim across', 30000)
  } finally { cleanup(fleet) }
})

test('pilot: stuck detection logs and recovers', async () => {
  const w = flatWorld()
  const { fleet, created } = makeFleet(w)
  const logs = []
  fleet.on('broadcast', (m) => { if (m.t === 'log') logs.push(m.text) })
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    await fleet.command('Scout', 'goto 16 0')
    // freeze physics mid-walk: the bot cannot move anymore
    await until(() => fleet.list()[0].position && fleet.list()[0].position.x > 1, 'walking to start')
    created[0].disposePhysics()
    await until(() => logs.some((t) => /stuck/.test(t)), 'a stuck event to fire', 8000)
    // thaw: recovery should let it finish
    created[0].physicsTimer = setInterval(() => created[0].physicsTick(0.05), 50)
    await until(() => {
      const s = fleet.list()[0]
      return s.task === 'idle' && s.position && s.position.x > 15
    }, 'scout to recover and finish', 25000)
  } finally { cleanup(fleet) }
})
