'use strict'

// a three-unit patrol. each unit walks a loop of waypoints, forever —
// open the console and watch three radar screens take turns leading.
// click any radar to redirect the selected unit; it returns to its loop
// on the next waypoint tick.
//
//   node examples/patrol-fleet.js [host] [port]

const path = require('path')
const { Fleet } = require('../src/core/fleet')
const { createApp } = require('../src/api/rest')
const { attachGateway } = require('../src/api/gateway')

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)

const ROUTES = {
  North: [[40, -40], [40, 0], [0, 0], [0, -40]],
  South: [[-40, 0], [-40, 40], [0, 40], [0, 0]],
  East: [[40, 20], [0, 20], [0, 45], [40, 45]]
}

const fleet = new Fleet()
const server = createApp({ fleet, webRoot: path.join(__dirname, '..', 'web') })
attachGateway({ server, fleet })

server.listen(3000, '127.0.0.1', async () => {
  console.log('console: http://127.0.0.1:3000 — deploying the patrol')
  for (const [name, route] of Object.entries(ROUTES)) {
    fleet.add({ name, host, port })
    const unit = fleet.get(name)
    unit.on('event', async (e) => {
      if (e.kind !== 'spawn') return
      let i = 0
      // walk the loop forever; the console can interrupt at any time
      for (;;) {
        const [x, z] = route[i % route.length]
        await unit.command(`goto ${x} ${z}`, 'patrol').catch(() => {})
        await new Promise((r) => setTimeout(r, 8000))
        if (unit.status !== 'online') return
        i++
      }
    })
  }
})
