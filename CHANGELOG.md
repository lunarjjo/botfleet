# Changelog

All notable changes to botfleet are documented here.
The format follows Keep a Changelog; versioning follows SemVer.

## [0.5.0] - 2026-10-30

### Added

- **`run.sh` — the one-command launcher.** `./run.sh demo` turns any linux
  box with node >= 20 into a full botfleet test bed: it auto-picks the
  minecraft version from the installed java (25+ -> 26.2, 21-24 -> 1.21.8,
  `MC_VERSION` overrides), downloads the vanilla server jar from Mojang on
  first run, installs node dependencies, boots the server offline-mode,
  starts the console, and seeds three units (Scout, Ranger, Relay).
  Ctrl-C tears the whole stack down — no orphaned java processes. Knobs:
  `PORT`, `MC_PORT`, `MC_SEED`, `MC_LEVEL`, `MC_DIR`, `MC_HEAP`, `JAVA_BIN`.
- `./run.sh console` for pointing the web console at an existing server
  without the local demo stack.
- **GitHub release bundles**: every release now ships a `botfleet.tar.gz`
  asset (git archive of the tag) so the console is a
  `curl | tar xz && ./run.sh demo` away — see the README quick start.

### Fixed

- launcher shutdown hardening found by live-testing the demo path: signal
  traps survive the console child, so the demo server is reaped on Ctrl-C;
  `level-type` is only written when explicitly requested so every minecraft
  version falls back to its own default terrain without warnings.
- live e2e flake hardening: the builder gather now mines a surplus (drops
  scatter on real physics) with one more gather-and-build attempt, and the
  explore check retries with a wider ring when the first crawls — the
  assertions themselves are unchanged.

## [0.4.0] - 2026-10-30

### Added

