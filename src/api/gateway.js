'use strict'

const { WebSocketServer } = require('ws')

// websocket gateway. the fleet is an event hub; the gateway is a thin fan-out
// that also accepts { t: 'command', name, text } from the console.
function attachGateway ({ server, fleet }) {
  const wss = new WebSocketServer({ server, path: '/ws' })
  const clients = new Set()

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.send(JSON.stringify({
      t: 'hello',
      bots: fleet.list(),
      server: { uptime: Math.floor((Date.now() - fleet.startedAt) / 1000), node: process.version }
    }))
    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(String(data)) } catch (e) {
        try { ws.send(JSON.stringify({ t: 'error', text: 'message is not JSON' })) } catch (e2) { /* closing */ }
        return
      }
      if (msg && msg.t === 'command' && typeof msg.name === 'string' && typeof msg.text === 'string') {
        fleet.command(msg.name, msg.text, 'web').catch(() => {})
      } else if (msg && msg.t === 'ping') {
        try { ws.send(JSON.stringify({ t: 'pong' })) } catch (e) { /* closing */ }
      }
    })
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => {})
  })

  function onBroadcast (obj) {
    if (clients.size === 0) return
    const s = JSON.stringify(obj)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(s) } catch (e) { /* dropping */ }
      }
    }
  }
  fleet.on('broadcast', onBroadcast)

  const pingTimer = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.ping() } catch (e) { /* dropping */ }
      }
    }
  }, 30000)

  return {
    wss,
    close () {
      clearInterval(pingTimer)
      fleet.removeListener('broadcast', onBroadcast)
      for (const ws of clients) {
        try { ws.terminate() } catch (e) { /* gone */ }
      }
      clients.clear()
      wss.close()
    }
  }
}

module.exports = { attachGateway }
