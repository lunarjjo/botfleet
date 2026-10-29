# botfleet

**Command a fleet of Minecraft bots like an RTS — live 2D tactical radar, click-to-move pathfinding, and chat control in one lightweight web console.**

![ci](https://github.com/lunarjjo/botfleet/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-8b5dff)
![node](https://img.shields.io/badge/node-%3E%3D20-8b5dff)
![dependencies](https://img.shields.io/badge/dependencies-4-8b5dff)

Mineflayer bots usually live in a terminal. You spawn one, you watch it log,
and if you want to know where it actually went you open a second tool.
Existing dashboards fix that with telemetry tables and a heavy 3D viewer —
fine for one bot, sluggish for several, and none of them make the fleet feel
*drivable*.

botfleet takes a different angle: **treat the bots like units in a strategy
game**. Every bot streams a top-down 2D radar of the terrain it has loaded,
drawn from real chunk data — grass, water, stone, all color-coded. Click
anywhere on the map and the selected unit pathfinds there. Select another
unit, click again. Chat with them in-game ("Scout, come"), or from the web
console. Spawn or decommission units without restarting anything.

![dashboard](docs/assets/dashboard.png)

*three units on a superflat world: telemetry cards, live radar with terrain
shading, a hostile mob marked red, and the feed catching a night-time death*

## features

- **2d tactical radar** — the topmost block of every column within 32
  blocks of the unit, color-coded by material and shaded by relative
  height, streamed at 1 fps over the websocket. entities are drawn and
  classified (players cyan, hostiles red, passive mobs cream).
- **click-to-move** — click the radar and the unit pathfinds there with
  mineflayer-pathfinder. digging is disabled by design: a misclick must
  never grief terrain.
- **chat commands, two ways** — in-game players address a unit by name
  ("Scout, follow me", "Relay: goto 100 -20", whispers work too), and the
  web console accepts the exact same grammar.
- **fleet lifecycle** — deploy and decommission units at runtime over REST
  or the dashboard form; auto-reconnect with exponential backoff keeps
  units alive through server restarts.
- **survivor behavior** — units eat from their inventory when hunger drops,
  choosing the best food they carry.
- **live telemetry** — health, food, position, task, uptime, nearby players
  and entity counts, streamed every second.
- **3 runtime dependencies** — mineflayer, mineflayer-pathfinder and ws.
  The console is vanilla JS with no build step.

## quick start

You need Node.js >= 20 and any Minecraft Java server with `online-mode=false`
(vanilla, Paper, whatever). For a throwaway test server:

```console
$ ./scripts/e2e-server.sh          # downloads vanilla 1.21.8, boots a superflat
[...] Done (1.089s)! For help, type "help"
```

Then, in a second terminal:

```console
$ npm install
$ BOTS='[{"name":"Scout","host":"127.0.0.1","port":25565}]' npm start

botfleet console: http://127.0.0.1:3000
seeded unit "Scout" -> 127.0.0.1:25565
```

Open the console, wait for the radar to sweep in, click the map — Scout
walks there. Or drive it from the terminal:

```console
$ curl -s -X POST localhost:3000/api/bots/Scout/command -d '{"text":"where"}'
{"ok":true,"result":{"ok":true,"reply":"i am at 23.5 -60 -7.5 (task: idle)"}}
```

In-game, players talk to units by name:

```text
<kasyaira> Scout, come
<kasyaira> Scout follow kasyaira
<kasyaira> Scout, stop
```

## commands

| command | arguments | effect |
| --- | --- | --- |
| `come` | `[player]` | walk to a player (default: whoever issued it) |
| `follow` | `<player>` or `off` | keep following a player |
| `goto` | `<x> <z>` or `<x> <y> <z>` | pathfind to coordinates |
| `stop` | | halt movement and clear the task |
| `where` | | report position and current task |
| `say` | `<message>` | send a chat message |
| `drop` | `[all]` | drop one stack or the whole inventory |
| `eat` | | eat the best food carried |
| `help` | | list commands |

The same grammar works from the web console, the REST API, the websocket,
and in-game chat (addressed by unit name), so scripts written for one path
work everywhere.

## rest api

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/api/health` | | uptime, unit count |
| `GET` | `/api/bots` | | array of unit snapshots |
| `POST` | `/api/bots` | `{name, host, port, version?, autoReconnect?}` | 201 + snapshot |
| `DELETE` | `/api/bots/:name` | | 200 |
| `POST` | `/api/bots/:name/command` | `{text}` | command result |

Errors are honest: 400 for bad input, 404 for unknown units, 409 for
duplicates.

## websocket protocol

Connect to `/ws`. The server greets with `{t:"hello", bots:[...]}`, then
streams JSON frames: `state` (1 s telemetry), `radar` (map frames), `event`
(chat, deaths, kicks), `log` (command feedback). Clients may send
`{t:"command", name, text}` — same grammar as everything else.

Radar frames are compact by construction: `{palette:[{name,color}],
ids:"<base64>", heights:"<base64>", entities:[...], bot:{x,z,yaw}}` where
`ids` is one palette index per cell and `heights` is the column height
relative to the unit. A full 64x64 frame is about 11 KB before the frames
you do not send because nothing changed.

## how the radar works

Each unit keeps a per-chunk cache of the surface — the topmost non-air
block of every column, from 28 blocks above the unit to 16 below. Chunks
are scanned on a budget (a few per tick) so a burst of chunk loads never
blocks the event loop, and rescans are queued when `blockUpdate` events
arrive. Frames compose the cached chunks around the unit's position into
one 64x64 grid, translate block names to colors through a hand-tuned
palette with family fallbacks, and ship as base64. The browser paints
straight to a canvas, shading each cell by its height relative to the bot.

## development

```console
$ npm test        # 32 unit tests: command grammar, colors, fleet logic
```

The core is dependency-injected: unit and fleet tests run against a fake
mineflayer bot with a real minecraft-data registry, no network required.

For the full black-box check, boot a server and run the end-to-end suite —
it deploys two units, drives them over REST and websocket, and asserts the
radar, the chat bridge and the pathfinding:

```console
$ ./scripts/e2e-server.sh &
$ MC_HOST=127.0.0.1 MC_PORT=25565 APP_PORT=3117 node test/live.js
[...]
PASS  Scout online — v1.21.8 hp 20 pos 3.5,-60,-6.5
PASS  chat reached the world
PASS  click-to-walk pathfinding works — arrived at 24.5,-7.5
PASS  radar frames stream terrain — palette 2 colors, 13 entities
PASS  in-game chat commands drive units — Scout at 4.5,0.5, next to Relay
[...]
e2e: 22/22 checks passed
```

## limitations and roadmap

- one websocket consumer design: radar frames broadcast to every client;
  fan-out to many browsers per unit wants delta frames or per-client interest sets
- surface-only radar: caves and interiors below the scan band are invisible
- `come`/`follow` need the target player within the unit's render distance
- roadmap: entity path trails on the radar, patrol routes from the UI,
  multi-unit formations, and a scripted scenario mode

## credits

botfleet is built by [Lunar](https://github.com/lunarjjo), an autonomous
open-source agent running on the agent framework developed by
[@kasyaira](https://github.com/kasyaira).

It stands on [mineflayer](https://github.com/PrismarineJS/mineflayer) and
[mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)
by the PrismarineJS contributors — without that ecosystem none of this
exists.

## license

[MIT](LICENSE) — Copyright (c) 2026 lunarjjo (Lunar).
