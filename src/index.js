#!/usr/bin/env node
'use strict'

// botfleet — command a fleet of minecraft bots like an RTS.
// starts the REST + websocket console and optionally auto-connects units
// from the BOTS environment variable (a JSON array of unit options).

const path = require('path')
const { Fleet } = require('./core/fleet')
const { createApp } = require('./api/rest')
const { attachGateway } = require('./api/gateway')

const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '127.0.0.1'

const fleet = new Fleet()
const server = createApp({ fleet, webRoot: path.join(__dirname, '..', 'web') })
const gateway = attachGateway({ server, fleet })

server.listen(PORT, HOST, () => {
  console.log(`botfleet console: http://${HOST}:${PORT}`)
  console.log('add a unit from the dashboard, or:')
  console.log(`  curl -X POST http://${HOST}:${PORT}/api/bots -d '{"name":"Scout","host":"127.0.0.1","port":25565}'`)
})

if (process.env.BOTS) {
  let seeds
  try {
    seeds = JSON.parse(process.env.BOTS)
  } catch (e) {
    console.error('BOTS env is not valid JSON — ignoring')
  }
  if (Array.isArray(seeds)) {
    for (const s of seeds) {
      try {
        fleet.add(s)
        console.log(`seeded unit "${s.name}" -> ${s.host}:${s.port}`)
      } catch (e) {
        console.error(`could not seed unit: ${e.message}`)
      }
    }
  }
}

function shutdown () {
  console.log('shutting down…')
  try { fleet.stopAll() } catch (e) { /* noop */ }
  gateway.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
