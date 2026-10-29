'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const { Fleet } = require('../src/core/fleet')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')

// a fake mineflayer bot. it speaks just enough of the API for a Unit to
// believe it is online, without any network. the registry is real
// minecraft-data, because mineflayer-pathfinder's Movements needs it.
class FakeBot extends EventEmitter {
  constructor (opts) {
    super()
    this.username = opts.username
    this.options = opts
    this.entity = null
    this.players = {}
    this.entities = {}
    this.health = null
    this.food = null
    this.version = '1.21.4'
    this.chats = []
    this.quitCalled = false
    this.inventory = { items: () => [] }
    this.world = { getBlock: () => null }
    this.registry = mcData
    this.physics = { gravity: 32, stepHeight: 1.001 }
    this.pathfinder = {
      setMovements () {},
      setGoal () {},
      stop () {}
    }
  }

  chat (msg) { this.chats.push(msg) }

  quit () {
    this.quitCalled = true
    this.emit('end')
  }

  spawnAt (x, y, z) {
    this.entity = { position: new Vec3(x, y, z), yaw: 0 }
    this.health = 20
    this.food = 20
    this.emit('spawn')
  }
}

function makeFleet () {
  const created = []
  const deps = {
    createBot: (opts) => { const b = new FakeBot(opts); created.push(b); return b },
    pathfinderPlugin: { name: 'pathfinder', load () {} },
    Vec3
  }
  return { fleet: new Fleet(deps), created }
}

function cleanup (fleet) {
  try { fleet.stopAll() } catch (e) { /* noop */ }
}

test('add validates names', () => {
  const { fleet } = makeFleet()
  try {
    for (const bad of ['', 'has space', 'way_too_long_name_for_mc', 'dollar$sign']) {
      assert.throws(() => fleet.add({ name: bad, connect: false }), (e) => e.statusCode === 400, bad)
    }
    assert.throws(() => fleet.add({ name: 'Ok', port: 99999, connect: false }), (e) => e.statusCode === 400)
  } finally { cleanup(fleet) }
})

test('add rejects duplicates with 409', () => {
  const { fleet } = makeFleet()
  try {
    fleet.add({ name: 'Scout', connect: false })
    assert.throws(() => fleet.add({ name: 'Scout', connect: false }), (e) => e.statusCode === 409)
  } finally { cleanup(fleet) }
})

test('lifecycle: spawning -> online -> offline', async () => {
  const { fleet, created } = makeFleet()
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    assert.strictEqual(fleet.list()[0].status, 'spawning')
    assert.strictEqual(created.length, 1)

    created[0].spawnAt(10, 64, -20)
    const s = fleet.list()[0]
    assert.strictEqual(s.status, 'online')
    assert.deepStrictEqual(s.position, { x: 10, y: 64, z: -20 })
    assert.strictEqual(s.health, 20)
    assert.strictEqual(s.players.length, 0)

    created[0].emit('end')
    assert.strictEqual(fleet.list()[0].status, 'offline')
  } finally { cleanup(fleet) }
})

test('broadcasts flow: state, log, event', async () => {
  const { fleet, created } = makeFleet()
  const seen = []
  fleet.on('broadcast', (m) => seen.push(m))
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    await fleet.command('Scout', 'where')
    assert.ok(seen.some((m) => m.t === 'state' && m.name === 'Scout' && m.status === 'online'))
    assert.ok(seen.some((m) => m.t === 'log' && /i am at/.test(m.text)))
    created[0].emit('kicked', 'test reason')
    assert.ok(seen.some((m) => m.t === 'event' && m.kind === 'kicked'))
  } finally { cleanup(fleet) }
})

test('say reaches the bot, invalid commands do not throw', async () => {
  const { fleet, created } = makeFleet()
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)

    const r = await fleet.command('Scout', 'say hello fleet')
    assert.strictEqual(r.ok, true)
    assert.deepStrictEqual(created[0].chats, ['hello fleet'])

    const bad = await fleet.command('Scout', 'definitely_not_a_command')
    assert.strictEqual(bad.ok, false)

    const r2 = await fleet.command('Scout', 'help')
    assert.strictEqual(r2.ok, true)
  } finally { cleanup(fleet) }
})

test('command on a missing unit rejects with 404', async () => {
  const { fleet } = makeFleet()
  try {
    await assert.rejects(fleet.command('Ghost', 'where'), (e) => e.statusCode === 404)
  } finally { cleanup(fleet) }
})

test('remove decommissions cleanly', () => {
  const { fleet, created } = makeFleet()
  const seen = []
  fleet.on('broadcast', (m) => seen.push(m))
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    fleet.remove('Scout')
    assert.strictEqual(fleet.list().length, 0)
    assert.ok(created[0].quitCalled)
    assert.ok(seen.some((m) => m.t === 'removed' && m.name === 'Scout'))
  } finally { cleanup(fleet) }
})

test('auto-reconnect: end schedules a new spawn attempt', async () => {
  const { fleet, created } = makeFleet()
  try {
    fleet.add({ name: 'Scout' }) // autoReconnect defaults to true
    created[0].spawnAt(0, 64, 0)
    created[0].emit('end')
    assert.strictEqual(fleet.list()[0].status, 'reconnecting')
    assert.strictEqual(fleet.list()[0].reconnectAttempts, 1)
    // the retry fires after 1s backoff and builds a fresh bot; the label
    // stays "reconnecting" until that new bot actually spawns
    await new Promise((resolve) => setTimeout(resolve, 1300))
    assert.strictEqual(created.length, 2, 'a fresh bot should have been created')
    assert.strictEqual(fleet.list()[0].status, 'reconnecting')
    created[1].spawnAt(5, 64, 5)
    assert.strictEqual(fleet.list()[0].status, 'online')
  } finally { cleanup(fleet) }
})

test('goto updates the task label', async () => {
  const { fleet, created } = makeFleet()
  try {
    fleet.add({ name: 'Scout', autoReconnect: false })
    created[0].spawnAt(0, 64, 0)
    const r = await fleet.command('Scout', 'goto 12 -5')
    assert.strictEqual(r.ok, true)
    assert.strictEqual(fleet.list()[0].task, 'goto')
    created[0].emit('goal_reached')
    assert.strictEqual(fleet.list()[0].task, 'idle')
  } finally { cleanup(fleet) }
})
