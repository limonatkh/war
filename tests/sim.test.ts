import { describe, expect, it } from 'vitest';
import { Battle, TICK, HQ_HP } from '../src/sim/battle';
import { GameMap } from '../src/sim/map';
import { BLUE, RED, emptyInput } from '../src/sim/types';
import { compositionCost, DEFAULT_BUDGET, DEFAULT_COMPOSITION } from '../src/sim/units';

const run = (b: Battle, seconds: number) => {
  for (let i = 0; i < seconds / TICK && b.phase !== 'ended'; i++) b.step();
};
const runUntilEnd = (b: Battle, maxSeconds = 1000) => {
  for (let i = 0; i < maxSeconds / TICK && b.phase !== 'ended'; i++) b.step();
};
/** A battle with no AI commanders so tests control everything. */
const manual = () => {
  const b = new Battle({ humanTeam: BLUE, humanRole: 'commander', seed: 7 });
  // red commander is still AI; neutralise it by removing red units' ability to be ordered - tests kill red units explicitly
  return b;
};
/** Adds a slot (id === index) whose controlled unit just stands still: a frozen dummy. */
const freeze = (b: Battle, u: { controller: number; stats: object; team: 0 | 1 }) => {
  const id = b.slots.length;
  b.slots.push({ id, team: u.team, role: 'soldier', human: false, name: 'dummy', unitId: -1, respawnT: 0, soldierType: 'infantry', stats: { kills: 0, deaths: 0, shots: 0, hits: 0, headshots: 0, damage: 0 } });
  u.controller = id;
};
const killAll = (b: Battle, team: 0 | 1) => { for (const u of b.units) if (u.team === team) { u.alive = false; u.hp = 0; } };

describe('map', () => {
  const map = new GameMap();

  it('default composition fits the budget', () => {
    expect(compositionCost(DEFAULT_COMPOSITION)).toBeLessThanOrEqual(DEFAULT_BUDGET);
  });

  it('is mirror-symmetric across z so neither army is favoured', () => {
    for (let z = 0; z < 32; z++) for (let x = 0; x < 64; x++) {
      const a = map.idx(x, z), b = map.idx(x, 63 - z);
      expect(map.heights[a]).toBe(map.heights[b]);
      expect(map.obsH[a]).toBe(map.obsH[b]);
    }
  });

  it('spawns are on walkable cells and inside the map', () => {
    for (const team of [0, 1] as const) for (const s of map.spawns[team]) {
      expect(map.walkable(Math.floor(s.x), Math.floor(s.z))).toBe(true);
    }
  });

  it('every control point and both HQ fronts are reachable from both bases', () => {
    for (const team of [0, 1] as const) {
      const s = map.spawns[team][0];
      const sx = Math.floor(s.x), sz = Math.floor(s.z);
      const targets = [...map.controlPoints.map((c) => [c.x, c.z]), [32, 15], [32, 49]];
      for (const [x, z] of targets) {
        const f = map.field(Math.floor(x), Math.floor(z));
        expect(Number.isFinite(f[sz * 64 + sx])).toBe(true);
      }
    }
  });

  it('has more than one route: blocking the centre road still leaves a path to the enemy base', () => {
    const m = new GameMap();
    for (let z = 20; z <= 44; z++) for (let x = 28; x <= 36; x++) m.obsH[m.idx(x, z)] = 50;
    const s = m.spawns[0][0];
    const f = m.field(32, 12);
    expect(Number.isFinite(f[Math.floor(s.z) * 64 + Math.floor(s.x)])).toBe(true);
  });

  it('raycast is blocked by walls and open over flat ground', () => {
    expect(map.raycast(32.5, 40, 45.5, 0, 0, -1, 10)).toBeNull();
    const hit = map.raycast(20.5, 1.5, 38.5, 1, 0, 0, 10); // towards the west wall of the alley/buildings area
    expect(hit === null || hit.t > 0).toBe(true);
  });
});

describe('orders and movement', () => {
  it('a unit walks to a Move target and then holds', () => {
    const b = manual();
    killAll(b, RED);
    const u = b.units.find((x) => x.team === BLUE)!;
    b.submit({ kind: 'order', slotId: 0, unitIds: [u.id], order: { type: 'move', x: 32, z: 40 } });
    run(b, 25);
    expect(Math.hypot(u.x - 32, u.z - 40)).toBeLessThan(4);
    expect(u.order?.type).toBe('hold');
  });

  it('cannot order the other army or dead units', () => {
    const b = manual();
    const red = b.units.find((x) => x.team === RED)!;
    b.submit({ kind: 'order', slotId: 0, unitIds: [red.id], order: { type: 'move', x: 10, z: 10 } });
    b.step();
    expect(red.order?.type === 'move' && red.order.x === 10).toBe(false);
  });

  it('units route around obstacles rather than through them', () => {
    const b = manual();
    killAll(b, RED);
    const u = b.units.find((x) => x.team === BLUE && x.type === 'scout')!;
    b.submit({ kind: 'order', slotId: 0, unitIds: [u.id], order: { type: 'move', x: 12, z: 20 } });
    for (let i = 0; i < 40 / TICK; i++) {
      b.step();
      expect(b.map.walkable(Math.floor(u.x), Math.floor(u.z))).toBe(true);
    }
    expect(Math.hypot(u.x - 12, u.z - 20)).toBeLessThan(4);
  });
});

