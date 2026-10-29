'use strict'

// the goal system. a goal answers two questions for any standing position:
//   heuristic(x, y, z) — a LOWER BOUND on remaining cost; admissible so the
//     A* stays optimal (never overestimates)
//   isMet(x, y, z)     — is the goal satisfied standing here?
// composite and inverted goals compose the primitives, the same way
// baritone composes GoalBlock / GoalNear / GoalXZ / GoalRunAway.

const SQRT2 = Math.SQRT2

function octile (dx, dz) {
  const ax = Math.abs(dx)
  const az = Math.abs(dz)
  return Math.max(ax, az) + (SQRT2 - 1) * Math.min(ax, az)
}

class Goal {
  constructor (label) {
    this.labelText = label
  }

  label () {
    return this.labelText
  }
}

// one exact block. every vertical change costs at least 1 (down) or 2 (up),
// so octile + |dy| never overestimates.
class GoalBlock extends Goal {
  constructor (x, y, z) {
    super(`block ${x} ${y} ${z}`)
    this.x = x
    this.y = y
    this.z = z
  }

  heuristic (x, y, z) {
    return octile(x - this.x, z - this.z) + Math.abs(y - this.y)
  }

  isMet (x, y, z) {
    return x === this.x && y === this.y && z === this.z
  }
}

// within a radius (3d) of a point. the radius shaves the bound.
class GoalNear extends Goal {
  constructor (x, y, z, r) {
    super(`near ${x} ${y} ${z} r${r}`)
    this.x = x
    this.y = y
    this.z = z
    this.r = r
  }

  heuristic (x, y, z) {
    const h = octile(x - this.x, z - this.z) + Math.abs(y - this.y)
    return Math.max(0, h - this.r)
  }

  isMet (x, y, z) {
    const dx = x - this.x
    const dy = y - this.y
    const dz = z - this.z
    return dx * dx + dy * dy + dz * dz <= this.r * this.r
  }
}

// horizontal position, any height.
class GoalXZ extends Goal {
  constructor (x, z) {
    super(`xz ${x} ${z}`)
    this.x = x
    this.z = z
  }

  heuristic (x, y, z) {
    return octile(x - this.x, z - this.z)
  }

  isMet (x, y, z) {
    return x === this.x && z === this.z
  }
}

// reach a y level, anywhere.
class GoalYLevel extends Goal {
  constructor (y) {
    super(`y ${y}`)
    this.y = y
  }

  heuristic (x, y, z) {
    return Math.abs(y - this.y)
  }

  isMet (x, y, z) {
    return y === this.y
  }
}

// satisfied when ANY sub-goal is satisfied. the bound is the cheapest one.
class GoalComposite extends Goal {
  constructor (...goals) {
    super(`any(${goals.map((g) => g.label()).join(' | ')})`)
    this.goals = goals
  }

  heuristic (x, y, z) {
    let best = Infinity
    for (const g of this.goals) {
      const h = g.heuristic(x, y, z)
      if (h < best) best = h
    }
    return best === Infinity ? 0 : best
  }

  isMet (x, y, z) {
    return this.goals.some((g) => g.isMet(x, y, z))
  }
}

// satisfied when the inner goal is NOT. has no admissible bound (any move
// could be the last one needed), so it degrades the search to dijkstra —
// same trade-off baritone makes for GoalRunAway.
class GoalInverted extends Goal {
  constructor (inner) {
    super(`not(${inner.label()})`)
    this.inner = inner
  }

  heuristic () {
    return 0
  }

  isMet (x, y, z) {
    return !this.inner.isMet(x, y, z)
  }
}

// run away from a point until outside a radius.
class GoalRunAway extends Goal {
  constructor (x, z, r) {
    super(`away ${x} ${z} r${r}`)
    this.x = x
    this.z = z
    this.r = r
  }

  heuristic () {
    return 0
  }

  isMet (x, y, z) {
    const dx = x - this.x
    const dz = z - this.z
    return dx * dx + dz * dz >= this.r * this.r
  }
}

// a dynamic goal: getPosition() is re-read on every replan, so the target
// can walk around. internally evaluated as GoalNear with a slack radius.
class GoalFollow extends Goal {
  constructor (getPosition, r) {
    super(`follow r${r}`)
    this.getPosition = getPosition
    this.r = r
    this.last = null
  }

  target () {
    const p = this.getPosition()
    if (p) this.last = p
    return this.last
  }

  heuristic (x, y, z) {
    const p = this.target()
    if (!p) return 0
    const h = octile(x - p.x, z - p.z) + Math.abs(y - (p.y || y))
    return Math.max(0, h - this.r)
  }

  isMet (x, y, z) {
    const p = this.target()
    if (!p) return false
    const dx = x - p.x
    const dy = y - (p.y || y)
    const dz = z - p.z
    return dx * dx + dy * dy + dz * dz <= this.r * this.r
  }
}

module.exports = {
  octile,
  Goal,
  GoalBlock,
  GoalNear,
  GoalXZ,
  GoalYLevel,
  GoalComposite,
  GoalInverted,
  GoalRunAway,
  GoalFollow
}
