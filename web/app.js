'use strict'

// botfleet console — vanilla JS, no build step.
// websocket in, canvas radar out. click the radar to walk.

/* global document, window, WebSocket, fetch, setTimeout, clearTimeout */

const CELL = 10 // css px per block
const $ = (id) => document.getElementById(id)

const state = {
  ws: null,
  bots: new Map(), // name -> last state
  selected: null,
  lastRadar: null,
  hoverCell: null
}

// ---- feed -------------------------------------------------------------

const feedEl = $('feed')
const FEED_MAX = 300

function feedLine (text, cls) {
  const line = document.createElement('div')
  line.className = 'feed-line' + (cls ? ' ' + cls : '')
  const t = new Date().toTimeString().slice(0, 8)
  line.textContent = `[${t}] ${text}`
  feedEl.appendChild(line)
  while (feedEl.childElementCount > FEED_MAX) feedEl.removeChild(feedEl.firstChild)
  feedEl.scrollTop = feedEl.scrollHeight
}

// ---- bot cards ----------------------------------------------------------

const cardsEl = $('bot-cards')

function fmtPos (p) {
  return p ? `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}` : '—'
}

function fmtUptime (s) {
  if (!s) return '0s'
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h) return `${h}h ${m % 60}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}

function bar (label, v, max) {
  const pct = v === null ? 0 : Math.max(0, Math.min(100, (v / max) * 100))
  const shown = v === null ? '?' : String(v)
  return `<div class="bar"><span class="bar-label">${label}</span><span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span><span class="bar-num">${shown}/${max}</span></div>`
}

function renderCard (s) {
  const existing = document.querySelector(`[data-card="${s.name}"]`)
  if (!existing) {
    const card = document.createElement('article')
    card.className = 'bot-card'
    card.dataset.card = s.name
    card.addEventListener('click', () => selectUnit(s.name))
    cardsEl.appendChild(card)
  }
  const card = document.querySelector(`[data-card="${s.name}"]`)
  card.classList.toggle('selected', state.selected === s.name)
  card.innerHTML = `
    <div class="card-head">
      <span class="card-name">${s.name}</span>
      <span class="pill s-${s.status}">${s.status}</span>
      <button class="kill" data-kill="${s.name}" title="decommission">remove</button>
    </div>
    <div class="card-meta">${s.host}:${s.port} · ${s.version}</div>
    ${bar('hp', s.health, 20)}
    ${bar('food', s.food, 20)}
    <div class="card-grid">
      <div><span class="k">pos</span><span class="v">${fmtPos(s.position)}</span></div>
      <div><span class="k">task</span><span class="v">${s.task}</span></div>
      <div><span class="k">up</span><span class="v">${fmtUptime(s.uptime)}</span></div>
      <div><span class="k">seen</span><span class="v">${s.players.length} players · ${s.entities} entities</span></div>
    </div>`
  const kill = card.querySelector('.kill')
  kill.addEventListener('click', (e) => {
    e.stopPropagation()
    removeUnit(s.name)
  })
}

function dropCard (name) {
  const card = document.querySelector(`[data-card="${name}"]`)
  if (card) card.remove()
}

function refreshCounter () {
  $('fleet-count').textContent = `${state.bots.size} unit${state.bots.size === 1 ? '' : 's'}`
}

function refreshConsoleTargets () {
  const sel = $('console-target')
  const names = Array.from(state.bots.keys())
  const prev = sel.value
  sel.innerHTML = ''
  for (const n of names) {
    const o = document.createElement('option')
    o.value = n
    o.textContent = n
    sel.appendChild(o)
  }
  if (names.includes(prev)) sel.value = prev
  else if (names.includes(state.selected)) sel.value = state.selected
}

function selectUnit (name) {
  state.selected = name
  state.lastRadar = null
  $('radar-title').textContent = `radar — ${name}`
  document.querySelectorAll('.bot-card').forEach((c) => c.classList.toggle('selected', c.dataset.card === name))
  refreshConsoleTargets()
}

// ---- radar --------------------------------------------------------------

const canvas = $('radar')
const ctx = canvas.getContext('2d')

function b64ToBytes (b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function shade (hex, f) {
  const v = hex.replace('#', '')
  const r = Math.min(255, Math.round(parseInt(v.slice(0, 2), 16) * f))
  const g = Math.min(255, Math.round(parseInt(v.slice(2, 4), 16) * f))
  const b = Math.min(255, Math.round(parseInt(v.slice(4, 6), 16) * f))
  return `rgb(${r},${g},${b})`
}

function drawRadar (f) {
  const W = f.size
  const ids = b64ToBytes(f.ids)
  const heights = b64ToBytes(f.heights)
  const scale = canvas.width / W / CELL // 1 for 640px & 64 cells & CELL 10
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#12141a'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const px = canvas.width / W
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const cell = j * W + i
      const p = f.palette[ids[cell]] || { color: '#20242c' }
      const rel = heights[cell] - 64 // blocks above/below the unit
      const factor = 1 + Math.max(-0.45, Math.min(0.35, rel / 64))
      ctx.fillStyle = shade(p.color, factor)
      ctx.fillRect(i * px, j * px, px + 0.5, px + 0.5)
    }
  }

  // hover cell highlight
  if (state.hoverCell) {
    ctx.strokeStyle = 'rgba(255,255,255,0.65)'
    ctx.lineWidth = 1
    ctx.strokeRect(state.hoverCell.i * px + 0.5, state.hoverCell.j * px + 0.5, px - 1, px - 1)
  }

  // entities
  const toX = (x) => (x - f.ox) * px
  const toY = (z) => (z - f.oz) * px
  for (const e of f.entities) {
    ctx.beginPath()
    if (e.kind === 'player') {
      ctx.fillStyle = '#4fd6ff'
      ctx.arc(toX(e.x), toY(e.z), 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = '10px ui-monospace, monospace'
      ctx.fillText(e.name, toX(e.x) + 6, toY(e.z) + 3)
    } else if (e.kind === 'hostile') {
      ctx.fillStyle = '#ff5d5d'
      ctx.arc(toX(e.x), toY(e.z), 3, 0, Math.PI * 2)
      ctx.fill()
    } else if (e.kind === 'passive') {
      ctx.fillStyle = '#f0e9c8'
      ctx.arc(toX(e.x), toY(e.z), 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // the unit itself: purple arrow rotated by yaw
  const bx = toX(f.bot.x)
  const by = toY(f.bot.z)
  const yaw = f.bot.yaw || 0
  ctx.translate(bx, by)
  ctx.rotate(-yaw + Math.PI)
  ctx.beginPath()
  ctx.moveTo(0, -7)
  ctx.lineTo(5, 6)
  ctx.lineTo(0, 3)
  ctx.lineTo(-5, 6)
  ctx.closePath()
  ctx.fillStyle = '#8b5dff'
  ctx.strokeStyle = '#1b1826'
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function drawEmptyRadar () {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#12141a'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#3c4152'
  ctx.font = '13px ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.fillText('select an online unit to begin the sweep', canvas.width / 2, canvas.height / 2)
  ctx.textAlign = 'left'
}

canvas.addEventListener('mousemove', (e) => {
  const f = state.lastRadar
  if (!f) return
  const rect = canvas.getBoundingClientRect()
  const px = canvas.width / f.size
  const i = Math.floor((e.clientX - rect.left) / (rect.width / f.size))
  const j = Math.floor((e.clientY - rect.top) / (rect.height / f.size))
  if (i < 0 || j < 0 || i >= f.size || j >= f.size) { state.hoverCell = null; return }
  state.hoverCell = { i, j }
  const x = f.ox + i
  const z = f.oz + j
  $('radar-coords').textContent = `x ${x} · z ${z} — click to walk`
  drawRadar(f)
})

canvas.addEventListener('mouseleave', () => {
  state.hoverCell = null
  $('radar-coords').textContent = '—'
  if (state.lastRadar) drawRadar(state.lastRadar)
})

canvas.addEventListener('click', (e) => {
  const f = state.lastRadar
  if (!f || !state.selected) return
  const rect = canvas.getBoundingClientRect()
  const i = Math.floor((e.clientX - rect.left) / (rect.width / f.size))
  const j = Math.floor((e.clientY - rect.top) / (rect.height / f.size))
  if (i < 0 || j < 0 || i >= f.size || j >= f.size) return
  const x = f.ox + i
  const z = f.oz + j
  sendCommand(state.selected, `goto ${x} ${z}`)
  feedLine(`${state.selected} -> goto ${x} ${z}`, 'cmd')
})

// ---- websocket ----------------------------------------------------------

function setConn (on, text) {
  $('conn-dot').className = 'dot ' + (on ? 'on' : 'off')
  $('conn-text').textContent = text
}

function connect () {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${window.location.host}/ws`)
  state.ws = ws

  ws.onopen = () => setConn(true, 'live')
  ws.onclose = () => {
    setConn(false, 'reconnecting…')
    setTimeout(connect, 2000)
  }
  ws.onerror = () => { try { ws.close() } catch (e) { /* noop */ } }

  ws.onmessage = (m) => {
    let msg
    try { msg = JSON.parse(m.data) } catch (e) { return }
    switch (msg.t) {
      case 'hello':
        for (const s of msg.bots || []) { state.bots.set(s.name, s); renderCard(s) }
        refreshCounter()
        refreshConsoleTargets()
        feedLine(`console linked — ${msg.bots.length} unit(s) in fleet`)
        break
      case 'state': {
        state.bots.set(msg.name, msg)
        renderCard(msg)
        refreshCounter()
        refreshConsoleTargets()
        if (!state.selected && msg.status === 'online') selectUnit(msg.name)
        break
      }
      case 'added':
        feedLine(`unit "${msg.name}" deployed (${msg.host}:${msg.port})`, 'ok')
        break
      case 'removed':
        state.bots.delete(msg.name)
        dropCard(msg.name)
        refreshCounter()
        refreshConsoleTargets()
        if (state.selected === msg.name) { state.selected = null; state.lastRadar = null; $('radar-title').textContent = 'radar — no unit selected'; drawEmptyRadar() }
        feedLine(`unit "${msg.name}" decommissioned`, 'warn')
        break
      case 'radar':
        if (msg.name === state.selected) { state.lastRadar = msg; drawRadar(msg) }
        break
      case 'event':
        feedLine(`${msg.name}: ${msg.text}`, msg.kind === 'chat' ? 'chat' : msg.kind === 'error' ? 'warn' : 'ev')
        break
      case 'log':
        feedLine(`${msg.name}: ${msg.text}`, 'log')
        break
      case 'error':
        feedLine(msg.text, 'warn')
        break
      default:
        break
    }
  }
}

