import { describe, expect, it } from 'vitest';
import { Battle, TICK } from '../src/sim/battle';
import { GameMap, MAPS } from '../src/sim/map';
import { UNIT_DEFS } from '../src/sim/units';
import { BLUE, RED, emptyInput, type DeathBehavior, type Unit } from '../src/sim/types';

const damage = (b: Battle, target: Unit, amount = 10000) => {
  const foe = b.units.find((u) => u.team === RED)!;
  (b as unknown as { damageUnit: (...args: unknown[]) => void }).damageUnit(target, amount, foe, false, target.x, target.y, target.z);
};

for (const mode of ['nearest', 'farthest', 'commander'] as DeathBehavior[]) {
  it(`death policy ${mode} preserves surviving unit identity, health and ammunition`, () => {
    const b = new Battle({ humanTeam: BLUE, humanRole: 'soldier', deathBehavior: mode });
    const slot = b.slots[b.humanSlotId], me = b.unitById(slot.unitId)!;
    const allies = b.alive(BLUE).filter((u) => u.id !== me.id && !UNIT_DEFS[u.type].vehicle);
    allies.forEach((u, i) => { u.x = me.x + i + 2; u.z = me.z; u.hp = 37; u.ammo = 2; });
    const expected = mode === 'commander' ? -1 : mode === 'nearest' ? allies[0].id : allies[allies.length - 1].id;
    const size = b.units.length, spawned = b.teams[BLUE].spawned, supplies = b.teams[BLUE].supplies;
    damage(b, me);
    expect(slot.unitId).toBe(expected);
    expect(b.units.length).toBe(size);
    expect(b.teams[BLUE].spawned).toBe(spawned);
    expect(b.teams[BLUE].supplies).toBe(supplies);
    expect(me.alive).toBe(false);
    if (expected >= 0) {
      expect(b.unitById(expected)!.hp).toBe(37);
      expect(b.unitById(expected)!.ammo).toBe(2);
      expect(b.unitById(expected)!.controller).toBe(slot.id);
    }
  });
}

it('death with no eligible survivor falls back to strategy and never produces a free soldier', () => {
  const b = new Battle({ humanTeam: BLUE, humanRole: 'soldier', deathBehavior: 'nearest' });
  const slot = b.slots[b.humanSlotId], me = b.unitById(slot.unitId)!;
  for (const u of b.alive(BLUE)) if (u.id !== me.id) u.alive = false;
  const count = b.teams[BLUE].spawned;
  damage(b, me);
  for (let i = 0; i < 180; i++) b.step();
  expect(slot.unitId).toBe(-1);
  expect(b.teams[BLUE].spawned).toBe(count);
});

it('automatic transfer respects battalion ownership and excludes controlled units', () => {
  const b = new Battle({ humanTeam: BLUE, humanBattalion: 0, deathBehavior: 'farthest' });
  const slot = b.slots[b.humanSlotId];
  const own = b.alive(BLUE).filter((u) => u.battalion === 0);
  b.submit({ kind: 'possess', slotId: slot.id, unitId: own[0].id }); b.step();
  own[1].controller = 99;
  damage(b, own[0]);
  const next = b.unitById(slot.unitId)!;
  expect(next.battalion).toBe(0);
  expect(next.id).not.toBe(own[1].id);
});

it('ground start retains strategic authority and releases the same unit back to AI', () => {
  const b = new Battle({ humanTeam: BLUE, humanRole: 'soldier' });
  const slot = b.slots[b.humanSlotId], me = b.unitById(slot.unitId)!;
  expect(slot.role).toBe('commander');
  const follower = b.alive(BLUE).find((u) => u.controller < 0)!;
  b.issueOrder(slot.id, [follower.id], { type: 'follow', followId: me.id, x: me.x, z: me.z });
  expect(follower.order!.type).toBe('follow');
  b.submit({ kind: 'possess', slotId: slot.id, unitId: -1 }); b.step();
  expect(me.controller).toBe(-1);
  expect(slot.unitId).toBe(-1);
});

