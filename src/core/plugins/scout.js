'use strict'

const { blockColor, isAirLike } = require('../../util/blocks')

// the scout turns loaded chunks into a lightweight 2D tactical map.
// design: per-chunk surface caches (topmost non-air block per column),
// incremental rescans on blockUpdate, a small scan budget per tick so
// bursts of chunk loads never block the event loop, and a compact frame
// (palette + base64 ids + base64 relative heights + entities) at 1 fps.
function attachScout (unit, bot) {
  const RADIUS = 32
  const FRAME_MS = 1000
  const SCAN_TICK_MS = 60
  const CHUNKS_PER_TICK = 6
  const Y_UP = 28
  const Y_DOWN = 16

  const { Vec3 } = unit.deps
  const names = ['__unknown']
  const nameIndex = new Map([['__unknown', 0]])
  const chunks = new Map() // "cx,cz" -> { ids: Uint8Array(256), ys: Int16Array(256) }
  const dirty = new Set()
  const queue = []
  const queued = new Set()

  function idx (name) {
    let i = nameIndex.get(name)
    if (i === undefined) {
      i = names.length
      if (i > 255) return 0 // palette overflow guard: collapse to unknown
      names.push(name)
      nameIndex.set(name, i)
    }
    return i
  }

  function key (cx, cz) { return cx + ',' + cz }

  function scanChunk (cx, cz) {
    const ids = new Uint8Array(256)
    const ys = new Int16Array(256)
    const top = Math.floor(bot.entity.position.y) + Y_UP
    const bottom = Math.floor(bot.entity.position.y) - Y_DOWN
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const x = cx * 16 + lx
        const z = cz * 16 + lz
        let found = 0
        for (let y = top; y >= bottom; y--) {
          let block = null
          try { block = bot.world.getBlock(new Vec3(x, y, z)) } catch (e) { block = null }
          if (block && !isAirLike(block.name)) {
            found = idx(block.name)
            ys[lz * 16 + lx] = y
            break
          }
        }
        ids[lz * 16 + lx] = found
      }
    }
    chunks.set(key(cx, cz), { ids, ys })
  }

  function onBlockUpdate (oldBlock) {
    try {
      const p = oldBlock.position
      dirty.add(key(p.x >> 4, p.z >> 4))
    } catch (e) { /* malformed event */ }
  }

  function enqueue (k, cx, cz, priority) {
    if (queued.has(k)) return
    queued.add(k)
    queue.push({ k, cx, cz, priority })
  }

  const scanTimer = setInterval(() => {
    if (!bot.entity) return
    const bx = bot.entity.position.x
    const bz = bot.entity.position.z

    // rescans first (world changed under us)
    for (const k of dirty) {
      const [cx, cz] = k.split(',').map(Number)
      dirty.delete(k)
      enqueue(k, cx, cz, -1) // priority: immediate
    }

    let budget = CHUNKS_PER_TICK
    while (budget > 0 && queue.length > 0) {
      // pick the highest-priority pending chunk (negative = dirty, then by distance)
      let bestI = 0
      let bestScore = Infinity
      for (let i = 0; i < Math.min(queue.length, 64); i++) {
        const c = queue[i]
        const dx = c.cx * 16 + 8 - bx
        const dz = c.cz * 16 + 8 - bz
        const score = c.priority < 0 ? -1 : dx * dx + dz * dz
        if (score < bestScore) { bestScore = score; bestI = i }
      }
      const c = queue.splice(bestI, 1)[0]
      queued.delete(c.k)
      if (!bot.entity) return
      scanChunk(c.cx, c.cz)
      budget--
    }
  }, SCAN_TICK_MS)

  const frameTimer = setInterval(() => {
    if (!bot.entity || !bot.entity.position) return
    const p = bot.entity.position
    const bx = Math.floor(p.x)
    const bz = Math.floor(p.z)
    const botY = Math.floor(p.y)
    const W = RADIUS * 2
    const ox = bx - RADIUS
    const oz = bz - RADIUS

    // make sure every chunk under the frame is queued for scanning
    for (let cz = (oz >> 4); cz <= ((oz + W - 1) >> 4); cz++) {
      for (let cx = (ox >> 4); cx <= ((ox + W - 1) >> 4); cx++) {
        const k = key(cx, cz)
        if (!chunks.has(k)) enqueue(k, cx, cz, 0)
      }
    }

    const palette = [{ name: '__unknown', color: '#20242c' }]
    const local = new Map([[0, 0]])
    const ids = new Uint8Array(W * W)
    const heights = new Uint8Array(W * W)
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        const x = ox + i
        const z = oz + j
        const ch = chunks.get(key(x >> 4, z >> 4))
        const cell = j * W + i
        if (!ch) { ids[cell] = 0; heights[cell] = 64; continue }
        const g = ch.ids[(z & 15) * 16 + (x & 15)]
        let l = local.get(g)
        if (l === undefined) {
          if (palette.length >= 255) { l = 0 } else {
            l = palette.length
            palette.push({ name: names[g], color: blockColor(names[g]) })
          }
          local.set(g, l)
        }
        ids[cell] = l
        const rel = ch.ys[(z & 15) * 16 + (x & 15)] - botY + 64
        heights[cell] = rel < 0 ? 0 : rel > 255 ? 255 : rel
      }
    }

    const entities = []
    const reach = (RADIUS + 4) ** 2
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position) continue
      const dx = e.position.x - p.x
      const dz = e.position.z - p.z
      if (dx * dx + dz * dz > reach) continue
      let kind = 'object'
      let label = e.name || ''
      if (e.type === 'player') { kind = 'player'; label = e.username || 'player' }
      else if (e.kind && /hostile/i.test(String(e.kind))) kind = 'hostile'
      else if (e.kind && /passive|neutral|animal/i.test(String(e.kind))) kind = 'passive'
      if (kind === 'object' && !label) continue
      entities.push({ kind, name: String(label).slice(0, 24), x: +e.position.x.toFixed(1), z: +e.position.z.toFixed(1) })
    }

    unit.emit('radar', {
      radius: RADIUS,
      size: W,
      ox,
      oz,
      botY,
      palette,
      ids: Buffer.from(ids).toString('base64'),
      heights: Buffer.from(heights).toString('base64'),
      entities,
      bot: { x: +p.x.toFixed(1), z: +p.z.toFixed(1), yaw: +((bot.entity.yaw || 0).toFixed(2)) }
    })
  }, FRAME_MS)

  bot.on('blockUpdate', onBlockUpdate)

  return {
    dispose () {
      clearInterval(scanTimer)
      clearInterval(frameTimer)
      bot.removeListener('blockUpdate', onBlockUpdate)
    }
  }
}

module.exports = { attachScout }
