'use strict'

// the smallest possible botfleet program: deploy one unit and let the
// console drive it. open http://127.0.0.1:3000 and command it from the
// dashboard (or in-game chat: "Scout, come").
//
//   node examples/single-bot.js [host] [port] [name]

const path = require('path')
const { Fleet } = require('../src/core/fleet')
const { createApp } = require('../src/api/rest')
const { attachGateway } = require('../src/api/gateway')

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const name = process.argv[4] || 'Scout'

const fleet = new Fleet()
const server = createApp({ fleet, webRoot: path.join(__dirname, '..', 'web') })
attachGateway({ server, fleet })

server.listen(3000, '127.0.0.1', () => {
  console.log(`console: http://127.0.0.1:3000 — deploying ${name} to ${host}:${port}`)
  fleet.add({ name, host, port })
})
