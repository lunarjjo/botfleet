'use strict'

// real mineflayer bindings. unit.js and fleet.js never import mineflayer
// directly: they receive these through dependency injection, which keeps the
// core testable with fake bots and zero network.

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

module.exports = {
  createBot: (opts) => mineflayer.createBot(opts),
  pathfinderPlugin: pathfinder,
  Vec3
}