it('follow tracks a moving leader; move replaces follow; unrelated squads retain their orders', () => {
  const b = new Battle({ humanTeam: BLUE, humanRole: 'soldier', mapId: 'desert' });
  const slot = b.slots[b.humanSlotId], me = b.unitById(slot.unitId)!;
  const units = b.alive(BLUE).filter((u) => u.controller < 0 && !UNIT_DEFS[u.type].vehicle);
  const [follower, other] = units;
  b.issueOrder(slot.id, [other.id], { type: 'hold', x: other.x, z: other.z });
  b.issueOrder(slot.id, [follower.id], { type: 'follow', followId: me.id, x: me.x, z: me.z });
  me.x = 32; me.z = 42; b.step();
  expect(follower.order!.x).toBe(me.x);
  expect(follower.order!.z).toBe(me.z);
  expect(other.order!.type).toBe('hold');
  b.issueOrder(slot.id, [follower.id], { type: 'move', x: 52, z: 32 });
  expect(follower.order!.type).toBe('move');
  expect(follower.order!.followId).toBe(undefined);
  b.issueOrder(slot.id, [follower.id], { type: 'follow', followId: me.id, x: me.x, z: me.z });
  me.alive = false; b.step();
  expect(follower.order!.type).toBe('hold');
});

it('follow rejects an enemy or uncontrolled leader and orders never override another player', () => {
  const b = new Battle({ humanTeam: BLUE, humanRole: 'soldier' });
  const slot = b.slots[b.humanSlotId], me = b.unitById(slot.unitId)!;
  const ally = b.alive(BLUE).find((u) => u.controller < 0)!;
  const foe = b.alive(RED)[0];
  b.issueOrder(slot.id, [ally.id], { type: 'follow', followId: foe.id, x: 0, z: 0 });
  expect(ally.order).toBeNull();
  b.issueOrder(slot.id, [me.id], { type: 'move', x: 12, z: 32 });
  expect(me.order).toBeNull();
});

for (const spec of MAPS) describe(spec.name, () => {
  it('has symmetric terrain, valid spawns and reachable capture points from both bases', () => {
    const map = new GameMap(spec.id);
    for (let z = 0; z < 32; z++) for (let x = 0; x < 64; x++) {
      expect(map.heights[map.idx(x, z)]).toBe(map.heights[map.idx(x, 63 - z)]);
      expect(map.obsH[map.idx(x, z)]).toBe(map.obsH[map.idx(x, 63 - z)]);
    }
    for (const spawns of map.spawns) for (const s of spawns) expect(map.walkable(Math.floor(s.x), Math.floor(s.z))).toBe(true);
    for (const spawns of map.spawns) for (const cp of map.controlPoints) {
      const s = spawns[0], field = map.field(Math.floor(cp.x), Math.floor(cp.z));
      expect(Number.isFinite(field[map.idx(Math.floor(s.x), Math.floor(s.z))])).toBe(true);
    }
  });
  it('runs a mixed-army battle to a result with finite positions', () => {
    const b = new Battle({ mapId: spec.id, seed: 9 });
    for (let i = 0; i < 901 / TICK && b.phase !== 'ended'; i++) b.step();
    expect(b.phase).toBe('ended');
    for (const u of b.units) expect(Number.isFinite(u.x + u.y + u.z + u.hp)).toBe(true);
  });
});

it('new maps have distinct layouts', () => {
  const layouts = MAPS.map((m) => { const map = new GameMap(m.id); return JSON.stringify([Array.from(map.heights), Array.from(map.obsH), Array.from(map.ground)]); });
  expect(new Set(layouts).size).toBe(4);
});

it('vehicles deploy, accept orders, take armour damage and cannot jump or sprint', () => {
  const b = new Battle({ humanTeam: BLUE, mapId: 'desert' });
  const tank = b.alive(BLUE).find((u) => u.type === 'tank')!;
  expect(tank.hp).toBe(UNIT_DEFS.tank.hp);
  const hp = tank.hp; damage(b, tank, 50);
  // The default enemy's first unit is a tank: cannon damage bypasses small-arms armour.
  expect(tank.hp).toBe(hp - 50);
  b.submit({ kind: 'possess', slotId: b.humanSlotId, unitId: tank.id }); b.step();
  tank.x = 32.5; tank.z = 46.5; tank.y = 1;
  b.setInput(b.humanSlotId, { ...emptyInput(), jump: true, sprint: true, moveF: 1 });
  const z = tank.z; b.step();
  expect(tank.grounded).toBe(true);
  expect(tank.y).toBe(1);
  expect(z - tank.z).toBeCloseTo(UNIT_DEFS.tank.speed * TICK, 5);
});
