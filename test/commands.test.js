'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { parseCommand, helpLines, COMMANDS } = require('../src/util/commands')

test('come: defaults to no player', () => {
  const r = parseCommand('come')
  assert.deepStrictEqual(r, { ok: true, name: 'come', args: { player: null } })
})

test('come: with player', () => {
  const r = parseCommand('Come Steve_99')
  assert.ok(r.ok)
  assert.strictEqual(r.args.player, 'Steve_99')
})

test('come: rejects bad player names', () => {
  assert.ok(!parseCommand('come not;allowed').ok)
  assert.ok(!parseCommand('come a b').ok)
})

test('follow: player and off', () => {
  assert.strictEqual(parseCommand('follow Alex').args.player, 'Alex')
  assert.strictEqual(parseCommand('FOLLOW OFF').args.player, null)
})

test('follow: needs exactly one argument', () => {
  assert.ok(!parseCommand('follow').ok)
  assert.ok(!parseCommand('follow a b').ok)
})

test('goto: 2d form', () => {
  const r = parseCommand('goto 100 -20')
  assert.deepStrictEqual(r.args, { x: 100, y: null, z: -20 })
})

test('goto: 3d form', () => {
  const r = parseCommand('/goto 10 64 -3')
  assert.deepStrictEqual(r.args, { x: 10, y: 64, z: -3 })
})

test('goto: floats allowed', () => {
  const r = parseCommand('goto 1.5 -0.25')
  assert.deepStrictEqual(r.args, { x: 1.5, y: null, z: -0.25 })
})

test('goto: rejects words and world border', () => {
  assert.ok(!parseCommand('goto 10').ok)
  assert.ok(!parseCommand('goto a b').ok)
  assert.ok(!parseCommand('goto 1 2 3 4').ok)
  assert.ok(!parseCommand('goto 30000000 0').ok)
  assert.ok(!parseCommand('goto 99999999 99999999 99999999').ok)
})

test('argless commands reject arguments', () => {
  for (const c of ['stop now', 'where am i', 'eat please', 'help me']) {
    assert.ok(!parseCommand(c).ok, c)
  }
})

test('say: joins the rest of the line', () => {
  const r = parseCommand('say hello big world')
  assert.strictEqual(r.args.message, 'hello big world')
})

test('say: rejects empty and overlong', () => {
  assert.ok(!parseCommand('say').ok)
  assert.ok(!parseCommand('say    ').ok)
  assert.ok(!parseCommand('say ' + 'a'.repeat(257)).ok)
})

test('drop: bare and all', () => {
  assert.deepStrictEqual(parseCommand('drop').args, { all: false })
  assert.deepStrictEqual(parseCommand('DROP ALL').args, { all: true })
  assert.ok(!parseCommand('drop some').ok)
})

test('unknown commands suggest a fix', () => {
  const r = parseCommand('go 10 10')
  assert.ok(!r.ok)
  assert.match(r.error, /did you mean/)
})

test('empty input fails cleanly', () => {
  assert.ok(!parseCommand('').ok)
  assert.ok(!parseCommand(null).ok)
})

test('every command has help text', () => {
  assert.strictEqual(helpLines().length, COMMANDS.length)
  for (const line of helpLines()) assert.ok(line.length > 5)
})

test('mine: parses block name and optional count', () => {
  const r = parseCommand('mine dirt')
  assert.ok(r.ok)
  assert.deepStrictEqual(r.args, { block: 'dirt', count: 1 })

  const r2 = parseCommand('mine stone 4')
  assert.ok(r2.ok)
  assert.deepStrictEqual(r2.args, { block: 'stone', count: 4 })
})

test('mine: rejects junk names and bad counts', () => {
  assert.ok(!parseCommand('mine').ok)
  assert.ok(!parseCommand('mine Dirt Block').ok)
  assert.ok(!parseCommand('mine dirt 0').ok)
  assert.ok(!parseCommand('mine dirt 65').ok)
  assert.ok(!parseCommand('mine dirt x').ok)
  assert.ok(!parseCommand('mine dirt 2 extra').ok)
})

test('build: blueprint name with optional origin coords', () => {
  assert.deepStrictEqual(
    parseCommand('build slab'),
    { ok: true, name: 'build', args: { blueprint: 'slab', x: null, y: null, z: null } }
  )
  assert.deepStrictEqual(
    parseCommand('build post 3 -60 5'),
    { ok: true, name: 'build', args: { blueprint: 'post', x: 3, y: -60, z: 5 } }
  )
  assert.deepStrictEqual(
    parseCommand('build slab 12 30'),
    { ok: true, name: 'build', args: { blueprint: 'slab', x: 12, y: null, z: 30 } }
  )
})

test('build: rejects bad names and coord junk', () => {
  assert.ok(!parseCommand('build').ok)
  assert.ok(!parseCommand('build slab 1 2 3 4').ok)
  assert.ok(!parseCommand('build no spaces').ok)
  assert.ok(!parseCommand('build slab 1 two 3').ok)
  assert.ok(parseCommand('build slab 1 2').ok, 'x z form is legal')
})

test('farm and explore: optional radius with caps', () => {
  assert.deepStrictEqual(parseCommand('farm'), { ok: true, name: 'farm', args: { radius: null } })
  assert.strictEqual(parseCommand('farm 32').args.radius, 32)
  assert.ok(!parseCommand('farm 49').ok)
  assert.ok(!parseCommand('farm 0').ok)
  assert.strictEqual(parseCommand('explore 256').args.radius, 256)
  assert.ok(!parseCommand('explore 257').ok)
  assert.ok(!parseCommand('explore 3 4').ok)
})

test('set: key and value pairs', () => {
  assert.deepStrictEqual(parseCommand('set allowPlace false'), { ok: true, name: 'set', args: { key: 'allowPlace', value: 'false' } })
  assert.ok(!parseCommand('set allowPlace').ok)
  assert.ok(!parseCommand('set').ok)
})