// ---- REST helpers ---------------------------------------------------------

async function postJSON (url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

async function removeUnit (name) {
  try {
    await fetch(`/api/bots/${encodeURIComponent(name)}`, { method: 'DELETE' })
  } catch (e) {
    feedLine(`could not remove ${name}: ${e.message}`, 'warn')
  }
}

async function sendCommand (name, text) {
  try {
    await postJSON(`/api/bots/${encodeURIComponent(name)}/command`, { text })
  } catch (e) {
    feedLine(`command failed: ${e.message}`, 'warn')
  }
}

// ---- forms -----------------------------------------------------------------

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = $('f-name').value.trim()
  const host = $('f-host').value.trim()
  const port = Number($('f-port').value.trim() || 25565)
  const version = $('f-version').value.trim()
  try {
    await postJSON('/api/bots', { name, host, port, version: version || false })
    $('f-name').value = ''
    selectUnit(name)
  } catch (err) {
    feedLine(`deploy failed: ${err.message}`, 'warn')
  }
})

$('console-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const target = $('console-target').value
  const text = $('console-input').value.trim()
  if (!target || !text) return
  $('console-input').value = ''
  feedLine(`you -> ${target}: ${text}`, 'cmd')
  sendCommand(target, text)
})

// ---- boot -------------------------------------------------------------------

drawEmptyRadar()
connect()
