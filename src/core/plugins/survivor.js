'use strict'

// keeps the bot fed. a preference-ordered food list (cooked before raw,
// never anything harmful) plus a background check every few seconds so a
// long patrol does not starve the unit.
const FOODS = [
  'golden_apple',
  'enchanted_golden_apple',
  'golden_carrot',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_chicken',
  'cooked_rabbit',
  'cooked_cod',
  'cooked_salmon',
  'bread',
  'baked_potato',
  'pumpkin_pie',
  'cookie',
  'apple',
  'melon_slice',
  'carrot',
  'sweet_berries',
  'glow_berries',
  'dried_kelp',
  'beetroot',
  'potato',
  'tropical_fish',
  'mushroom_stew',
  'beetroot_soup',
  'rabbit_stew',
  'chorus_fruit',
  'beef',
  'porkchop',
  'mutton',
  'chicken',
  'cod',
  'salmon',
  'rabbit'
]

const CHECK_MS = 5000
const HUNGRY_BELOW = 15

function attachSurvivor (unit, bot) {
  const state = { busy: false }

  async function eatOnce (source) {
    if (state.busy) return { ok: false, error: 'already eating' }
    const items = bot.inventory ? bot.inventory.items() : []
    let food = null
    for (const name of FOODS) {
      const it = items.find((i) => i.name === name)
      if (it) { food = it; break }
    }
    if (!food) {
      const msg = 'no food in inventory'
      unit.reply(msg, source)
      return { ok: false, error: msg }
    }
    state.busy = true
    try {
      await bot.equip(food, 'hand')
      await bot.consume()
      unit.log(`ate ${food.name}`)
      return { ok: true, reply: `ate ${food.name}` }
    } finally {
      state.busy = false
    }
  }

  const timer = setInterval(() => {
    if (state.busy || typeof bot.food !== 'number' || bot.food >= HUNGRY_BELOW) return
    eatOnce().catch(() => {})
  }, CHECK_MS)

  return {
    task: 'survivor',
    eatOnce,
    dispose () { clearInterval(timer) }
  }
}

module.exports = { attachSurvivor, FOODS }