- **Minecraft 26.3 and 26.2 support** via `src/version-compat/`: protocol
  and registry data vendored from the pending upstream minecraft-data PRs
  (#1219 for 26.2, #1300/#1301 for 26.3) and injected into the installed
  stack at require time. The overlay self-disables per version the moment
  the installed minecraft-data ships it natively.
- behavioral fixes for the 26.3 wire format, each found by live-testing
  against a real vanilla server: teleport_confirm echoes the teleport
  position/rotation, an empty tick_end follows every movement packet,
  block_dig status ids shifted by the new CHANGE_DESTROY_DIRECTION entry,
  and the new VecDelta entity-move / stepped PositionPath encodings are
  translated back into the flat shapes mineflayer consumes (including the
  entityDelta native codec from node-minecraft-protocol PR #1538).
- `GET /api/versions` and a boot banner reporting supported versions,
  split into official vs overlay.
- `scripts/version-check.mjs`: compares the official Mojang release
  manifest against official support, vendored overlay coverage, and the
  CI e2e matrix; exits non-zero when a recent release lacks a path.
- the daily **version-guard** workflow: turns version-check findings into
  a tracking issue with step-by-step instructions for adding a new
  version, so every future Minecraft release gets the same treatment.
- live e2e CI matrix per Minecraft version (26.3, 26.2, 1.21.8) with
  Java 25, booting real vanilla servers per job.

### Fixed

- pilot: an anti-drown water escape no longer silently retires the
  original goto goal — it resumes it from the dry cell (bounded by a hop
  budget), and a goal that itself stands in water now counts as a real
  arrival. Surfacing these: 26.x terrain generation places lakes where
  1.21.x terrain did not.
- pilot: digging with the head underwater bails after 6 s instead of 20 s
  so replanning routes around it rather than drowning mid-swing.

## [0.3.0] - 2026-10-30

### Added

- **the builder process** (`build <blueprint> [x y z]`): a from-scratch
  take on baritone's BuilderProcess. Blueprints are small json volumes
  (palette + ascii layers, or an explicit cell list) parsed and
  validated by `src/core/pilot/blueprints.js`; the builder
  (`src/core/pilot/builder.js`) diffs the blueprint against the live
  world every round, digs what must be air, places what must be solid —
  nearest task first, equipped from the inventory, anchored on a solid
  neighbor face — and reports honest stalls when material is missing
  or cells lie beyond the loaded world. Two blueprints ship in
  `blueprints/` (`slab`, `post`); fleets can carry their own in
  `./blueprints`.
- **the farm process** (`farm [radius]`): scans block states for mature
  crops (wheat, carrots, potatoes, beetroots, nether wart), harvests
  nearest-first, and replants the same crop on accepted soil (farmland,
  soul sand) when the seed is carried (`src/core/pilot/farm.js`).
- **the explore process** (`explore [radius]`): roams unvisited chunk
  targets inside a radius measured from where the process started,
  walking partial paths toward the fog and continuing as chunks load
  (`src/core/pilot/explore.js`).
- **the bridge movement**: when the gap ahead has no bottom (void, fog,
  lava), the planner can now place a block at foot level — anchored on
  the side face of the block being stood on — and cross it. The executor
  generalizes placement to explicit ref/face pairs, equips a real block
  from the inventory, sneaks over the edge on bridges, and gives up with
  a splice after repeated failed attempts.
- **runtime settings** (`set <key> <value>`): toggle the planner live —
  `allowBreak`, `allowPlace`, `allowParkour`, `allowWater`,
  `allowFallDamage`, fall/water caps, and the base movement costs.
- `allowPlace` now defaults to true (baritone parity): pillar and bridge
  placements participate in planning, and a unit that runs out of
  placeable blocks degrades gracefully to no-place pathing for the rest
  of the task instead of stalling.
- Live end-to-end suite extended to 38 checks: a full gather-and-build
  loop (mine dirt, construct a 3x3 blueprint, verified 9/9) and an
  explore pass over natural terrain.

### Changed

- Swimming bots hold the surface (bob) so long crossings no longer
  drown them, and arriving in open water auto-steps out onto the
  nearest dry column.
- Mining waits briefly for dropped items to reach the inventory before
  walking on, so `mine` no longer abandons its own drops.
- Planning against a freshly spawning, mostly-unloaded world retries
  for a couple of seconds before reporting "no path".

### Fixed

- Arriving mid-plan no longer resets `follow` (the follow timer owns its
  arrivals) and process tasks (`mine`/`build`/`farm`/`explore`) keep
  their task labels for the whole job.

## [0.2.0] - 2026-10-30

### Added

- **the pilot engine** (`src/core/pilot/`): a from-scratch, original-JavaScript
  pathfinding engine following the architecture popularized by baritone —
  A* over standing positions, a goal system (block / near / xz / y-level /
  composite / inverted / run-away / follow) with admissible heuristics, a
  full movement vocabulary (traverse, diagonal with corner rule, ascend,
  descend, fall with damage caps and water cushioning, swim, ladder climb,
  opt-in parkour and pillar placement), dig-through with hardness-based
  break costs, best-partial paths toward unreachable goals, tick-level
  plan validation with splicing, and escalating stuck recovery.
- `mine <block> [count]` command: finds the nearest loaded blocks by name,
  paths to them, digs, and repeats.
- The active plan streams to the console: `state` frames now carry the
  path polyline and pilot progress (goal, steps done, replans, partial
  flag); the radar draws it as an amber dashed line with a goal marker,
  and unit cards show live pathing info.
- `goto` without a y now targets the horizontal position at any height
  (GoalXZ), and 3-argument goto targets an exact block (GoalBlock).
- Live end-to-end suite extended to 29 checks: long-range 60-block goto,
  plan streaming, real block mining, and a natural-terrain crossing on a
  second real-worldgen vanilla server (deterministic seed).
- `MC_DIR` / `MC_PORT` / `MC_LEVEL_TYPE` / `MC_SEED` knobs in
  `scripts/e2e-server.sh` for booting terrain servers.

### Changed

- mineflayer-pathfinder is no longer a dependency: all movement is owned
  by the bundled pilot engine (dependencies stay at four: mineflayer,
  minecraft-data, vec3, ws).

## [0.1.1] - 2026-10-29

### Fixed

- `npm test` no longer fails on machines (and CI runners) without a
  minecraft server: the live end-to-end suite now probes `MC_HOST:MC_PORT`
  first and self-skips with a clear notice when nothing answers, instead
  of timing out for two minutes waiting for a bot that can never spawn.
  All 32 unit tests and the REST/WS boot checks were already green in CI;
  only the unguarded live suite was red.

### Added

- `BOTFLEET_LIVE_E2E=1` opt-in: flips the default from skip to require,
  failing fast with an actionable message when no server is reachable.
- `npm run test:live` shortcut for running the end-to-end suite directly,
  with `MC_HOST` / `MC_PORT` / `APP_PORT` environment overrides.

## [0.1.0] - 2026-10-29

### Added

- RTS-style web console for mineflayer fleets: telemetry cards, live feed,
  and a 2D tactical radar per unit, drawn from real loaded chunk data.
- Click-to-move pathfinding (mineflayer-pathfinder) straight from the
  radar canvas, plus a command grammar shared by the web console and the
  in-game chat bridge (`goto`, `come`, `follow`, `stop`, `where`, `say`,
  `drop`, `eat`, `help`).
- Fleet REST API (`node:http`, no framework) and a websocket gateway
  streaming `hello`, `state`, `radar`, `log` and `event` frames.
- Built-in behaviors: navigator, scout, survivor (day/night awareness,
  hostile detection) and commander (chat bridge) plugins.
- Vanilla web dashboard (zero build step), examples including a
  three-unit patrol, and a real-vanilla-server end-to-end suite.
