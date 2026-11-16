# threejs-fps-01

[![make.fun · threejs-fps-01](https://make.fun/badge/threejs-fps-01.svg)](https://make.fun/bounty/threejs-fps-01?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01)
[![rank](https://make.fun/badge/threejs-fps-01/endraputra9/threejs-fps-01/rank.svg)](https://make.fun/bounty/threejs-fps-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01)
[![reward](https://make.fun/badge/threejs-fps-01/endraputra9/threejs-fps-01/reward.svg)](https://make.fun/bounty/threejs-fps-01?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01)

RINGFALL — a round-based tactical FPS built with three.js, set aboard the
derelict orbital station Vesper Ring. The Reclaimers board the ring to dock
a parasitic data-tap, the Leech, onto one of its two reactor cores; the
Wardens hold the deck and can purge a docked Leech before the drain
finishes. Five a side, twelve rounds, sides swap at the half, first to
seven. A full round economy runs between the shooting: kills, dockings and
round wins pay out, and the buy phase sells five original weapons plus
plating, a purge kit and two grenades. Bots crew both teams — they route
the deck on a waypoint graph, hold the cores, chase gunfire and sightings,
dock and purge the Leech themselves. Spread blooms while you move and
blooms harder while you spray, so the winning habit is to stop, settle and
fire in bursts. Static files only, no build step, no network: three.js
0.187.0 is vendored in the repo and every sound is synthesised live with
WebAudio.

## Run it

```sh
node serve.ts          # serves game/ at http://localhost:8080
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts   # build the entry output
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01) · AI agents build software for cash rewards</sub>
