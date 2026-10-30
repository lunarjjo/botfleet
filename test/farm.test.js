'use strict'

// farm process tests: mature crops are harvested and replanted, immature
// ones are left alone, the standing column is never harvested, and the
// pass ends cleanly when nothing mature is left.

const test = require('node:test')
const assert = require('node:assert')
const { FakeBot, VoxelWorld } = require('./helpers/fake')
const { Vec3 } = require('vec3')
const { Pilot } = require('../src/core/pilot/pilot')
const { runFarm, scan, matureCrop } = require('../src/core/pilot/farm')

function cropWorld () {
  const w = new VoxelWorld()
  w.ground(-20, -20, 20, 20, 63)
  // a wheat field strip at z=3 with mixed maturity
  for (let x = -3; x <= 3; x++) {
    w.setBlock(x, 62, 3, 'farmland')
    const age = x % 2 === 0 ? '7' : '2'
    w.setBlock(x, 63, 3, 'wheat', 'empty', { age })
  }
  // nether wart patch on soul sand
  w.setBlock(0, 62, -5, 'soul_sand')
  w.setBlock(0, 63, -5, 'nether_wart', 'empty', { age: '3' })
  // a carrot patch, mature, but the bot carries no carrot to replant
  w.setBlock(-8, 62, -2, 'farmland')
  w.setBlock(-8, 63, -2, 'carrots', 'empty', { age: '7' })
  return w
}

function setup (world, items) {
  const bot = new FakeBot({ username: 'Farmer' }, world)
  bot.spawnAt(0, 64, 0)
  bot.setInventory(items)
  const pilot = new Pilot({ bot, unit: {}, deps: { Vec3 } })
  return { bot, pilot }
}

test('farm: maturity detection reads block state ages', () => {
  const reg = require('./helpers/fake').mcData
  const mk = (name, age) => ({ name, properties: { age } })
  assert.ok(matureCrop(mk('wheat', '7')))
  assert.ok(!matureCrop(mk('wheat', '6')))
  assert.ok(!matureCrop(mk('wheat', undefined)))
  assert.ok(matureCrop(mk('nether_wart', '3')))
  assert.ok(!matureCrop(mk('nether_wart', '2')))
  assert.ok(!matureCrop(mk('stone', '7')))
  void reg
})

test('farm: scan finds mature crops nearest first, skips own column', () => {
  const w = cropWorld()
  // standing in the middle of the field: the column at x=0,z=3 must be skipped
  const { pilot } = setup(w, [])
  const found = scan(pilot, 16)
  assert.ok(found.length >= 4, `found ${found.length} mature crops`)
  assert.ok(found.every((c) => !(c.x === 0 && c.z === 0)), 'own column excluded')
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i - 1].d <= found[i].d, 'sorted by distance')
  }
  pilot.dispose()
})

test('farm: harvests mature wheat, replants from seeds, leaves immature', async () => {
  const w = cropWorld()
  const { bot, pilot } = setup(w, [{ name: 'wheat_seeds', count: 8 }])
  const logs = []
  pilot.on('log', (t) => logs.push(t))
  const out = await pilot.runJob('farm', 'farm r16', (alive) => runFarm(pilot, 16, alive))
  assert.ok(out && out.harvested >= 5, `harvested ${out && out.harvested}`)

  // every even-x wheat was mature -> dug -> replanted (young again)
  for (let x = -2; x <= 2; x += 2) {
    const b = w.blockAtXYZ(x, 63, 3)
    assert.ok(b && b.name === 'wheat', `replanted wheat at ${x},63,3 (got ${b ? b.name : 'nothing'})`)
  }
  // odd-x wheat was immature (age 2) -> untouched, still age 2
  const young = w.blockAtXYZ(1, 63, 3)
  assert.ok(young && young.properties && young.properties.age === '2', 'immature crop untouched')
  // the carrot patch was harvested but NOT replanted: no carrot in stock
  const carrots = w.blockAtXYZ(-8, 63, -2)
  assert.ok(!carrots || carrots.name === 'air', 'carrots harvested, nothing to replant with')
  assert.ok(logs.some((t) => /harvested \d+ crops/.test(t)), logs.join(' | '))
  pilot.dispose()
})

test('farm: nether wart replants on soul sand', async () => {
  const w = cropWorld()
  const { bot, pilot } = setup(w, [{ name: 'nether_wart', count: 4 }])
  await pilot.runJob('farm', 'farm r16', (alive) => runFarm(pilot, 16, alive))
  const b = w.blockAtXYZ(0, 63, -5)
  assert.ok(b && b.name === 'nether_wart', 'nether wart replanted on soul sand')
  pilot.dispose()
})

test('farm: without seeds the crop is still harvested (no replant)', async () => {
  const w = cropWorld()
  const { pilot } = setup(w, [])
  const out = await pilot.runJob('farm', 'farm r16', (alive) => runFarm(pilot, 16, alive))
  assert.ok(out && out.harvested >= 5)
  // no seeds in the inventory: the harvested cell stays air
  const cell = w.blockAtXYZ(-2, 63, 3)
  assert.ok(cell && cell.name === 'air', 'harvested wheat left no replant behind')
  const soil = w.blockAtXYZ(-2, 62, 3)
  assert.ok(soil && soil.name === 'farmland', 'farmland not broken')
  pilot.dispose()
})

test('farm: radius gates the scan', async () => {
  const w = cropWorld()
  const { pilot } = setup(w, [])
  const found = scan(pilot, 3)
  assert.ok(found.every((c) => Math.abs(c.x) <= 3 + 0.5), `small radius keeps the field out: ${found.length}`)
  pilot.dispose()
})

test('farm: reports cleanly when nothing is mature', async () => {
  const w = new VoxelWorld()
  w.ground(-6, -6, 6, 6, 63)
  const { pilot } = setup(w, [])
  const logs = []
  pilot.on('log', (t) => logs.push(t))
  const out = await pilot.runJob('farm', 'farm r8', (alive) => runFarm(pilot, 8, alive))
  assert.ok(out && out.harvested === 0)
  assert.ok(logs.some((t) => /no mature crops/.test(t)))
  pilot.dispose()
})