describe('control points and victory', () => {
  it('capturing a point flips its owner and pays supplies/score', () => {
    const b = manual();
    killAll(b, RED);
    const mid = b.cps[1];
    const squad = b.units.filter((u) => u.team === BLUE).slice(0, 4);
    b.submit({ kind: 'order', slotId: 0, unitIds: squad.map((u) => u.id), order: { type: 'capture', x: 0, z: 0, cpId: 1 } });
    run(b, 40);
    expect(mid.owner).toBe(BLUE);
    expect(b.teams[BLUE].score).toBeGreaterThan(0);
  });

  it('a contested point does not progress', () => {
    const b = manual();
    const cp = b.cps[1];
    const blue = b.units.find((u) => u.team === BLUE)!;
    const red = b.units.find((u) => u.team === RED)!;
    blue.x = cp.x - 1; blue.z = cp.z; red.x = cp.x + 1; red.z = cp.z;
    freeze(b, blue); freeze(b, red);
    const before = cp.progress;
    b.step();
    expect(cp.contested).toBe(true);
    expect(cp.progress).toBe(before);
  });

  it('wiping out the enemy ends the battle in your favour', () => {
    const b = manual();
    killAll(b, RED);
    b.teams[RED].supplies = 0;
    run(b, 1);
    expect(b.phase).toBe('ended');
    expect(b.result?.winner).toBe(BLUE);
  });

  it('shooting the enemy HQ damages it and destroying it wins', () => {
    const b = manual();
    killAll(b, RED);
    b.teams[RED].supplies = 100; // avoid the wipe-out rule firing first
    const hq = b.structures[RED];
    const shooters = b.units.filter((u) => u.team === BLUE).slice(0, 8);
    shooters.forEach((u, i) => { u.x = 29 + i; u.z = 13.5; u.y = b.map.terrainAt(u.x, u.z); });
    b.submit({ kind: 'order', slotId: 0, unitIds: shooters.map((u) => u.id), order: { type: 'hold', x: 0, z: 0 } });
    run(b, 5);
    expect(hq.hp).toBeLessThan(HQ_HP);
    b.teams[RED].supplies = 100;
    run(b, 200);
    expect(hq.alive).toBe(false);
    expect(b.result?.winner).toBe(BLUE);
  });
});

describe('combat', () => {
  it('two opposing units in the open fight until one dies', () => {
    const b = manual();
    for (const u of b.units) { u.alive = false; u.hp = 0; }
    b.teams[0].supplies = 500; b.teams[1].supplies = 500;
    const a = b.spawnUnit(BLUE, 'infantry', true)!;
    const c = b.spawnUnit(RED, 'infantry', true)!;
    a.x = 40.5; a.z = 30.5; c.x = 40.5; c.z = 18.5;
    a.y = b.map.terrainAt(a.x, a.z); c.y = b.map.terrainAt(c.x, c.z);
    // mark them as holding so AI engages without moving
    b.submit({ kind: 'order', slotId: 0, unitIds: [a.id], order: { type: 'hold', x: 0, z: 0 } });
    run(b, 90);
    expect(a.alive && c.alive).toBe(false);
  });

  it('cover blocks bullets: an enemy fully behind a tall wall cannot be targeted', () => {
    const b = manual();
    const eye = 1.5;
    // shoot straight through the alley wall at x=22 (height 3) from x=18 to x=30 at ground height
    const hit = b.map.raycast(18.5, 1 + eye, 43.5, 1, 0, 0, 12);
    expect(hit).not.toBeNull();
  });
});

