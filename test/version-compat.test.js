'use strict'

// unit tests for the version-compat overlay: the machinery that keeps
// botfleet current with Minecraft releases the upstream prismarine stack
// does not ship data for yet. everything here runs offline; the live
// per-version e2e lives in test/live.js + the ci matrix.

const { test } = require('node:test')
const assert = require('node:assert')

const compat = require('../src/version-compat')

test('ensureVersionSupport injects pending vendored versions', () => {
  const injected = compat.ensureVersionSupport()
  assert.ok(Array.isArray(injected))
  for (const v of Object.keys(compat.OWN_FILES)) {
    if (compat.isNativelySupported(v)) continue // upstream shipped it: overlay skips
    assert.ok(injected.includes(v), `${v} should be injected`)
  }
})

test('injected versions resolve through minecraft-data with correct protocol numbers', () => {
  const mcData = require('minecraft-data')
  for (const v of Object.keys(compat.OWN_FILES)) {
    if (!compat.hasVendoredData(v)) continue
    const d = mcData(v)
    assert.ok(d, `mcData('${v}') must resolve`)
    assert.ok(d.version.version > 0, `${v} needs a real protocol number`)
    assert.ok(d.blocksArray.length > 100, `${v} blocks should be loaded`)
    assert.ok(d.itemsArray.length > 100, `${v} items should be loaded`)
    if (v === '26.2') assert.strictEqual(d.version.version, 776)
    if (v === '26.3') assert.strictEqual(d.version.version, 777)
  }
})

test('ensureVersionSupport is idempotent', () => {
  const a = compat.ensureVersionSupport()
  const b = compat.ensureVersionSupport()
  assert.deepStrictEqual(a, b)
  const mfVersion = require('mineflayer/lib/version.js')
  for (const v of a) {
    assert.strictEqual(mfVersion.testedVersions.filter((x) => x === v).length, 1, `no duplicate ${v}`)
  }
})

test('official versions keep working untouched', () => {
  const mcData = require('minecraft-data')
  const d = mcData('1.21.8')
  assert.ok(d && d.version.version === 772)
})

test('supportedVersions reports official and overlay separately', () => {
  const s = compat.supportedVersions()
  assert.ok(Array.isArray(s.official) && s.official.includes('1.21.8'))
  assert.ok(s.all.includes('1.21.8'))
  for (const v of Object.keys(compat.OWN_FILES)) {
    if (compat.isNativelySupported(v)) {
      assert.ok(!s.overlay.includes(v), `${v} is official now, overlay must step aside`)
    } else {
      assert.ok(s.overlay.includes(v), `${v} should be listed as overlay support`)
      assert.ok(s.all.includes(v))
    }
  }
})

test('behaviors are version-gated', () => {
  assert.deepStrictEqual(compat.behaviorsFor('26.2'), {})
  assert.deepStrictEqual(compat.behaviorsFor('1.21.8'), {})
  const be = compat.behaviorsFor('26.3')
  assert.ok(be.teleportConfirmEcho && be.clientTickEnd && be.playerActionShift && be.entityDeltaPackets)
})

// ---- entityDelta codec (the 26.3 stepped entity-move encoding) ----

function entityDeltaNative () {
  const mcTypes = require('minecraft-protocol/src/datatypes/minecraft.js')
  return mcTypes.entityDelta
}

function roundTrip (value) {
  const native = entityDeltaNative()
  assert.ok(native, 'entityDelta native should be registered')
  const [read, write, sizeOf] = native
  const size = sizeOf(value)
  const buf = Buffer.alloc(size)
  const end = write(value, buf, 0)
  assert.strictEqual(end, size, 'write should fill exactly sizeOf bytes')
  const parsed = read(buf, 0)
  assert.strictEqual(parsed.size, size, 'read should consume exactly sizeOf bytes')
  return parsed.value
}

test('entityDelta round-trips the linear (flat 3x i16) variant', () => {
  const value = { onGround: true, steps: [{ dX: 12, dY: -3, dZ: 40, ticks: 0 }] }
  const out = roundTrip(value)
  assert.strictEqual(out.onGround, true)
  assert.strictEqual(out.steps.length, 1)
  assert.deepStrictEqual(
    { dX: out.steps[0].dX, dY: out.steps[0].dY, dZ: out.steps[0].dZ, ticks: out.steps[0].ticks },
    { dX: 12, dY: -3, dZ: 40, ticks: 0 }
  )
})

