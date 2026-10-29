'use strict'

// in-game chat bridge. players address a unit by name:
//   "Scout, come" / "scout: goto 100 64 -20" / "Scout follow me"...
// whispering works too. everything else is just logged to the feed.
function escapeRe (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function attachCommander (unit, bot) {
  const addressRe = new RegExp('^' + escapeRe(unit.name) + '\\s*[,\\s]+\\s*(.+)$', 'i')

  function onChat (username, message) {
    if (username === bot.username) return
    const m = addressRe.exec(String(message))
    if (m) {
      unit.command(m[1], username).catch(() => {})
    }
  }

  function onFeed (username, message) {
    if (username === bot.username) return
    unit.emit('event', { kind: 'chat', text: `<${username}> ${message}` })
  }

  bot.on('chat', onFeed)
  bot.on('chat', onChat)
  bot.on('whisper', onChat)

  return {
    dispose () {
      bot.removeListener('chat', onFeed)
      bot.removeListener('chat', onChat)
      bot.removeListener('whisper', onChat)
    }
  }
}

module.exports = { attachCommander }