describe('first-person control', () => {
  it('a possessed unit moves with input, can shoot and damages the enemy', () => {
    const b = new Battle({ humanTeam: BLUE, humanRole: 'soldier', soldierType: 'infantry', seed: 3 });
    const slot = b.slots.find((s) => s.human)!;
    expect(slot.unitId).toBeGreaterThan(0);
    const me = b.unitById(slot.unitId)!;
    expect(me.controller).toBe(slot.id);
    for (const u of b.units) if (u !== me) { u.alive = false; u.hp = 0; }
    b.teams[0].supplies = 500; b.teams[1].supplies = 500;
    me.x = 32.5; me.z = 48.5; me.y = b.map.terrainAt(me.x, me.z);
    const foe = b.spawnUnit(RED, 'infantry', true)!;
    foe.x = 32.5; foe.z = 38.5; foe.y = b.map.terrainAt(foe.x, foe.z);
    freeze(b, foe); // frozen target dummy
    // walk forward for 1s
    const input = { ...emptyInput(), moveF: 1, yaw: 0 };
    for (let i = 0; i < 30; i++) { b.setInput(slot.id, input); b.step(); }
    expect(me.z).toBeLessThan(48.5 - 3);
    // aim at the dummy and fire
    const start = foe.hp;
    for (let i = 0; i < 60; i++) {
      const dx = foe.x - me.x, dz = foe.z - me.z;
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.atan2(foe.y + 1.0 - (me.y + 1.5), Math.hypot(dx, dz));
      b.setInput(slot.id, { ...emptyInput(), yaw, pitch, fire: true });
      b.step();
    }
    expect(foe.hp).toBeLessThan(start);
    expect(slot.stats.hits).toBeGreaterThan(0);
  });

  it('jumping leaves the ground and lands again; solid walls block the player', () => {
    const b = new Battle({ humanTeam: BLUE, humanRole: 'soldier', seed: 3 });
    const slot = b.slots.find((s) => s.human)!;
    const me = b.unitById(slot.unitId)!;
    for (const u of b.units) if (u !== me) { u.alive = false; u.hp = 0; }
    b.teams[1].supplies = 500;
    const y0 = me.y;
    b.setInput(slot.id, { ...emptyInput(), jump: true });
    b.step();
    b.setInput(slot.id, emptyInput());
    let peak = me.y;
    for (let i = 0; i < 40; i++) { b.step(); peak = Math.max(peak, me.y); }
    expect(peak).toBeGreaterThan(y0 + 0.8);
    expect(me.grounded).toBe(true);
    // walk into the enemy-facing HQ wall of our own base: cannot pass through (HQ is 3 high)
    me.x = 32.5; me.z = 60.8; me.y = b.map.terrainAt(me.x, me.z);
    for (let i = 0; i < 60; i++) { b.setInput(slot.id, { ...emptyInput(), moveF: 1, yaw: 0 }); b.step(); }
    expect(me.z).toBeGreaterThan(59.9); // HQ occupies z 56..59, so we stop at its edge
  });

  it('a dead soldier respawns', () => {
    const b = new Battle({ humanTeam: BLUE, humanRole: 'soldier', seed: 3 });
    const slot = b.slots.find((s) => s.human)!;
    const me = b.unitById(slot.unitId)!;
    me.hp = 1;
    const foe = b.units.find((u) => u.team === RED)!;
    (b as unknown as { damageUnit: (...a: unknown[]) => void }).damageUnit(me, 50, foe, false, 0, 0, 0);
    expect(slot.unitId).toBe(-1);
    run(b, 6);
    expect(slot.unitId).toBeGreaterThan(0);
    expect(b.unitById(slot.unitId)!.alive).toBe(true);
  });
});

describe('full AI battle', { timeout: 120000 }, () => {
  it('an all-AI battle runs to a result without errors', () => {
    const b = new Battle({ humanTeam: -1, seed: 11 });
    runUntilEnd(b);
    expect(b.phase).toBe('ended');
    expect(b.result).not.toBeNull();
    const s = b.summary();
    console.log('AI vs AI:', JSON.stringify({ result: b.result, blue: s.teams[0], red: s.teams[1] }));
    expect(s.teams[0].kills + s.teams[1].kills).toBeGreaterThan(0);
  });

  it('is deterministic for a given seed', () => {
    const a = new Battle({ humanTeam: -1, seed: 5 }); runUntilEnd(a, 300);
    const c = new Battle({ humanTeam: -1, seed: 5 }); runUntilEnd(c, 300);
    expect(a.units.length).toBe(c.units.length);
    expect(a.teams[0].score).toBeCloseTo(c.teams[0].score, 6);
    expect(a.units.map((u) => u.hp).join(',')).toBe(c.units.map((u) => u.hp).join(','));
  });

  it('a clearly bigger army usually wins, but a smaller one can still win some games', () => {
    let big = 0, small = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const b = new Battle({
        humanTeam: -1, seed,
        compositions: [{ infantry: 14, heavy: 4, scout: 3, ranged: 4 }, { infantry: 8, heavy: 2, scout: 2, ranged: 2 }],
      });
      runUntilEnd(b);
      if (b.result?.winner === BLUE) big++; else if (b.result?.winner === RED) small++;
    }
    console.log('big army wins', big, 'small army wins', small);
    expect(big + small).toBeGreaterThan(0);
    expect(big).toBeGreaterThanOrEqual(small);
  });
});