test('entityDelta round-trips the stepped variant with several steps', () => {
  const value = {
    onGround: false,
    steps: [
      { dX: 1, dY: 2, dZ: 3, ticks: 4 },
      { dX: -5, dY: 6, dZ: -7, ticks: 9 }
    ]
  }
  const out = roundTrip(value)
  assert.strictEqual(out.onGround, false)
  assert.strictEqual(out.steps.length, 2)
  assert.deepStrictEqual(
    out.steps.map((s) => [s.dX, s.dY, s.dZ, s.ticks]),
    [[1, 2, 3, 4], [-5, 6, -7, 9]]
  )
})

test('entityDelta throws PartialReadError on truncated buffers', () => {
  const native = entityDeltaNative()
  const [read, write, sizeOf] = native
  const value = { onGround: true, steps: [{ dX: 1, dY: 2, dZ: 3, ticks: 0 }] }
  const buf = Buffer.alloc(sizeOf(value))
  write(value, buf, 0)
  for (let cut = 0; cut < buf.length; cut++) {
    assert.throws(() => read(buf.subarray(0, cut), 0), /partial/i, `cut at ${cut} should fail`)
  }
})

// ---- applyClientCompat write wrapper ----

function fakeBot () {
  const writes = []
  const emitted = []
  const client = {
    version: undefined,
    write (name, params) { writes.push([name, params]) },
    emit (...args) { emitted.push(args) }
  }
  const bot = {
    _client: client,
    entity: { position: { x: 10.5, y: -60.0, z: -9.5 }, yaw: 0.5, pitch: -0.25 }
  }
  return { writes, emitted, client, bot }
}

test('applyClientCompat echoes position on teleport_confirm for 26.3', () => {
  const { writes, client, bot } = fakeBot()
  client.version = '26.3'
  compat.applyClientCompat(bot, '26.3')
  client.write('teleport_confirm', { teleportId: 42 })
  const [name, params] = writes[0]
  assert.strictEqual(name, 'teleport_confirm')
  assert.strictEqual(params.teleportId, 42)
  assert.strictEqual(params.x, 10.5)
  assert.strictEqual(params.y, -60.0)
  assert.strictEqual(params.z, -9.5)
  assert.ok(typeof params.yRot === 'number' && Number.isFinite(params.yRot))
  assert.ok(typeof params.xRot === 'number' && Number.isFinite(params.xRot))
})

test('applyClientCompat shifts block_dig statuses for 26.3', () => {
  const { writes, client, bot } = fakeBot()
  client.version = '26.3'
  compat.applyClientCompat(bot, '26.3')
  client.write('block_dig', { status: 0 })
  client.write('block_dig', { status: 1 }) // upstream "cancel digging" -> 26.3 abort
  client.write('block_dig', { status: 2 }) // upstream "finish digging" -> 26.3 finish
  assert.deepStrictEqual(writes.map((w) => w[1].status), [0, 2, 3])
})

test('applyClientCompat appends tick_end after movement packets for 26.3', () => {
  const { writes, client, bot } = fakeBot()
  client.version = '26.3'
  compat.applyClientCompat(bot, '26.3')
  client.write('position', { x: 1, y: 2, z: 3, flags: {} })
  client.write('chat_message', { message: 'hi' })
  client.write('flying', {})
  const names = writes.map((w) => w[0])
  assert.deepStrictEqual(names, ['position', 'tick_end', 'chat_message', 'flying', 'tick_end'])
})

test('applyClientCompat leaves other versions untouched', () => {
  const { writes, client, bot } = fakeBot()
  client.version = '26.2'
  compat.applyClientCompat(bot, '26.2')
  client.write('teleport_confirm', { teleportId: 7 })
  client.write('block_dig', { status: 2 })
  client.write('position', { x: 1, y: 2, z: 3, flags: {} })
  assert.deepStrictEqual(writes.map((w) => w[0]), ['teleport_confirm', 'block_dig', 'position'])
  assert.strictEqual(writes[0][1].x, undefined)
  assert.strictEqual(writes[1][1].status, 2)
})

test('applyClientCompat resolves an auto-detected version lazily', () => {
  const { writes, client, bot } = fakeBot()
  compat.applyClientCompat(bot) // no version yet (autoVersion path)
  client.version = '26.3' // negotiated during login
  client.write('position', { x: 1, y: 2, z: 3, flags: {} })
  assert.deepStrictEqual(writes.map((w) => w[0]), ['position', 'tick_end'])
})

