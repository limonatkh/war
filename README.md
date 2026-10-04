# Lemonat: WAR (prototype)

Standalone voxel-style war/strategy prototype. Two armies (Blue vs Red). One **Army Commander** sees the map top-down and gives orders; **Soldiers** fight in first person and can follow or ignore those orders. Separate from the main Lemonat game.

## Run
```
npm install
npm run dev        # http://localhost:5173
npm test           # simulation tests
npm run build
```

## Controls
**Commander:** left-click / drag box = select · right-click = smart order (move / attack / capture) · order buttons (Move, Attack, Defend, Hold, Retreat, Capture) · 1-4 buy units · WASD/edge = pan · wheel = zoom · F = possess a soldier · Space = begin battle · minimap click = jump.
**Soldier (FPP):** WASD move · mouse aim · click shoot · Shift sprint · Space jump · Tab = back to commander.

## Architecture
- `src/sim` — pure deterministic TypeScript simulation (30 Hz, seeded RNG): map, units, orders, battle, commander AI. No rendering/DOM.
- `src/render` — Three.js voxel meshes, camera, effects.
- `src/ui` — menu, HUD, result screen. `src/audio.ts` — synthesized SFX.
- Players are `PlayerSlot`s issuing `Command`s through `Battle.submit`, so battalion commanders and networking can be added later without rewriting the sim.

## Status / honest notes
Verified with unit tests and headless-browser runs. Game feel, balance and real pointer-lock FPP aiming still need human playtesting. No networking yet. Roadmap: polish, battalion commanders, multiplayer, merge into Lemonat.
