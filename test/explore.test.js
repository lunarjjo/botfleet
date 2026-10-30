'use strict'

// explore process tests: the unit roams to unvisited chunk targets
// within a radius, marks them, and stops when the ring is covered —
// or when the terrain refuses, which must not spin forever.

const test = require('node:test')
const assert = require('node:assert')
const { FakeBot, VoxelWorld } = require('./helpers/fake')
const { Vec3 } = require('vec3')
const { Pilot } = require('../src/core/pilot/pilot')
const { runExplore, pickTarget, CHUNK } = require('../src/core/pilot/explore')

function setup (world, x, y, z) {
  const bot = new FakeBot({ username: 'Ranger' }, world)
  bot.spawnAt(x, y, z)
  const pilot = new Pilot({ bot, unit: {}, deps: { Vec3 } })
  return { bot, pilot }
}

test('explore: chunk targets sit on a 16-block grid', () => {
  const w = new VoxelWorld()
  w.ground(-40, -40, 40, 40, 63)
  const { pilot } = setup(w, 0, 64, 0)
  const t = pickTarget(pilot, new Set(), 32)
  assert.ok(t, 'a target exists')
  // chunk centers are always at +8 within their chunk (mod-safe)
  const mx = ((t.x % CHUNK) + CHUNK) % CHUNK
  const mz = ((t.z % CHUNK) + CHUNK) % CHUNK
  assert.strictEqual(mx, 8)
  assert.strictEqual(mz, 8)
  assert.ok(Math.hypot(t.x, t.z) <= 32)
  // visited targets are skipped
  const visited = new Set([t.k])
  const t2 = pickTarget(pilot, visited, 32)
  assert.ok(t2 && t2.k !== t.k, 'next target is a different chunk')
  pilot.dispose()
})

test('explore: roams several legs then reports the count', async () => {
  const w = new VoxelWorld()
  w.ground(-20, -20, 20, 20, 63) // a modest island: edge targets fail fast
  const { bot, pilot } = setup(w, 0, 64, 0)
  const logs = []
  pilot.on('log', (t) => logs.push(t))
  const out = await pilot.runJob('explore', 'explore r24', (alive) => runExplore(pilot, 24, alive))
  assert.ok(out && out.legs >= 3, `roamed ${out && out.legs} legs`)
  const p = bot.entity.position
  assert.ok(Math.hypot(p.x, p.z) > 6, `the unit actually moved (at ${Math.round(p.x)},${Math.round(p.z)})`)
  assert.ok(logs.some((t) => /explored \d+ targets/.test(t)), logs.join(' | '))
  pilot.dispose()
})

test('explore: an island ring finishes cleanly (partials toward fog count)', async () => {
  const w = new VoxelWorld()
  w.ground(-3, -3, 3, 3, 63) // tiny island
  const { pilot } = setup(w, 0, 64, 0)
  const out = await pilot.runJob('explore', 'explore r16', (alive) => runExplore(pilot, 16, alive))
  // four chunk corners in range: one partial walk per direction, then done
  assert.ok(out && out.legs <= 4, `legs ${out && out.legs}`)
  assert.strictEqual(pilot.task, 'idle', 'the job cleaned up')
  pilot.dispose()
})

test('explore: targets outside the world do not wedge the loop', async () => {
  const w = new VoxelWorld()
  w.ground(-6, -6, 6, 6, 63)
  const { pilot } = setup(w, 0, 64, 0)
  const out = await pilot.runJob('explore', 'explore r24', (alive) => runExplore(pilot, 24, alive))
  // targets beyond the fog end as partial walks or instant skips —
  // either way the loop must terminate and clean up
  assert.ok(out && out.legs <= 9, `legs ${out && out.legs}`)
  assert.strictEqual(pilot.task, 'idle', 'the job cleaned up')
  pilot.dispose()
})
