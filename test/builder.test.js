'use strict'

// builder process tests: a Fleet with a FakeBot and a voxel world, like
// the pilot tests. these prove the full loop — blueprint diff, walking
// into reach, equipping, placing with an anchor face, digging wrong
// blocks, honest failure when material is missing.

const test = require('node:test')
const assert = require('node:assert')
const { Fleet } = require('../src/core/fleet')
const { FakeBot, VoxelWorld } = require('./helpers/fake')
const { Vec3 } = require('vec3')
const { parseBlueprint } = require('../src/core/pilot/blueprints')
const { runBuilder } = require('../src/core/pilot/builder')
const { Pilot } = require('../src/core/pilot/pilot')

function makeFleet (world) {
  const created = []
  const w = world
  const deps = {
    createBot: (opts) => { const b = new FakeBot(opts, w); created.push(b); return b },
    Vec3
  }
  return { fleet: new Fleet(deps), created, world: w }
}

function flatWorld (half = 24) {
  const w = new VoxelWorld()
  w.ground(-half, -half, half, half, 63)
  return w
}

async function until (fn, label, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('builder: constructs a 3x3 slab at explicit origin over chat command', async () => {
  const w = flatWorld()
  const { fleet, created, world } = makeFleet(w)
  try {
    fleet.add({ name: 'Mason', autoReconnect: false })
    const bot = created[0]
    bot.spawnAt(0, 64, 0)
    bot.setInventory([{ name: 'dirt', count: 16 }])

    const r = await fleet.command('Mason', 'build slab 4 64 0')
    assert.strictEqual(r.ok, true, `build accepted: ${r.error || r.reply}`)
    await until(() => fleet.list()[0].task === 'idle', 'build to finish', 60000)

    for (let x = 4; x <= 6; x++) {
      for (let z = 0; z <= 2; z++) {
        const b = world.blockAtXYZ(x, 64, z)
        assert.ok(b && b.name === 'dirt', `cell ${x},64,${z} is dirt (got ${b ? b.name : 'nothing'})`)
      }
    }
  } finally { fleet.stopAll() }
})

test('builder: second run is a no-op (already satisfied)', async () => {
  const w = flatWorld()
  const { fleet, created, world } = makeFleet(w)
  try {
    fleet.add({ name: 'Mason', autoReconnect: false })
    const bot = created[0]
    bot.spawnAt(0, 64, 0)
    bot.setInventory([{ name: 'dirt', count: 16 }])
    await fleet.command('Mason', 'build slab 4 64 0')
    await until(() => fleet.list()[0].task === 'idle', 'first build', 60000)

    const before = world.blocks.size
    bot.setInventory([])
    await fleet.command('Mason', 'build slab 4 64 0')
    await until(() => fleet.list()[0].task === 'idle', 'second build', 30000)
    assert.strictEqual(world.blocks.size, before, 'nothing changed')
  } finally { fleet.stopAll() }
})

test('builder: digs a wrong block before placing over it', async () => {
  const w = flatWorld()
  w.setBlock(2, 64, 1, 'cobblestone') // squatter in the footprint
  const bot = new FakeBot({ username: 'Mason' }, w)
  bot.spawnAt(0, 64, 0)
  bot.setInventory([{ name: 'dirt', count: 8 }])
  const pilot = new Pilot({ bot, unit: {}, deps: { Vec3 } })
  const bp = parseBlueprint({
    palette: { D: 'dirt' },
    layers: [['DDD', 'DDD', 'DDD']]
  }).blueprint
  const out = await pilot.runJob('build', 'build slab', (alive) => runBuilder(pilot, bp, { x: 1, y: 64, z: 0 }, alive))
  assert.ok(out && out.placed === 9, 'all 9 cells served')
  const b = bot.world.blockAtXYZ(2, 64, 1)
  assert.ok(b && b.name === 'dirt', 'wrong block replaced')
  pilot.dispose()
})

test('builder: fails honestly when out of material', async () => {
  const w = flatWorld()
  const bot = new FakeBot({ username: 'Mason' }, w)
  bot.spawnAt(0, 64, 0)
  bot.setInventory([]) // empty hands
  const pilot = new Pilot({ bot, unit: {}, deps: { Vec3 } })
  const logs = []
  pilot.on('log', (t) => logs.push(t))
  const bp = parseBlueprint({ palette: { S: 'stone' }, layers: [['S']] }).blueprint
  const out = await pilot.runJob('build', 'build', (alive) => runBuilder(pilot, bp, { x: 3, y: 64, z: 0 }, alive))
  assert.strictEqual(out, null, 'job reports failure')
  assert.ok(logs.some((t) => /out of material: stone/.test(t)), `honest log: ${logs.join(' | ')}`)
  pilot.dispose()
})

test('builder: builds bottom-up so upper layers have anchors', async () => {
  const w = flatWorld()
  const world = w
  const bot = new FakeBot({ username: 'Mason' }, w)
  bot.spawnAt(0, 64, 0)
  bot.setInventory([{ name: 'dirt', count: 4 }])
  const pilot = new Pilot({ bot, unit: {}, deps: { Vec3 } })
  const bp = parseBlueprint({
    palette: { D: 'dirt' },
    layers: [['D'], ['D'], ['D'], ['D']]
  }).blueprint
  const out = await pilot.runJob('build', 'build post', (alive) => runBuilder(pilot, bp, { x: 3, y: 64, z: 0 }, alive))
  assert.ok(out && out.placed === 4, 'column complete')
  for (let y = 64; y <= 67; y++) {
    const b = world.blockAtXYZ(3, y, 0)
    assert.ok(b && b.name === 'dirt', `column cell 3,${y},0 is dirt (got ${b ? b.name : 'nothing'})`)
  }
  pilot.dispose()
})

test('builder: refuses cells beyond the loaded world', async () => {
  const w = new VoxelWorld()
  w.ground(-4, -4, 4, 4, 63) // tiny island, the blueprint reaches past it
  const bot = new FakeBot({ username: 'Mason' }, w)
  bot.spawnAt(0, 64, 0)
  bot.setInventory([{ name: 'dirt', count: 99 }])
  const pilot = new Pilot({ bot, unit: {}, deps: { Vec3 } })
  const logs = []
  pilot.on('log', (t) => logs.push(t))
  const bp = parseBlueprint({
    palette: { D: 'dirt' },
    layers: [['DDDDDDDDDDDD']]
  }).blueprint
  const out = await pilot.runJob('build', 'build wide', (alive) => runBuilder(pilot, bp, { x: -2, y: 64, z: 0 }, alive))
  assert.strictEqual(out, null)
  assert.ok(logs.some((t) => /beyond the loaded world/.test(t)), logs.join(' | '))
  pilot.dispose()
})
