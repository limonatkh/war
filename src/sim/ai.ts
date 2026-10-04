import type { Battle } from './battle';
import { MAX_UNITS } from './battle';
import { UNIT_DEFS } from './units';
import { BLUE, enemyOf, type OrderType, type Team, type Unit, type UnitTypeId } from './types';

interface Plan { type: OrderType; x: number; z: number; cpId: number; radius?: number }

/**
 * A deliberately simple AI commander. It issues the *same* orders a human commander can
 * (through Battle.submit), so the human and the AI play by identical rules.
 *
 * Think cycle (every ~3s):
 *  - keep a small home guard (more when enemies are seen near the HQ)
 *  - main force (infantry/heavy) takes the centre, or the weakest un-owned point
 *  - scouts raid the flank points, ranged units back the main force up
 *  - when it owns every point and is stronger, it pushes on the enemy HQ
 *  - spend supplies on reinforcements
 */
export class CommanderAI {
  private timer = 0.15;
  private seen = new Map<number, { x: number; z: number; t: number }>();
  private buyCycle = 0;

  constructor(readonly team: Team, private readonly seed: number) {}

  update(b: Battle, dt: number) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 2.6 + ((this.seed * 7.31) % 1) * 0.8;
    this.think(b);
  }

  private think(b: Battle) {
    const team = this.team, enemy = enemyOf(team);
    const map = b.map;
    const ownHq = map.hq[team], enemyHq = map.hq[enemy];
    const towardEnemy = team === BLUE ? -1 : 1;

    // remember what we have seen
    for (const id of b.visible[team]) {
      const e = b.unitById(id);
      if (e && e.alive) this.seen.set(id, { x: e.x, z: e.z, t: b.time });
    }
    for (const [id, s] of this.seen) {
      const e = b.unitById(id);
      if (!e || !e.alive || b.time - s.t > 12) this.seen.delete(id);
    }

    this.buy(b);

    const all = b.alive(team);
    const mine = all.filter((u) => u.controller < 0);
    if (!mine.length) return;

    const myHp = all.reduce((n, u) => n + u.hp, 0);
    const enHp = b.alive(enemy).reduce((n, u) => n + u.hp, 0);
    const ratio = myHp / Math.max(1, enHp);

    const homePoint = { x: ownHq.x, z: ownHq.z + towardEnemy * 8 };
    const threats = [...this.seen.values()].filter((s) => Math.hypot(s.x - ownHq.x, s.z - ownHq.z) < 26).length;

    const plans = new Map<number, Plan>();
    const assign = (u: Unit, p: Plan) => plans.set(u.id, p);
    const dist = (u: Unit, x: number, z: number) => Math.hypot(u.x - x, u.z - z);

    // ---- home guard
    let guardN = threats > 0 ? Math.min(mine.length, threats + 2) : (ratio > 1.8 ? 1 : 2);
    if (ratio < 0.45) guardN = Math.max(guardN, Math.ceil(mine.length * 0.6));
    const guards = mine.filter((u) => u.type !== 'scout').sort((a, c) => dist(a, ownHq.x, ownHq.z) - dist(c, ownHq.x, ownHq.z)).slice(0, guardN);
    for (const u of guards) assign(u, { type: 'defend', x: homePoint.x, z: homePoint.z, cpId: -1, radius: 9 });

    const free = mine.filter((u) => !plans.has(u.id));
    const scouts = free.filter((u) => u.type === 'scout');
    const main = free.filter((u) => u.type === 'infantry' || u.type === 'heavy');
    const ranged = free.filter((u) => u.type === 'ranged');

    // ---- choose targets
    const cps = b.cps;
    const owned = (id: number) => cps[id].owner === team;
    const notMine = cps.filter((c) => c.owner !== team);
    const fromBase = (c: { x: number; z: number }) => Math.hypot(c.x - ownHq.x, c.z - ownHq.z);

    let mainTarget: Plan;
    let flankTarget: Plan | null = null;
    if (notMine.length === 0) {
      // we hold everything: press the advantage if stronger, otherwise just hold the centre
      const push = ratio > 1.15;
      mainTarget = push
        ? { type: 'attack', x: enemyHq.x, z: enemyHq.z - towardEnemy * 9, cpId: -1, radius: 6 }
        : { type: 'defend', x: cps[1].x, z: cps[1].z - towardEnemy * 2, cpId: -1, radius: 8 };
    } else {
      const centre = !owned(1) ? cps[1] : null;
      const flanks = notMine.filter((c) => c.id !== 1).sort((a, c) => fromBase(a) - fromBase(c));
      const first = centre ?? flanks[0] ?? notMine[0];
      mainTarget = { type: 'capture', x: first.x, z: first.z, cpId: first.id };
      const pickFlank = flanks.find((c) => c.id !== first.id) ?? null;
      if (pickFlank) flankTarget = { type: 'capture', x: pickFlank.x, z: pickFlank.z, cpId: pickFlank.id };
    }

    // ---- main force (optionally split off a flank detachment when clearly stronger)
    let detach = 0;
    if (flankTarget && ratio > 1.3 && main.length >= 8) detach = Math.floor(main.length * 0.35);
    main.sort((a, c) => a.id - c.id).forEach((u, i) => {
      assign(u, i < detach && flankTarget ? flankTarget : mainTarget);
    });

    // ---- scouts raid whichever flank we do not own (prefer the far one)
    const raid: Plan | null = flankTarget
      ?? (notMine.length ? { type: 'capture', x: notMine[0].x, z: notMine[0].z, cpId: notMine[0].id } : null);
    for (const u of scouts) {
      assign(u, raid ?? { type: 'defend', x: cps[1].x, z: cps[1].z, cpId: -1, radius: 10 });
    }

    // ---- ranged units stand slightly behind the main target
    for (const u of ranged) {
      const behind = 7;
      assign(u, {
        type: mainTarget.type === 'capture' ? 'defend' : mainTarget.type,
        x: mainTarget.x, z: mainTarget.z + (team === BLUE ? behind : -behind),
        cpId: -1, radius: 5,
      });
    }

    // ---- issue orders, grouped so we submit one command per distinct plan; skip units already on it
    const groups = new Map<string, { plan: Plan; ids: number[] }>();
    for (const u of mine) {
      const p = plans.get(u.id);
      if (!p) continue;
      const cur = u.order;
      const same = cur && cur.cpId === p.cpId && Math.abs(cur.x - p.x) < 0.6 && Math.abs(cur.z - p.z) < 0.6 &&
        (p.cpId >= 0 || cur.type === p.type || (p.type === 'attack' && cur.type === 'defend') || (p.type === 'move' && cur.type === 'hold'));
      const sameCapture = cur && p.type === 'capture' && cur.type === 'capture' && cur.cpId === p.cpId;
      if (same || sameCapture) continue;
      const key = `${p.type}|${p.cpId}|${p.x.toFixed(1)}|${p.z.toFixed(1)}`;
      const g = groups.get(key) ?? { plan: p, ids: [] };
      g.ids.push(u.id);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      b.submit({
        kind: 'order', slotId: team, unitIds: g.ids,
        order: { type: g.plan.type, x: g.plan.x, z: g.plan.z, cpId: g.plan.cpId, radius: g.plan.radius },
      });
    }
  }

  private buy(b: Battle) {
    const team = this.team;
    if (b.alive(team).length >= MAX_UNITS) return;
    const cycle: UnitTypeId[] = ['infantry', 'infantry', 'heavy', 'ranged', 'infantry', 'scout'];
    const type = cycle[this.buyCycle % cycle.length];
    if (b.teams[team].supplies < UNIT_DEFS[type].cost) return;
    this.buyCycle++;
    b.submit({ kind: 'buy', slotId: team, unitType: type });
  }
}
