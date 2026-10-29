#!/usr/bin/env node
'use strict'

// black-box end-to-end check for botfleet.
//
//   1. boots the console (src/index.js) as a child process
//   2. deploys two units against a real minecraft server
//   3. drives them over REST + websocket like a user would
//   4. asserts state, radar frames, chat, commands and movement
//
// prerequisites: a minecraft server (vanilla 1.21.x, online-mode=false)
// listening on MC_HOST:MC_PORT. see scripts/e2e-server.sh to boot one.
//
//   MC_HOST=127.0.0.1 MC_PORT=25565 APP_PORT=3117 node test/live.js

const { spawn } = require('child_process')
const path = require('path')
const WebSocket = require('ws')

const MC_HOST = process.env.MC_HOST || '127.0.0.1'
const MC_PORT = Number(process.env.MC_PORT || 25565)
const APP_PORT = Number(process.env.APP_PORT || 3117)
const BASE = `http://127.0.0.1:${APP_PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get (p) {
  const res = await fetch(BASE + p)
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function post (p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function del (p) {
  const res = await fetch(BASE + p, { method: 'DELETE' })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function until (fn, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${label}`)
    await sleep(700)
  }
}

const results = []
function check (name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function main () {
  // 1. boot the console
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(APP_PORT), HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  app.stdout.on('data', (d) => process.stdout.write('[app] ' + d))
  app.stderr.on('data', (d) => process.stderr.write('[app!] ' + d))

  try {
    await until(async () => {
      try { const h = await get('/api/health'); return h.status === 200 && h.body.ok } catch (e) { return false }
    }, 15000, 'console to listen')
    check('console boots and answers /api/health', true)

    // 2. deploy two units
    const bad = await post('/api/bots', { name: 'no spaces allowed' })
    check('REST validates unit names (400)', bad.status === 400)

    const a = await post('/api/bots', { name: 'Scout', host: MC_HOST, port: MC_PORT })
    check('POST /api/bots Scout (201)', a.status === 201 && a.body.bot.name === 'Scout')

    const dup = await post('/api/bots', { name: 'Scout' })
    check('duplicate unit rejected (409)', dup.status === 409)

    const b = await post('/api/bots', { name: 'Relay', host: MC_HOST, port: MC_PORT })
    check('POST /api/bots Relay (201)', b.status === 201)

    // 3. wait for both units to be in-world
    const scout = await until(async () => {
      const r = await get('/api/bots')
      const s = r.body.bots.find((x) => x.name === 'Scout')
      return s && s.status === 'online' ? s : null
    }, 120000, 'Scout to spawn')
    check('Scout online', true, `v${scout.version} hp ${scout.health} pos ${scout.position.x},${scout.position.y},${scout.position.z}`)

    await until(async () => {
      const r = await get('/api/bots')
      const s = r.body.bots.find((x) => x.name === 'Relay')
      return s && s.status === 'online'
    }, 120000, 'Relay to spawn')
    check('Relay online (fleet of 2)', true)

    // 4. websocket: hello, state, radar
    const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/ws`)
    const msgs = []
    ws.on('message', (m) => { try { msgs.push(JSON.parse(String(m))) } catch (e) { /* ignore */ } })
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

    const hello = await until(() => msgs.find((m) => m.t === 'hello'), 10000, 'hello frame')
    check('WS hello lists the fleet', hello.bots.length === 2, `${hello.bots.map((x) => x.name).join(', ')}`)

    // 5. drive Scout like a user
    const said = await post('/api/bots/Scout/command', { text: 'say hello fleet' })
    check('say command accepted', said.status === 200 && said.body.ok)
    const sawSay = await until(() => msgs.find((m) => m.t === 'log' && /said: hello fleet/.test(m.text)), 15000, 'say log').catch(() => null)
    check('chat reached the world', !!sawSay)

    const where = await post('/api/bots/Scout/command', { text: 'where' })
    const sawWhere = await until(() => msgs.find((m) => m.t === 'log' && /i am at/.test(m.text)), 15000, 'where log').catch(() => null)
    check('where reports position', !!sawWhere && where.body.ok, sawWhere ? sawWhere.text.slice(0, 60) : '')

    const wat = await post('/api/bots/Scout/command', { text: 'definitely_not_a_command' })
    check('invalid command fails softly', wat.status === 200 && wat.body.ok === false)
    const ghost = await post('/api/bots/Ghost/command', { text: 'where' })
    check('command on missing unit (404)', ghost.status === 404)

    // 6. movement: goto across the superflat
    const target = { x: 24, z: -8 }
    const g = await post('/api/bots/Scout/command', { text: `goto ${target.x} ${target.z}` })
    check('goto accepted', g.body.ok, g.body.result ? g.body.result.reply : '')
    const arrived = await until(async () => {
      const r = await get('/api/bots')
      const s = r.body.bots.find((x) => x.name === 'Scout')
      if (s && s.position && Math.abs(s.position.x - target.x) <= 2 && Math.abs(s.position.z - target.z) <= 2) return s
      return null
    }, 120000, 'Scout to walk to 24,-8')
    check('click-to-walk pathfinding works', true, `arrived at ${arrived.position.x},${arrived.position.z}`)

    // 7. radar frames arrive with real terrain
    await sleep(4000)
    const frames = msgs.filter((m) => m.t === 'radar')
    const good = frames.find((f) => {
      if (!f.palette || !f.ids) return false
      const bytes = Buffer.from(f.ids, 'base64')
      if (bytes.length !== f.size * f.size) return false
      // superflat is monotonous: one known block color is enough proof
      return bytes.some((v) => v !== 0)
    })
    check('radar frames stream terrain', !!good, good ? `palette ${good.palette.length} colors, ${good.entities.length} entities` : `${frames.length} frames seen`)

    const states = msgs.filter((m) => m.t === 'state')
    check('state heartbeats stream', states.length >= 5, `${states.length} states`)

    // 7.5 in-game chat bridge: Relay speaks in the world, Scout obeys
    const chatCmd = await post('/api/bots/Relay/command', { text: 'say Scout, come' })
    check('in-game chat command sent', chatCmd.body.ok)
    const cameClose = await until(async () => {
      const r = await get('/api/bots')
      const s = r.body.bots.find((x) => x.name === 'Scout')
      const t = r.body.bots.find((x) => x.name === 'Relay')
      if (!s || !t || !s.position || !t.position) return null
      const dx = s.position.x - t.position.x
      const dz = s.position.z - t.position.z
      return Math.sqrt(dx * dx + dz * dz) <= 4 ? s : null
    }, 120000, 'Scout to come to Relay after in-game chat')
    check('in-game chat commands drive units', true, `Scout at ${cameClose.position.x},${cameClose.position.z}, next to Relay`)

    // 8. decommission
    const gone = await del('/api/bots/Scout')
    check('DELETE decommissions (200)', gone.status === 200)
    await sleep(1500)
    const after = await get('/api/bots')
    check('fleet shrinks to Relay only', after.body.bots.length === 1 && after.body.bots[0].name === 'Relay')
    const ghostDel = await del('/api/bots/Nobody')
    check('DELETE on missing unit (404)', ghostDel.status === 404)
  } finally {
    app.kill('SIGTERM')
    await sleep(300)
    if (!app.killed) app.kill('SIGKILL')
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\ne2e: ${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e crashed:', err.message)
  process.exit(1)
})
