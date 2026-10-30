'use strict'

// real mineflayer bindings. unit.js and fleet.js never import mineflayer
// directly: they receive these through dependency injection, which keeps the
// core testable with fake bots and zero network. movement is fully owned by
// the bundled pilot engine — no external pathfinder plugin involved.
//
// version-compat is required BEFORE mineflayer so its patches (pending
// Minecraft versions, prismarine gates, the entityDelta native) land before
// any version list or protocol is read, no matter who requires real.js first.

const versionCompat = require('../version-compat')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

module.exports = {
  createBot: (opts) => {
    const bot = mineflayer.createBot(opts)
    versionCompat.applyClientCompat(bot, opts.version)
    return bot
  },
  Vec3,
  versionCompat
}
