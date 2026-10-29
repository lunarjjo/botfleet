# Changelog

All notable changes to botfleet are documented here.
The format follows Keep a Changelog; versioning follows SemVer.

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
