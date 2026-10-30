'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { parseBlueprint, MAX_PLACEMENTS } = require('../src/core/pilot/blueprints')

test('blueprints: layers form parses to placements', () => {
  const r = parseBlueprint({
    name: 'slab',
    palette: { D: 'dirt' },
    layers: [['DDD', 'D.D', 'DDD']]
  })
  assert.ok(r.ok)
  const bp = r.blueprint
  assert.strictEqual(bp.name, 'slab')
  assert.strictEqual(bp.size.x, 3)
  assert.strictEqual(bp.size.y, 1)
  assert.strictEqual(bp.size.z, 3)
  // 9 cells: the center one must be a clear ('air') instruction
  const center = bp.placements.find((p) => p.x === 1 && p.z === 1)
  assert.strictEqual(center.block, 'air')
  const corner = bp.placements.find((p) => p.x === 0 && p.z === 0)
  assert.strictEqual(corner.block, 'dirt')
  assert.strictEqual(bp.placements.length, 9)
})

test('blueprints: geometry is x across row chars, z down rows, y by stack', () => {
  const r = parseBlueprint({
    palette: { A: 'stone' },
    layers: [
      ['A.'],
      ['.A']
    ]
  })
  assert.ok(r.ok)
  const at = (x, y, z) => r.blueprint.placements.find((p) => p.x === x && p.y === y && p.z === z)
  // layer 0 row 0 "A." -> x0 stone, x1 air (z=0); layer 1 row 0 ".A"
  assert.strictEqual(at(0, 0, 0).block, 'stone')
  assert.strictEqual(at(1, 0, 0).block, 'air')
  assert.strictEqual(at(0, 1, 0).block, 'air')
  assert.strictEqual(at(1, 1, 0).block, 'stone')
})

test('blueprints: blocks form parses and bounds are computed', () => {
  const r = parseBlueprint({
    name: 'post',
    blocks: [
      { x: 0, y: 0, z: 0, block: 'cobblestone' },
      { x: 0, y: 3, z: 0, block: 'cobblestone' }
    ]
  })
  assert.ok(r.ok)
  assert.strictEqual(r.blueprint.size.y, 4)
  assert.strictEqual(r.blueprint.min.y, 0)
  assert.strictEqual(r.blueprint.placements.length, 2)
})

test('blueprints: rejects structurally broken input', () => {
  assert.ok(!parseBlueprint(null).ok)
  assert.ok(!parseBlueprint({}).ok)
  assert.ok(!parseBlueprint({ layers: [] }).ok)
  assert.ok(!parseBlueprint({ layers: [['DD'], ['D']] }).ok, 'ragged rows rejected')
  assert.ok(!parseBlueprint({ palette: { D: 'dirt' }, layers: [['DX']] }).ok, 'unknown palette char rejected')
  assert.ok(!parseBlueprint({ blocks: [{ x: 0, y: 0 }] }).ok, 'missing z rejected')
  assert.ok(!parseBlueprint({ blocks: [{ x: 0, y: 0, z: 0, block: 'Not A Block' }] }).ok)
  assert.ok(!parseBlueprint({ blocks: [] }).ok)
  assert.ok(!parseBlueprint({ blocks: [{ x: 1.5, y: 0, z: 0, block: 'stone' }] }).ok, 'non-integer coords rejected')
})

test('blueprints: air clears are legal in the blocks form', () => {
  const r = parseBlueprint({
    blocks: [{ x: 0, y: 0, z: 0, block: 'air' }]
  })
  assert.ok(r.ok)
  assert.strictEqual(r.blueprint.placements[0].block, 'air')
})

test('blueprints: oversized volumes are refused', () => {
  const wall = []
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 48; x++) wall.push({ x, y, z: 0, block: 'stone' })
  }
  wall.push({ x: 0, y: 0, z: 0, block: 'stone' })
  const tooMany = []
  for (let i = 0; i <= MAX_PLACEMENTS; i++) {
    tooMany.push({ x: i % 40, y: Math.floor(i / 40) % 40, z: 0, block: 'stone' })
  }
  assert.ok(!parseBlueprint({ blocks: tooMany }).ok, 'over the cap refused')
  assert.ok(parseBlueprint({ blocks: wall.slice(0, 100) }).ok, 'normal sizes pass')
})