test('applyClientCompat restore hook reinstates the raw write', () => {
  const { writes, client, bot } = fakeBot()
  client.version = '26.3'
  const restore = compat.applyClientCompat(bot, '26.3')
  client.write('position', { x: 1, y: 2, z: 3, flags: {} })
  restore()
  client.write('position', { x: 4, y: 5, z: 6, flags: {} })
  assert.deepStrictEqual(writes.map((w) => w[0]), ['position', 'tick_end', 'position'])
})

test('applyClientCompat flattens VecDelta entity moves for 26.3', () => {
  const { emitted, client, bot } = fakeBot()
  client.version = '26.3'
  compat.applyClientCompat(bot, '26.3')
  client.emit('rel_entity_move', {
    entityId: 7,
    move: { onGround: true, steps: [{ dX: 10, dY: 0, dZ: 20, ticks: 0 }, { dX: 5, dY: 1, dZ: 6, ticks: 2 }] }
  })
  client.emit('entity_move_look', {
    entityId: 8,
    move: { onGround: false, steps: [{ dX: 3, dY: 4, dZ: 5, ticks: 0 }] },
    yaw: 90,
    pitch: -30
  })
  const [n1, p1] = emitted[0]
  const [n2, p2] = emitted[1]
  assert.strictEqual(n1, 'rel_entity_move')
  assert.deepStrictEqual(
    { dX: p1.dX, dY: p1.dY, dZ: p1.dZ, onGround: p1.onGround, hasMove: 'move' in p1 },
    { dX: 15, dY: 1, dZ: 26, onGround: true, hasMove: false }
  )
  assert.strictEqual(p1.entityId, 7)
  assert.strictEqual(n2, 'entity_move_look')
  assert.deepStrictEqual({ dX: p2.dX, dY: p2.dY, dZ: p2.dZ, yaw: p2.yaw, pitch: p2.pitch }, { dX: 3, dY: 4, dZ: 5, yaw: 90, pitch: -30 })
})

test('applyClientCompat flattens stepped sync_entity_position for 26.3', () => {
  const { emitted, client, bot } = fakeBot()
  client.version = '26.3'
  compat.applyClientCompat(bot, '26.3')
  client.emit('sync_entity_position', {
    entityId: 9,
    positionType: 'stepped',
    steps: [{ x: 1, y: 2, z: 3, tickOffset: 0 }, { x: 4, y: 5, z: 6, tickOffset: 3 }],
    yaw: 10,
    pitch: -5,
    onGround: true
  })
  client.emit('sync_entity_position', { entityId: 10, positionType: 'linear', x: 7, y: 8, z: 9, yaw: 0, pitch: 0, onGround: false })
  const p1 = emitted[0][1]
  assert.deepStrictEqual(
    { x: p1.x, y: p1.y, z: p1.z, dx: p1.dx, dy: p1.dy, dz: p1.dz, hasSteps: 'steps' in p1 },
    { x: 4, y: 5, z: 6, dx: 0, dy: 0, dz: 0, hasSteps: false }
  )
  assert.strictEqual(p1.entityId, 9)
  assert.strictEqual(p1.yaw, 10)
  const p2 = emitted[1][1]
  assert.deepStrictEqual({ x: p2.x, y: p2.y, z: p2.z, dx: p2.dx, dy: p2.dy, dz: p2.dz }, { x: 7, y: 8, z: 9, dx: 0, dy: 0, dz: 0 })
})

test('applyClientCompat passes entity moves through untouched on other versions', () => {
  const { emitted, client, bot } = fakeBot()
  client.version = '26.2'
  compat.applyClientCompat(bot, '26.2')
  const packet = { entityId: 7, dX: 15, dY: 1, dZ: 26, onGround: true }
  client.emit('rel_entity_move', packet)
  assert.deepStrictEqual(emitted[0][1], packet)
})

test('applyClientCompat preserves extra emit arguments (metadata, buffers)', () => {
  const { emitted, client, bot } = fakeBot()
  client.version = '26.3'
  compat.applyClientCompat(bot, '26.3')
  const meta = { name: 'rel_entity_move' }
  const raw = Buffer.from('raw-bytes')
  client.emit('rel_entity_move', { entityId: 7, move: { onGround: true, steps: [{ dX: 2, dY: 0, dZ: 0, ticks: 0 }] } }, meta, raw)
  const args = emitted[0]
  assert.strictEqual(args.length, 4, 'name, data, metadata and raw buffer must all arrive')
  assert.strictEqual(args[0], 'rel_entity_move')
  assert.strictEqual(args[1].dX, 2)
  assert.strictEqual(args[2], meta)
  assert.strictEqual(args[3], raw)
})
