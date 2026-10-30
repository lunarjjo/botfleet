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
const net = require('net')
const path = require('path')
const WebSocket = require('ws')

const MC_HOST = process.env.MC_HOST || '127.0.0.1'
const MC_PORT = Number(process.env.MC_PORT || 25565)
const APP_PORT = Number(process.env.APP_PORT || 3117)
const BASE = `http://127.0.0.1:${APP_PORT}`

// set BOTFLEET_LIVE_E2E=1 to REQUIRE the live suite (fails fast when no
// server answers) instead of letting it self-skip. CI runs without a
// minecraft server, so the default there is a skip with a clear notice.
const FORCE_LIVE = process.env.BOTFLEET_LIVE_E2E === '1'

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

// probe the server socket once, with a short timeout, so the suite can
// decide between "run everything" and "self-skip" in under two seconds.
function serverReachable (host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (ok) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

async function main () {
  // 0. is there actually a minecraft server to drive? without one the
  // units can never spawn, and waiting two minutes to learn that helps
  // nobody — skip cleanly (or fail fast when the run is forced).
  const reachable = await serverReachable(MC_HOST, MC_PORT)
  if (!reachable) {
    if (FORCE_LIVE) {
      console.error(`FATAL  live e2e forced via BOTFLEET_LIVE_E2E=1, but no server answers at ${MC_HOST}:${MC_PORT}`)
      console.error('       boot one first: ./scripts/e2e-server.sh')
      process.exit(1)
    }
    console.log(`SKIP   live e2e — no minecraft server at ${MC_HOST}:${MC_PORT}`)
    console.log('       boot one with ./scripts/e2e-server.sh, or set BOTFLEET_LIVE_E2E=1 to require it')
    process.exit(0)
  }

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

    // 9. pilot engine: long-range goto across the superflat
    const relayNow = (await get('/api/bots')).body.bots.find((b) => b.name === 'Relay')
    const start = relayNow.position
    const far = { x: Math.round(start.x) + 60, z: Math.round(start.z) }
    let maxPathLen = 0
    const farCmd = await post('/api/bots/Relay/command', { text: `goto ${far.x} ${far.z}` })
    check('pilot: long goto accepted', farCmd.body.ok)
    await until(async () => {
      const r = await get('/api/bots')
      const b = r.body.bots.find((x) => x.name === 'Relay')
      if (b && b.path) maxPathLen = Math.max(maxPathLen, b.path.length)
      return b && b.task === 'idle'
    }, 150000, 'Relay to walk 60 blocks')
    const relayDone = (await get('/api/bots')).body.bots.find((b) => b.name === 'Relay')
    const dx = Math.abs(relayDone.position.x - far.x)
    const dz = Math.abs(relayDone.position.z - far.z)
    check('pilot: walks 60 blocks and arrives', dx <= 2 && dz <= 2,
      `landed at ${Math.round(relayDone.position.x)},${Math.round(relayDone.position.z)} (target ${far.x},${far.z})`)
    check('pilot: the plan streams to the console', maxPathLen >= 10, `longest path frame: ${maxPathLen} points`)

    // 10. pilot engine: mine by block name
    const mineCmd = await post('/api/bots/Relay/command', { text: 'mine grass_block 2' })
    check('pilot: mine accepted', mineCmd.body.ok)
    const minedLog = await until(async () => {
      const r = await get('/api/bots')
      const b = r.body.bots.find((x) => x.name === 'Relay')
      return b && b.task === 'idle' ? 'done' : null
    }, 180000, 'Relay to mine 2 grass blocks').then(() => true)
    const minedSeen = msgs.find((m) => m.t === 'log' && m.name === 'Relay' && /mined 2 grass_block/.test(m.text))
    check('pilot: mines real blocks by name', !!minedSeen && !!minedLog, minedSeen ? minedSeen.text : 'no mine log seen')

    // 10.5 builder process: gather dirt, then construct a blueprint.
    // mining on a live server can drop items the bot never touches, so
    // the whole gather-and-build cycle retries — like a real operator.
    let built = null
    for (let attempt = 1; attempt <= 2 && !built; attempt++) {
      await post('/api/bots/Relay/command', { text: 'mine dirt 11' })
      await until(async () => {
        const r = await get('/api/bots')
        const b = r.body.bots.find((x) => x.name === 'Relay')
        return b && b.task === 'idle'
      }, 240000, `Relay to mine dirt (attempt ${attempt})`).catch(() => null)
      const relayHere = (await get('/api/bots')).body.bots.find((b) => b.name === 'Relay')
      if (!relayHere) break
      const slabX = Math.round(relayHere.position.x) + 5
      const slabZ = Math.round(relayHere.position.z) + 5
      if (attempt === 1) {
        const buildCmd = await post('/api/bots/Relay/command', { text: `build slab ${slabX} ${slabZ}` })
        check('pilot: build command accepted', buildCmd.body.ok, buildCmd.body.result ? buildCmd.body.result.reply : '')
      } else {
        await post('/api/bots/Relay/command', { text: `build slab ${slabX} ${slabZ}` })
      }
      built = await until(() => msgs.find((m) => m.t === 'log' && m.name === 'Relay' && /build complete: 9\/9/.test(m.text)), 240000, `Relay to finish the slab (attempt ${attempt})`).catch(() => null)
      if (!built) {
        await post('/api/bots/Relay/command', { text: 'stop' })
        await until(async () => {
          const r = await get('/api/bots')
          const b = r.body.bots.find((x) => x.name === 'Relay')
          return b && b.task === 'idle'
        }, 20000, 'Relay to settle').catch(() => null)
      }
    }
    check('pilot: builder constructs the blueprint', !!built, built ? built.text : 'no build-complete log across attempts')

    await until(async () => {
      const r = await get('/api/bots')
      return r.body.bots.length === 1
    }, 5000, 'fleet to settle').catch(() => null)
    const relayGone = await del('/api/bots/Relay')
    check('DELETE Relay before the terrain phase (200)', relayGone.status === 200)

    // 11. pilot engine: natural terrain server — real hills, real pathing
    const terrain = spawn('bash', [path.join(__dirname, '..', 'scripts', 'e2e-server.sh')], {
      env: Object.assign({}, process.env, {
        MC_DIR: 'server-normal',
        MC_PORT: '25566',
        MC_LEVEL_TYPE: 'default',
        MC_SEED: 'botfleet2',
        MC_VERSION: process.env.MC_VERSION || '1.21.8' // e2e the same version as the flat server
      }),
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    terrain.stdout.on('data', (d) => process.stdout.write('[terrain] ' + d))
    terrain.stderr.on('data', (d) => process.stderr.write('[terrain!] ' + d))
    try {
      const terrainUp = await until(async () => serverReachable('127.0.0.1', 25566, 2000), 180000, 'terrain server to boot')
      check('terrain server boots (natural world)', !!terrainUp)
      const ranger = await post('/api/bots', { name: 'Ranger', host: MC_HOST, port: 25566 })
      check('POST /api/bots Ranger on terrain (201)', ranger.status === 201 && ranger.body.bot.name === 'Ranger')
      await until(async () => {
        const r = await get('/api/bots')
        const b = r.body.bots.find((x) => x.name === 'Ranger')
        return b && b.status === 'online'
      }, 120000, 'Ranger to spawn on terrain')
      const rStart = (await get('/api/bots')).body.bots.find((b) => b.name === 'Ranger').position
      const tTarget = { x: Math.round(rStart.x) + 40, z: Math.round(rStart.z) }
      let yMin = rStart.y
      let yMax = rStart.y
      let terrainReplans = 0
      const walk = await post('/api/bots/Ranger/command', { text: `goto ${tTarget.x} ${tTarget.z}` })
      check('pilot: terrain goto accepted', walk.body.ok)
      await until(async () => {
        const r = await get('/api/bots')
        const b = r.body.bots.find((x) => x.name === 'Ranger')
        if (b) {
          if (b.position) {
            yMin = Math.min(yMin, b.position.y)
            yMax = Math.max(yMax, b.position.y)
          }
          if (b.pilot) terrainReplans = Math.max(terrainReplans, b.pilot.replans || 0)
        }
        return b && b.task === 'idle'
      }, 200000, 'Ranger to cross 40 blocks of terrain')
      const rEnd = (await get('/api/bots')).body.bots.find((b) => b.name === 'Ranger').position
      const tdx = Math.abs(rEnd.x - tTarget.x)
      const tdz = Math.abs(rEnd.z - tTarget.z)
      check('pilot: crosses natural terrain and arrives', tdx <= 3.5 && tdz <= 3.5,
        `from ${Math.round(rStart.x)},${Math.round(rStart.y)},${Math.round(rStart.z)} to ${Math.round(rEnd.x)},${Math.round(rEnd.y)},${Math.round(rEnd.z)} (y range ${Math.round(yMin)}..${Math.round(yMax)}, ${terrainReplans} replans)`)
      check('pilot: terrain crossing handled elevation', (yMax - yMin) >= 1 || terrainReplans >= 1,
        `y range ${Math.round(yMin)}..${Math.round(yMax)}, replans ${terrainReplans}`)

      // 11.5 explore process on natural terrain: either the ring finishes
      // with a summary log, or the bot is plainly far from where it started
      const rBefore = (await get('/api/bots')).body.bots.find((b) => b.name === 'Ranger').position
      const expCmd = await post('/api/bots/Ranger/command', { text: 'explore 24' })
      check('pilot: explore accepted', expCmd.body.ok, expCmd.body.result ? expCmd.body.result.reply : '')
      const roamed = await until(async () => {
        const done = msgs.find((m) => m.t === 'log' && m.name === 'Ranger' && /explored \d+ targets/.test(m.text))
        if (done) return { done }
        const r = await get('/api/bots')
        const b = r.body.bots.find((x) => x.name === 'Ranger')
        if (b && b.position && Math.hypot(b.position.x - rBefore.x, b.position.z - rBefore.z) > 20) {
          return { roamed: true }
        }
        return null
      }, 200000, 'Ranger to roam unvisited chunks').catch(() => null)
      const legs = roamed && roamed.done ? Number(roamed.done.text.match(/explored (\d+) targets/)[1]) : null
      check('pilot: explores unvisited chunks on real terrain', !!roamed,
        legs !== null ? `${legs} legs covered` : 'roamed over 20 blocks from the origin')

      const rangerGone = await del('/api/bots/Ranger')
      check('DELETE Ranger (200)', rangerGone.status === 200)
    } finally {
      terrain.kill('SIGTERM')
      await sleep(1500)
      if (!terrain.killed) terrain.kill('SIGKILL')
    }
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
