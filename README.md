# Lemonat: WAR — field command

A voxel strategy / first-person combat game. Lead the same army from above or directly control an existing unit. Choose your starting view, army, map and death behavior in the menu. No networking yet.

## Run

```sh
npm ci
npm run dev
npm test
npm run build
```

Open the local Vite URL. `dist/` is a static release suitable for GitHub Pages or other static hosting; the build uses relative asset paths.

## Field command

- **Tab:** switch between strategy and the last surviving controlled unit. In strategy, select a unit and press **F** to control it. The battle continues through both views.
- **Strategy:** click / drag to select, right-click to move / attack / capture. **WASD** pans; wheel zooms. **Space** begins deployment. **1–6** buy infantry, heavy, scout, ranged, tank, armoured car. **Shift+1/2/3** selects Alpha / Bravo / Charlie.
- **Squads:** **Ctrl+1/2/3** saves the current strategic selection to a squad. Squads initially match the three battalions. In first person, **1/2/3** chooses the recipient squad; **G** adds/removes the aimed friendly unit. A unit belongs to at most one saved squad.
- **Ground orders:** tap **Q** to move the active squad to the aimed terrain or attack an aimed enemy. Hold **Q**, move the mouse to an action, then release: **Follow me / Hold position / Move here / Attack here / Retreat**. The command wheel keeps the simulation running and suspends your movement/fire input. The HUD names the squad and shows its available, following and moving unit counts. Selected allies keep their visible ground rings.
- **First person:** **WASD**, mouse aim, click fire, **R** reload, **Shift** sprint, **Space** jump. Vehicles cannot jump or sprint. **P / Esc** pauses; **M** mutes. Touch controls include squad selection and field-order buttons.

Follow tracks the current unit with a spaced formation. An explicit new order replaces follow for only its recipients. Released units return to AI and retain their existing orders. A dead follow target makes followers hold their current ground.

## Death behavior

Choose **nearest surviving soldier**, **farthest surviving soldier**, or **return to strategy** in the menu or pause settings. The setting is remembered on this browser. Automatic transfer keeps the survivor's position, health, ammunition and identity, excludes vehicles and already controlled units, and respects battalion ownership. If no eligible soldier survives, return to strategy. Death never creates a free replacement unit; purchased reinforcements still arrive normally at HQ.

## Maps and vehicles

The original **Green Valley** plus **Desert Crossroads**, **Frontier Town**, and **Pine Pass**. Each has a distinct, mirrored terrain/cover layout, valid staging areas and three capture objectives.

**Tanks** carry a slow, powerful cannon and absorb small-arms damage. **Armoured cars** provide fast automatic fire support. Both have distinct voxel models, direct-control weapon views, costs, armour, movement and ammunition. They can receive strategic and squad orders; vehicle AI uses navigation with extra clearance. These are combat units; passenger transport and embark/disembark are not implemented.

## Architecture and validation

`src/sim` is deterministic TypeScript at 30 Hz. `src/render` uses Three.js; `src/ui` contains menu, HUD and results. Human ground starts retain command authority rather than introducing a competing friendly army AI. Battalion command still delegates other battalions to AI.

Simulation tests cover transfer policies, no replacement spawning, ownership, follow/order replacement, every map's symmetry and reachability, mixed-army battles and vehicle controls. GitHub Actions runs the standard test suite and TypeScript/Vite build and uploads the playable static build. Human playtesting remains necessary for aiming, touch layout and balance.

## Offline delivery

The accompanying `lemonat-war.html` is a self-contained release: download it and open it in a current Chrome, Edge or Firefox browser with WebGL2. It embeds all game modules and Three.js, so it does not need npm or an external CDN. The source for the same release is in the source ZIP.

To regenerate an offline file, place the installed Three.js `build/three.module.js` and `build/three.core.js` together, then run `node scripts/make-offline.mjs /absolute/three/build /absolute/lemonat-war.html` using Node 24. Standard development still uses Vite.

Validation: `npm test` passes all 43 tests; `npm run build` passes TypeScript checking and produces the Vite release. Chromium smoke checks cover menu selection, entering/leaving first person, the command wheel and squad follow orders without browser errors. Unit models and weapon views also construct successfully. Human playtesting remains necessary for balance and extended touch use.
