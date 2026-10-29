'use strict'

// the world view: block semantics for the pathfinder, over either a real
// mineflayer bot or anything that answers getBlock(x, y, z). unknown /
// unloaded chunks answer null and the pathfinder treats them as walls —
// baritone instead charges them a heavy penalty and wanders hopefully;
// for a fleet console, refusing to path into the fog is the safer contract.

const AIR_LIKE = new Set(['air', 'cave_air', 'void_air', 'light', 'structure_void'])
const CLIMBABLE = new Set(['ladder', 'vine', 'twisting_vines', 'weeping_vines',
  'cave_vines', 'cave_vines_plant', 'scaffolding'])
const LIQUIDS = new Set(['water', 'flowing_water'])
const UNSAFE_LIQUIDS = new Set(['lava', 'flowing_lava'])

// blocks that are safe to walk INTO (the body can occupy the cell) even
// though they are not air: plants, rails, snow layers, liquids, ladders.
const NON_SOLID = new Set([...AIR_LIKE, ...CLIMBABLE, ...LIQUIDS, UNSAFE_LIQUIDS,
  'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'dandelion',
  'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'wheat', 'carrots', 'potatoes',
  'beetroots', 'torch', 'wall_torch', 'rail', 'powered_rail', 'detector_rail',
  'activator_rail', 'snow', 'sugar_cane', 'cobweb'])

class WorldView {
  // getBlock: (x, y, z) -> { name, hardness?, boundingBox? } | null
  constructor (getBlock, opts) {
    this.getBlock = getBlock
    this.registry = (opts && opts.registry) || null
  }

  static fromBot (bot, deps) {
    const Vec3 = deps.Vec3
    return new WorldView((x, y, z) => {
      try {
        return bot.world ? bot.world.getBlock(new Vec3(x, y, z)) : (bot.blockAt ? bot.blockAt(new Vec3(x, y, z)) : null)
      } catch (e) {
        return null
      }
    }, { registry: bot.registry || null })
  }

  block (x, y, z) {
    return this.getBlock(x, y, z) || null
  }

  name (x, y, z) {
    const b = this.block(x, y, z)
    return b ? b.name : null
  }

  // can the body occupy the cell? null (unknown) answers false.
  passable (x, y, z) {
    const b = this.block(x, y, z)
    if (!b) return false
    if (b.boundingBox) return b.boundingBox === 'empty' || NON_SOLID.has(b.name)
    return AIR_LIKE.has(b.name) || NON_SOLID.has(b.name)
  }

  // unknown blocks count as impassable (never path into the fog).
  known (x, y, z) {
    return this.block(x, y, z) !== null
  }

  // can the cell be broken by hand within a sane time?
  breakInfo (x, y, z) {
    const b = this.block(x, y, z)
    if (!b) return null
    let hardness = typeof b.hardness === 'number' ? b.hardness : null
    if (hardness === null && this.registry && this.registry.blocksByName) {
      const meta = this.registry.blocksByName[b.name]
      if (meta) hardness = meta.hardness
    }
    if (hardness === null || hardness === undefined) hardness = 1
    return { name: b.name, hardness, breakable: hardness >= 0 }
  }

  solid (x, y, z) {
    const b = this.block(x, y, z)
    if (!b) return false
    if (b.boundingBox) return b.boundingBox !== 'empty' && !NON_SOLID.has(b.name)
    return !AIR_LIKE.has(b.name) && !NON_SOLID.has(b.name)
  }

  liquid (x, y, z) {
    const n = this.name(x, y, z)
    return LIQUIDS.has(n) || UNSAFE_LIQUIDS.has(n)
  }

  water (x, y, z) {
    const n = this.name(x, y, z)
    return LIQUIDS.has(n)
  }

  lava (x, y, z) {
    return UNSAFE_LIQUIDS.has(this.name(x, y, z))
  }

  climbable (x, y, z) {
    return CLIMBABLE.has(this.name(x, y, z))
  }

  // a cell the feet can rest ON: full/partial boxes that are not liquids
  // and not climbable. partial covers slabs, stairs, snow layers.
  standable (x, y, z) {
    const b = this.block(x, y, z)
    if (!b) return false
    if (b.boundingBox) return b.boundingBox !== 'empty' && !NON_SOLID.has(b.name)
    return !AIR_LIKE.has(b.name) && !NON_SOLID.has(b.name)
  }
}

module.exports = { WorldView, AIR_LIKE, CLIMBABLE, LIQUIDS, UNSAFE_LIQUIDS, NON_SOLID }
