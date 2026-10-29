'use strict'

// real mineflayer bindings. unit.js and fleet.js never import mineflayer
// directly: they receive these through dependency injection, which keeps the
// core testable with fake bots and zero network. movement is fully owned by
// the bundled pilot engine — no external pathfinder plugin involved.

const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

module.exports = {
  createBot: (opts) => mineflayer.createBot(opts),
  Vec3
}
