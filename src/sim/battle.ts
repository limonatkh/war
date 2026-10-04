import { CommanderAI } from './ai';
import { GameMap, MAP_H, MAP_W, OB, rng } from './map';
import { UNIT_DEFS, DEFAULT_COMPOSITION } from './units';
import {
  BLUE, RED, enemyOf, emptyInput,
  type BattleResult, type Command, type Composition, type ControlPoint, type ControlInput, type Order,
  type OrderType, type Phase, type PlayerSlot, type SimEvent, type SlotRole, type Structure, type Team,
  type TeamState, type Unit, type UnitDef, type UnitStats, type UnitTypeId,
} from './types';

export const TICK = 1 / 30;
export const SCORE_TO_WIN = 400;
export const MAX_TIME = 900; // seconds, then the higher score wins
export const HQ_HP = 3000;
export const HQ_DAMAGE_FACTOR = 0.5;
export const MAX_UNITS = 40;
const STEP_UP = 1.05;
const GRAVITY = 22;
const JUMP_SPEED = 8.2;
const EYE = 1.5;

export interface BattleConfig {
  seed?: number;
  compositions?: [Composition, Composition];
  /** Team of the human player, or -1 for an all-AI (headless) battle. */
  humanTeam?: Team | -1;
  humanRole?: SlotRole;
  soldierType?: UnitTypeId;
  /** Start in the deploy phase (human commander gives first orders, then presses Begin). */
  deploy?: boolean;
  /** Strength of the AI commander facing the human. */
  difficulty?: 'easy' | 'normal' | 'hard';
}

const newStats = (): UnitStats => ({ kills: 0, deaths: 0, shots: 0, hits: 0, headshots: 0, damage: 0 });

interface ShotResult {
  kind: 'none' | 'world' | 'unit' | 'structure';
  t: number;
  unit?: Unit;
  head?: boolean;
}

export class Battle {
  readonly map = new GameMap();
  readonly units: Unit[] = [];
  readonly structures: [Structure, Structure];
  readonly cps: ControlPoint[];
  readonly teams: [TeamState, TeamState];
  readonly slots: PlayerSlot[] = [];
  readonly events: SimEvent[] = [];
  readonly visible: [Set<number>, Set<number>] = [new Set(), new Set()]; // enemy unit ids each team can see
  phase: Phase;
  time = 0;
  tickCount = 0;
  result: BattleResult | null = null;
  humanTeam: Team | -1;
  humanSlotId = -1;

  private cmds: Command[] = [];
  private nextId = 1;
  private rand: () => number;
  private ais: (CommanderAI | null)[] = [null, null];

  constructor(cfg: BattleConfig = {}) {
    this.rand = rng(cfg.seed ?? 1);
    this.humanTeam = cfg.humanTeam ?? -1;
    const comps = cfg.compositions ?? [DEFAULT_COMPOSITION, DEFAULT_COMPOSITION];
    const humanRole = cfg.humanRole ?? 'commander';

    this.structures = [
      { id: 0, team: BLUE, x: this.map.hq[0].x, z: this.map.hq[0].z, hp: HQ_HP, maxHp: HQ_HP, alive: true },
      { id: 1, team: RED, x: this.map.hq[1].x, z: this.map.hq[1].z, hp: HQ_HP, maxHp: HQ_HP, alive: true },
    ];
    this.cps = this.map.controlPoints.map((c) => ({
      id: c.id, name: c.name, x: c.x, z: c.z, radius: c.radius,
      progress: 0, owner: -1 as -1 | Team, contested: false, heldBy: [0, 0] as [number, number],
    }));
    const freshTeam = (): TeamState => ({ supplies: 40, score: 0, suppliesSpent: 0, unitsLost: 0, kills: 0, spawned: 0, cpSeconds: 0 });
    this.teams = [freshTeam(), freshTeam()];

    // Slots: one commander slot per army (AI-run unless it's the human), plus an optional human soldier slot.
    for (const team of [BLUE, RED] as Team[]) {
      const human = this.humanTeam === team && humanRole === 'commander';
      this.slots.push({
        id: team, team, role: 'commander', human, name: human ? 'You' : 'AI Commander',
        unitId: -1, respawnT: 0, soldierType: 'infantry', stats: newStats(),
      });
      if (!human) this.ais[team] = new CommanderAI(team, this.rand() * 1000, this.humanTeam !== -1 && team !== this.humanTeam ? ({ easy: 2, normal: 1, hard: 0.6 })[cfg.difficulty ?? 'normal'] : 1);
    }
    if (this.humanTeam !== -1 && humanRole === 'soldier') {
      this.humanSlotId = 2;
      this.slots.push({
        id: 2, team: this.humanTeam, role: 'soldier', human: true, name: 'You',
        unitId: -1, respawnT: 0, soldierType: cfg.soldierType ?? 'infantry', stats: newStats(),
      });
    } else if (this.humanTeam !== -1) {
      this.humanSlotId = this.humanTeam;
    }

    // Initial deployment
    for (const team of [BLUE, RED] as Team[]) {
      const comp = comps[team];
      const order: UnitTypeId[] = ['heavy', 'infantry', 'ranged', 'scout'];
      for (const type of order) for (let i = 0; i < (comp[type] ?? 0); i++) this.spawnUnit(team, type, true);
    }
    // Human soldier takes control of a unit of the chosen type
    const soldier = this.slots.find((s) => s.role === 'soldier' && s.human);
    if (soldier) {
      const pick = this.units.find((u) => u.team === soldier.team && u.type === soldier.soldierType && u.controller < 0)
        ?? this.units.find((u) => u.team === soldier.team && u.controller < 0);
      if (pick) this.possess(soldier, pick);
    }

    this.phase = cfg.deploy ? 'deploy' : 'running';
    this.recomputeVisibility();
  }

  // ------------------------------------------------------------------ public API

  submit(cmd: Command) { this.cmds.push(cmd); }

  /** Advance the simulation by exactly one fixed tick. */
  step() {
    this.events.length = 0;
    this.applyCommands();
    for (const u of this.units) { u.px = u.x; u.py = u.y; u.pz = u.z; u.pyaw = u.yaw; }
    if (this.phase === 'ended') return;
    if (this.phase === 'deploy') { this.recomputeVisibility(); return; }

    this.time += TICK;
    this.tickCount++;
    const dt = TICK;

    for (const ai of this.ais) ai?.update(this, dt);
    for (const u of this.units) if (u.alive) this.updateUnit(u, dt);
    this.separate();
    this.updatePoints(dt);
    this.updateEconomy(dt);
    this.updateRespawns(dt);
    if (this.tickCount % 6 === 0) this.recomputeVisibility();
    this.checkVictory();
  }

  unitById(id: number): Unit | undefined {
    // ids are sequential; units are only appended, so index lookup is cheap
    const u = this.units[id - 1];
    return u && u.id === id ? u : undefined;
  }

  alive(team: Team): Unit[] { return this.units.filter((u) => u.team === team && u.alive); }

  canSee(team: Team, u: Unit): boolean { return u.team === team || this.visible[team].has(u.id); }

  spawnUnit(team: Team, type: UnitTypeId, free = false): Unit | null {
    const def = UNIT_DEFS[type];
    const ts = this.teams[team];
    if (!free) {
      if (ts.supplies < def.cost) return null;
      if (this.alive(team).length >= MAX_UNITS) return null;
    }
    // find a free spawn point
    const spots = this.map.spawns[team];
    let spot = spots[0];
    for (const s of spots) {
      if (!this.units.some((o) => o.alive && Math.hypot(o.x - s.x, o.z - s.z) < 0.9)) { spot = s; break; }
    }
    if (!free) { ts.supplies -= def.cost; ts.suppliesSpent += def.cost; }
    ts.spawned++;
    const y = this.map.terrainAt(spot.x, spot.z);
    const faceYaw = team === BLUE ? 0 : Math.PI; // blue faces north (-z), red faces south
    const u: Unit = {
      id: this.nextId++, team, type, x: spot.x, y, z: spot.z, px: spot.x, py: y, pz: spot.z,
      yaw: faceYaw, pyaw: faceYaw, pitch: 0, vy: 0, grounded: true,
      hp: def.hp, maxHp: def.hp, alive: true, deadAt: 0, order: null, controller: -1, input: emptyInput(),
      cooldown: 0, ammo: def.mag, reloadT: 0, targetId: -1, retargetT: this.rand() * 0.4, lastDamagedAt: -99,
      coverT: 0, coverCd: 0, coverX: 0, coverZ: 0, offX: 0, offZ: 0, moving: false, spottedUntil: 0, lastShotAt: -99,
      stats: newStats(),
    };
    this.units.push(u);
    this.events.push({ t: 'spawn', unitId: u.id, team });
    return u;
  }

  /** Strategic summary shown on the result screen. */
  summary() {
    const out = ([BLUE, RED] as Team[]).map((team) => {
      const alive = this.alive(team);
      const total = this.units.filter((u) => u.team === team).length;
      const hp = alive.reduce((n, u) => n + u.hp, 0);
      const maxHp = this.units.filter((u) => u.team === team).reduce((n, u) => n + u.maxHp, 0);
      const ts = this.teams[team];
      return {
        team, alive: alive.length, total, hpPct: maxHp ? hp / maxHp : 0,
        kills: ts.kills, lost: ts.unitsLost, score: ts.score, suppliesSpent: ts.suppliesSpent,
        cpSeconds: ts.cpSeconds, hqHp: this.structures[team].hp / this.structures[team].maxHp,
        pointsHeld: this.cps.filter((c) => c.owner === team).map((c) => c.name),
      };
    });
    const slot = this.slots.find((s) => s.human);
    return { teams: out, result: this.result, duration: this.time, player: slot ? { ...slot.stats, team: slot.team, role: slot.role } : null };
  }

  // ------------------------------------------------------------------ commands

  private applyCommands() {
    for (const c of this.cmds) {
      switch (c.kind) {
        case 'begin':
          if (this.phase === 'deploy') this.phase = 'running';
          break;
        case 'order': this.issueOrder(c.slotId, c.unitIds, c.order); break;
        case 'buy': {
          const slot = this.slots[c.slotId];
          if (slot && slot.role === 'commander') this.spawnUnit(slot.team, c.unitType);
          break;
        }
        case 'possess': {
          const slot = this.slots[c.slotId];
          if (!slot) break;
          if (c.unitId < 0) this.release(slot);
          else {
            const u = this.unitById(c.unitId);
            if (u && u.alive && u.team === slot.team && u.controller < 0) this.possess(slot, u);
          }
          break;
        }
        case 'input': {
          const slot = this.slots[c.slotId];
          const u = slot && slot.unitId >= 0 ? this.unitById(slot.unitId) : undefined;
          if (u && u.alive) u.input = c.input;
          break;
        }
      }
    }
    this.cmds.length = 0;
  }

  issueOrder(slotId: number, unitIds: number[], o: { type: OrderType; x: number; z: number; cpId?: number; radius?: number }) {
    const slot = this.slots[slotId];
    if (!slot || slot.role !== 'commander') return;
    const defaults: Record<OrderType, number> = { move: 2.5, attack: 4, defend: 7, hold: 0, retreat: 6, capture: 0 };
    const applied: number[] = [];
    for (const id of unitIds) {
      const u = this.unitById(id);
      if (!u || !u.alive || u.team !== slot.team) continue;
      let radius = o.radius ?? defaults[o.type];
      let x = o.x, z = o.z;
      if (o.type === 'capture') {
        const cp = this.cps[o.cpId ?? -1];
        if (!cp) continue;
        x = cp.x; z = cp.z; radius = cp.radius * 0.7;
      }
      if (o.type === 'retreat') {
        const h = this.map.hq[slot.team];
        const dir = slot.team === BLUE ? -1 : 1;
        x = h.x; z = h.z + dir * 5; // just in front of the HQ
      }
      if (o.type === 'hold') { x = u.x; z = u.z; }
      if (!this.map.walkable(Math.floor(x), Math.floor(z))) {
        const [wx, wz] = this.map.nearestWalkable(Math.floor(x), Math.floor(z));
        x = wx + 0.5; z = wz + 0.5;
      }
      u.order = { type: o.type, x, z, radius, cpId: o.cpId ?? -1, issuer: slotId, issuedAt: this.time };
      // personal offset so units spread inside the radius instead of stacking on one cell
      const a = u.id * 2.399963; // golden angle
      const r = Math.sqrt(((u.id * 0.618034) % 1)) * radius * 0.8;
      u.offX = Math.cos(a) * r; u.offZ = Math.sin(a) * r;
      u.coverT = 0;
      applied.push(id);
    }
    if (applied.length) this.events.push({ t: 'order', team: slot.team, unitIds: applied, order: o.type });
  }

  private possess(slot: PlayerSlot, u: Unit) {
    this.release(slot);
    u.controller = slot.id;
    u.input = emptyInput();
    u.input.yaw = u.yaw;
    slot.unitId = u.id;
  }

  private release(slot: PlayerSlot) {
    const prev = slot.unitId >= 0 ? this.unitById(slot.unitId) : undefined;
    if (prev) { prev.controller = -1; prev.input = emptyInput(); }
    slot.unitId = -1;
  }

  // ------------------------------------------------------------------ per-unit update

  private updateUnit(u: Unit, dt: number) {
    const def = UNIT_DEFS[u.type];
    u.cooldown = Math.max(0, u.cooldown - dt);
    u.coverCd = Math.max(0, u.coverCd - dt);
    if (u.reloadT > 0) {
      u.reloadT -= dt;
      if (u.reloadT <= 0) { u.reloadT = 0; u.ammo = def.mag; }
    } else if (u.ammo <= 0) {
      u.reloadT = def.reload;
    }
    if (u.controller >= 0) this.controlled(u, def, dt);
    else this.ai(u, def, dt);
  }

  // ---- human-controlled soldier (first person) --------------------------------

  private footprintTops(x: number, z: number, r: number): number {
    let top = -1;
    for (let cz = Math.floor(z - r); cz <= Math.floor(z + r); cz++) {
      for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
        if (!this.map.inBounds(cx, cz)) return 99;
        const i = this.map.idx(cx, cz);
        top = Math.max(top, this.map.heights[i] + this.map.obsH[i]);
      }
    }
    return top;
  }

  private controlled(u: Unit, def: UnitDef, dt: number) {
    const inp = u.input;
    u.yaw = inp.yaw;
    u.pitch = inp.pitch;
    const sprint = inp.sprint && inp.moveF > 0.1;
    const speed = def.speed * (sprint ? 1.4 : 1);
    let wx = -Math.sin(inp.yaw) * inp.moveF + Math.cos(inp.yaw) * inp.moveR;
    let wz = -Math.cos(inp.yaw) * inp.moveF - Math.sin(inp.yaw) * inp.moveR;
    const len = Math.hypot(wx, wz);
    if (len > 1) { wx /= len; wz /= len; }
    u.moving = len > 0.05;
    const r = 0.3 * def.scale;
    const nx = u.x + wx * speed * dt;
    if (this.footprintTops(nx, u.z, r) <= u.y + STEP_UP) u.x = nx;
    const nz = u.z + wz * speed * dt;
    if (this.footprintTops(u.x, nz, r) <= u.y + STEP_UP) u.z = nz;
    u.x = Math.max(0.5, Math.min(MAP_W - 0.5, u.x));
    u.z = Math.max(0.5, Math.min(MAP_H - 0.5, u.z));

    const ground = this.footprintTops(u.x, u.z, r);
    if (u.grounded) {
      if (inp.jump) { u.vy = JUMP_SPEED; u.grounded = false; }
      else if (ground >= u.y - 0.05) u.y = ground;
      else { u.grounded = false; u.vy = 0; }
    }
    if (!u.grounded) {
      u.vy -= GRAVITY * dt;
      u.y += u.vy * dt;
      if (u.y <= ground && u.vy <= 0) { u.y = ground; u.vy = 0; u.grounded = true; }
    }

    if (inp.reload && u.reloadT <= 0 && u.ammo < def.mag) u.reloadT = def.reload;
    if (inp.fire && !sprint && u.cooldown <= 0 && u.reloadT <= 0 && u.ammo > 0) {
      // the player aims exactly where the crosshair points; only movement adds bloom
      const bloom = def.spread * 0.35 * (u.moving ? 2.2 : 1) * (u.grounded ? 1 : 2);
      this.fireShot(u, def, u.yaw, u.pitch, bloom, EYE * def.scale);
    }
  }

  // ---- AI soldier ------------------------------------------------------------

  private eye(u: Unit) { return u.y + EYE * UNIT_DEFS[u.type].scale; }
  private center(u: Unit) { return u.y + 0.9 * UNIT_DEFS[u.type].scale; }

  private los(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number, targetHq: Team | -1 = -1): boolean {
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.01) return true;
    const hit = this.map.raycast(ox, oy, oz, dx / d, dy / d, dz / d, d);
    if (!hit) return true;
    if (targetHq !== -1 && hit.kind === OB.hq && hit.owner === targetHq) return true;
    return hit.t >= d - 0.7;
  }

  private acquireTarget(u: Unit, def: UnitDef) {
    const enemy = enemyOf(u.team);
    const cand: { e: Unit; d: number }[] = [];
    const maxD = def.range * 1.05;
    for (const e of this.units) {
      if (!e.alive || e.team !== enemy) continue;
      const d = Math.hypot(e.x - u.x, e.z - u.z);
      if (d <= maxD) cand.push({ e, d });
    }
    cand.sort((a, b) => a.d - b.d);
    const ox = u.x, oy = this.eye(u), oz = u.z;
    for (let i = 0; i < Math.min(5, cand.length); i++) {
      const e = cand[i].e;
      if (this.los(ox, oy, oz, e.x, this.center(e), e.z)) { u.targetId = e.id; return; }
    }
    const hq = this.structures[enemy];
    if (hq.alive) {
      const d = Math.hypot(hq.x - u.x, hq.z - u.z);
      if (d <= def.range + 1 && this.los(ox, oy, oz, hq.x, this.map.terrainAt(hq.x, hq.z) + 1.5, hq.z, enemy)) {
        u.targetId = -2; return;
      }
    }
    u.targetId = -1;
  }

  private targetPos(u: Unit): { x: number; y: number; z: number; unit?: Unit } | null {
    if (u.targetId === -2) {
      const hq = this.structures[enemyOf(u.team)];
      return hq.alive ? { x: hq.x, y: this.map.terrainAt(hq.x, hq.z) + 1.5, z: hq.z } : null;
    }
    if (u.targetId < 0) return null;
    const e = this.unitById(u.targetId);
    if (!e || !e.alive) return null;
    return { x: e.x, y: this.center(e), z: e.z, unit: e };
  }

  private ai(u: Unit, def: UnitDef, dt: number) {
    u.retargetT -= dt;
    if (u.retargetT <= 0) {
      u.retargetT = 0.35 + this.rand() * 0.25;
      this.acquireTarget(u, def);
    }
    u.coverT = Math.max(0, u.coverT - dt);

    let tgt = this.targetPos(u);
    let engage = false;
    if (tgt) {
      const d = Math.hypot(tgt.x - u.x, tgt.z - u.z);
      engage = d <= def.range && this.los(u.x, this.eye(u), u.z, tgt.x, tgt.y, tgt.z, u.targetId === -2 ? enemyOf(u.team) : -1);
      if (!engage) tgt = null;
    }

    const o = u.order;
    let gx = u.x, gz = u.z;
    let wantMove = false;
    let stopToFight = false;
    let arrived = false;

    if (o) {
      switch (o.type) {
        case 'hold':
          stopToFight = true;
          break;
        case 'move':
          gx = o.x + u.offX; gz = o.z + u.offZ; wantMove = true;
          break;
        case 'attack':
          gx = o.x + u.offX; gz = o.z + u.offZ; wantMove = true; stopToFight = true;
          break;
        case 'defend':
          gx = o.x + u.offX; gz = o.z + u.offZ; stopToFight = true;
          wantMove = Math.hypot(gx - u.x, gz - u.z) > Math.max(1.5, o.radius * 0.5);
          break;
        case 'retreat':
          gx = o.x + u.offX; gz = o.z + u.offZ; wantMove = true;
          break;
        case 'capture': {
          const cp = this.cps[o.cpId];
          gx = cp.x + u.offX; gz = cp.z + u.offZ;
          wantMove = Math.hypot(gx - u.x, gz - u.z) > 1.2;
          stopToFight = Math.hypot(cp.x - u.x, cp.z - u.z) < cp.radius; // fight from inside the point
          break;
        }
      }
    }

    // Under fire and cover is nearby: duck behind it for a moment
    if (o && o.type !== 'move' && o.type !== 'retreat' && u.coverT <= 0 && u.coverCd <= 0 &&
        this.time - u.lastDamagedAt < 1.2 && u.hp < u.maxHp * 0.8) {
      const th = this.threatDir(u);
      const c = th ? this.findCover(u, th.x, th.z) : null;
      if (c) { u.coverT = 2.6; u.coverCd = 7; u.coverX = c.x; u.coverZ = c.z; }
    }
    if (u.coverT > 0) { gx = u.coverX; gz = u.coverZ; wantMove = Math.hypot(gx - u.x, gz - u.z) > 0.4; stopToFight = false; }

    const fightingStill = engage && stopToFight && u.coverT <= 0;
    u.moving = false;
    if (wantMove && !fightingStill) {
      const speed = def.speed * (o?.type === 'retreat' ? 1.1 : 1) * (engage ? 0.8 : 1);
      arrived = this.moveToward(u, gx, gz, speed, dt, tgt ? tgt : null);
    }
    if (arrived && o) {
      if (o.type === 'move') u.order = { ...o, type: 'hold' };
      else if (o.type === 'attack' || o.type === 'retreat') u.order = { ...o, type: 'defend' };
    }

    // Shooting
    if (tgt && engage && u.cooldown <= 0 && u.reloadT <= 0 && u.ammo > 0) {
      const dx = tgt.x - u.x, dz = tgt.z - u.z;
      const dist = Math.hypot(dx, dz);
      const eyeY = this.eye(u);
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.atan2(tgt.y - eyeY, dist);
      const moving = u.moving ? 1.8 : 1;
      const err = def.spread * (0.7 + dist / def.range) * moving;
      this.fireShot(u, def, yaw, pitch, err, eyeY - u.y, true);
    } else if (tgt && engage) {
      // turn to face the enemy while waiting for the weapon
      const want = Math.atan2(-(tgt.x - u.x), -(tgt.z - u.z));
      u.yaw = this.turnTo(u.yaw, want, 8 * dt);
    }
  }

  private turnTo(cur: number, want: number, maxStep: number) {
    let d = want - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) <= maxStep) return want;
    return cur + Math.sign(d) * maxStep;
  }

  private threatDir(u: Unit): { x: number; z: number } | null {
    // direction towards the nearest visible enemy
    let best: Unit | null = null;
    let bd = 40;
    for (const e of this.units) {
      if (!e.alive || e.team === u.team) continue;
      const d = Math.hypot(e.x - u.x, e.z - u.z);
      if (d < bd) { bd = d; best = e; }
    }
    return best ? { x: best.x, z: best.z } : null;
  }

  /** A walkable cell next to a tall-enough obstacle on the side facing the threat. */
  private findCover(u: Unit, tx: number, tz: number): { x: number; z: number } | null {
    const ux = Math.floor(u.x), uz = Math.floor(u.z);
    let best: { x: number; z: number } | null = null;
    let bd = Infinity;
    const tdx = tx - u.x, tdz = tz - u.z;
    const tl = Math.hypot(tdx, tdz) || 1;
    for (let dz = -5; dz <= 5; dz++) {
      for (let dx = -5; dx <= 5; dx++) {
        const cx = ux + dx, cz = uz + dz;
        if (!this.map.walkable(cx, cz)) continue;
        if (Math.abs(this.map.heights[this.map.idx(cx, cz)] - this.map.terrainAt(u.x, u.z)) > 1) continue;
        // look for a blocking obstacle in the direction of the threat
        const sx = Math.round(tdx / tl), sz = Math.round(tdz / tl);
        const ox = cx + sx, oz = cz + sz;
        if (!this.map.inBounds(ox, oz)) continue;
        const oi = this.map.idx(ox, oz);
        if (this.map.obsH[oi] < 1.1 || this.map.obsKind[oi] === OB.hq) continue;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = { x: cx + 0.5, z: cz + 0.5 }; }
      }
    }
    return best;
  }

  /** Walks one step along the shared flow field. Returns true when the goal has been reached. */
  private moveToward(u: Unit, gx: number, gz: number, speed: number, dt: number, aimAt: { x: number; z: number } | null): boolean {
    const dist = Math.hypot(gx - u.x, gz - u.z);
    if (dist < 0.45) return true;
    let cx = Math.floor(u.x), cz = Math.floor(u.z);
    if (!this.map.walkable(cx, cz)) { [cx, cz] = this.map.nearestWalkable(cx, cz); }
    const field = this.map.field(Math.floor(gx), Math.floor(gz));
    const goalCell = this.map.nearestWalkable(Math.floor(gx), Math.floor(gz));
    let tx = gx, tz = gz;
    if (!(cx === goalCell[0] && cz === goalCell[1])) {
      const next = this.map.nextCell(field, cx, cz);
      if (!next) return false;
      tx = next[0] + 0.5; tz = next[1] + 0.5;
    }
    let dx = tx - u.x, dz = tz - u.z;
    const dl = Math.hypot(dx, dz);
    if (dl < 1e-4) return false;
    dx /= dl; dz /= dl;
    const stepLen = Math.min(speed * dt, dl > 0.05 ? dl : speed * dt);
    const nx = u.x + dx * stepLen, nz = u.z + dz * stepLen;
    const ncx = Math.floor(nx), ncz = Math.floor(nz);
    let moved = false;
    if (ncx === cx && ncz === cz) { u.x = nx; u.z = nz; moved = true; }
    else if (this.map.canStep(cx, cz, ncx, ncz)) {
      // crossing a cell border: make sure the diagonal corner is not blocked
      if (ncx === cx || ncz === cz || (this.map.canStep(cx, cz, ncx, cz) && this.map.canStep(cx, cz, cx, ncz))) {
        u.x = nx; u.z = nz; moved = true;
      }
    }
    if (moved) {
      u.moving = true;
      u.y = this.map.terrainAt(u.x, u.z);
      if (aimAt) {
        u.yaw = this.turnTo(u.yaw, Math.atan2(-(aimAt.x - u.x), -(aimAt.z - u.z)), 10 * dt);
      } else {
        u.yaw = this.turnTo(u.yaw, Math.atan2(-dx, -dz), 9 * dt);
      }
    }
    return false;
  }

  /** Soft push between units so a crowd spreads out instead of stacking on a single point. */
  private separate() {
    const list = this.units.filter((u) => u.alive);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const dx = b.x - a.x, dz = b.z - a.z;
        if (Math.abs(dx) > 0.8 || Math.abs(dz) > 0.8) continue;
        const d = Math.hypot(dx, dz) || 0.001;
        if (d >= 0.8) continue;
        const push = (0.8 - d) * 0.5;
        const nx = (dx / d) * push, nz = (dz / d) * push;
        if (a.controller < 0) this.nudge(a, -nx, -nz);
        if (b.controller < 0) this.nudge(b, nx, nz);
      }
    }
  }

  private nudge(u: Unit, dx: number, dz: number) {
    const cx = Math.floor(u.x), cz = Math.floor(u.z);
    const nx = u.x + dx, nz = u.z + dz;
    const ncx = Math.floor(nx), ncz = Math.floor(nz);
    if ((ncx === cx && ncz === cz) || this.map.canStep(cx, cz, ncx, ncz)) {
      if (ncx !== cx && ncz !== cz && !(this.map.canStep(cx, cz, ncx, cz) && this.map.canStep(cx, cz, cx, ncz))) return;
      u.x = nx; u.z = nz;
      u.y = this.map.terrainAt(u.x, u.z);
    }
  }

  // ------------------------------------------------------------------ combat

  private fireShot(u: Unit, def: UnitDef, yaw: number, pitch: number, spread: number, eyeOffset: number, isAI = false) {
    u.cooldown = def.cooldown;
    u.ammo--;
    u.lastShotAt = this.time;
    u.spottedUntil = this.time + 1.6;
    u.stats.shots++;
    const slot = u.controller >= 0 ? this.slots[u.controller] : null;
    if (slot) slot.stats.shots++;
    if (isAI) u.yaw = yaw;

    // gaussian-ish aim error
    const g = () => (this.rand() + this.rand() + this.rand() - 1.5) / 0.75;
    const ey = yaw + g() * spread;
    const ep = pitch + g() * spread;
    const dx = -Math.sin(ey) * Math.cos(ep), dy = Math.sin(ep), dz = -Math.cos(ey) * Math.cos(ep);
    const ox = u.x, oy = u.y + eyeOffset, oz = u.z;
    const res = this.resolveShot(u, ox, oy, oz, dx, dy, dz, def.range + 4);
    const t = res.kind === 'none' ? def.range + 4 : res.t;
    this.events.push({
      t: 'shot', team: u.team, unitId: u.id,
      fx: ox + dx * 0.6, fy: oy - 0.15 + dy * 0.6, fz: oz + dz * 0.6,
      tx: ox + dx * t, ty: oy + dy * t, tz: oz + dz * t, hit: res.kind,
    });

    if (res.kind === 'unit' && res.unit) {
      const head = !!res.head;
      const dmg = def.damage * (head ? 1.6 : 1);
      u.stats.hits++; if (slot) slot.stats.hits++;
      if (head) { u.stats.headshots++; if (slot) slot.stats.headshots++; }
      this.damageUnit(res.unit, dmg, u, head, ox + dx * t, oy + dy * t, oz + dz * t);
    } else if (res.kind === 'structure') {
      const hq = this.structures[enemyOf(u.team)];
      if (hq.alive) {
        const dmg = def.damage * HQ_DAMAGE_FACTOR;
        hq.hp = Math.max(0, hq.hp - dmg);
        u.stats.damage += dmg; if (slot) slot.stats.damage += dmg;
        this.events.push({ t: 'structureHit', structureId: hq.id, hp: hq.hp });
        if (hq.hp <= 0) hq.alive = false;
      }
    }
  }

  private resolveShot(shooter: Unit, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, range: number): ShotResult {
    const world = this.map.raycast(ox, oy, oz, dx, dy, dz, range);
    let best: ShotResult = { kind: 'none', t: range };
    if (world) {
      const isEnemyHq = world.kind === OB.hq && world.owner === enemyOf(shooter.team);
      best = { kind: isEnemyHq ? 'structure' : 'world', t: world.t };
    }
    const a = dx * dx + dz * dz;
    for (const e of this.units) {
      if (!e.alive || e.team === shooter.team || a < 1e-8) continue;
      const def = UNIT_DEFS[e.type];
      const r = 0.42 * def.scale, height = 1.75 * def.scale;
      const rx = ox - e.x, rz = oz - e.z;
      const b = rx * dx + rz * dz;
      const c = rx * rx + rz * rz - r * r;
      const disc = b * b - a * c;
      if (disc < 0) continue;
      let t = (-b - Math.sqrt(disc)) / a;
      if (c < 0) t = 0;
      if (t < 0 || t > best.t) continue;
      const y = oy + dy * t;
      if (y < e.y || y > e.y + height) continue;
      best = { kind: 'unit', t, unit: e, head: y > e.y + height * 0.78 };
    }
    return best;
  }

  private damageUnit(target: Unit, amount: number, attacker: Unit, head: boolean, x: number, y: number, z: number) {
    if (!target.alive) return;
    const dealt = Math.min(amount, target.hp);
    target.hp -= amount;
    target.lastDamagedAt = this.time;
    attacker.stats.damage += dealt;
    const aslot = attacker.controller >= 0 ? this.slots[attacker.controller] : null;
    if (aslot) aslot.stats.damage += dealt;
    this.events.push({ t: 'hit', unitId: target.id, x, y, z, damage: amount, head, attackerId: attacker.id });
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.deadAt = this.time;
      target.stats.deaths++;
      attacker.stats.kills++;
      this.teams[target.team].unitsLost++;
      this.teams[attacker.team].kills++;
      if (aslot) aslot.stats.kills++;
      this.events.push({ t: 'death', unitId: target.id, team: target.team, killerId: attacker.id });
      if (target.controller >= 0) {
        const slot = this.slots[target.controller];
        slot.stats.deaths++;
        slot.unitId = -1;
        target.controller = -1;
        if (slot.role === 'soldier') slot.respawnT = 5;
        this.events.push({ t: 'possessLost', slotId: slot.id });
      }
    }
  }

  // ------------------------------------------------------------------ objectives, economy, victory

  private updatePoints(dt: number) {
    for (const cp of this.cps) {
      const n: [number, number] = [0, 0];
      for (const u of this.units) {
        if (u.alive && Math.hypot(u.x - cp.x, u.z - cp.z) <= cp.radius) n[u.team]++;
      }
      cp.heldBy = n;
      cp.contested = n[0] > 0 && n[1] > 0;
      if (!cp.contested && (n[0] > 0 || n[1] > 0)) {
        const dir = n[0] > 0 ? 1 : -1;
        const rate = 0.075 * Math.min(4, n[0] + n[1]);
        cp.progress = Math.max(-1, Math.min(1, cp.progress + dir * rate * dt));
      }
      const prev = cp.owner;
      if (cp.progress >= 1) cp.owner = BLUE;
      else if (cp.progress <= -1) cp.owner = RED;
      else if (cp.owner === BLUE && cp.progress < 0) cp.owner = -1;
      else if (cp.owner === RED && cp.progress > 0) cp.owner = -1;
      if (cp.owner !== prev) this.events.push({ t: 'capture', cpId: cp.id, owner: cp.owner });
    }
  }

  private updateEconomy(dt: number) {
    for (const cp of this.cps) {
      if (cp.owner === -1) continue;
      const ts = this.teams[cp.owner];
      ts.score += dt;
      ts.supplies += 0.9 * dt;
      ts.cpSeconds += dt;
    }
    this.teams[0].supplies += 0.35 * dt;
    this.teams[1].supplies += 0.35 * dt;
  }

  private updateRespawns(dt: number) {
    for (const slot of this.slots) {
      if (slot.role !== 'soldier' || slot.unitId >= 0 || slot.respawnT <= 0) continue;
      slot.respawnT -= dt;
      if (slot.respawnT <= 0) {
        slot.respawnT = 0;
        const u = this.spawnUnit(slot.team, slot.soldierType, true);
        if (u) {
          this.possess(slot, u);
          this.events.push({ t: 'respawn', slotId: slot.id, unitId: u.id });
        }
      }
    }
  }

  recomputeVisibility() {
    for (const team of [BLUE, RED] as Team[]) {
      const set = this.visible[team];
      set.clear();
      const mine = this.units.filter((u) => u.alive && u.team === team);
      const hq = this.structures[team];
      for (const e of this.units) {
        if (!e.alive || e.team === team) continue;
        if (e.spottedUntil > this.time) { set.add(e.id); continue; }
        if (Math.hypot(e.x - hq.x, e.z - hq.z) < 18) { set.add(e.id); continue; }
        for (const f of mine) {
          if (Math.hypot(e.x - f.x, e.z - f.z) <= UNIT_DEFS[f.type].vision) { set.add(e.id); break; }
        }
      }
    }
  }

  private end(winner: Team | -1, reason: string) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.result = { winner, reason, duration: this.time };
    this.events.push({ t: 'end', result: this.result });
  }

  private checkVictory() {
    for (const team of [BLUE, RED] as Team[]) {
      if (!this.structures[team].alive) return this.end(enemyOf(team), `${team === BLUE ? 'Blue' : 'Red'} headquarters destroyed`);
    }
    for (const team of [BLUE, RED] as Team[]) {
      if (this.teams[team].score >= SCORE_TO_WIN) {
        const held = this.cps.filter((c) => c.owner === team).length;
        return this.end(team, `Reached ${SCORE_TO_WIN} conquest points while holding ${held} control point${held === 1 ? '' : 's'}`);
      }
    }
    const minCost = Math.min(...Object.values(UNIT_DEFS).map((d) => d.cost));
    for (const team of [BLUE, RED] as Team[]) {
      const soldierPending = this.slots.some((s) => s.team === team && s.role === 'soldier' && s.respawnT > 0);
      if (this.alive(team).length === 0 && this.teams[team].supplies < minCost && !soldierPending) {
        return this.end(enemyOf(team), `${team === BLUE ? 'Blue' : 'Red'} army wiped out`);
      }
    }
    if (this.time >= MAX_TIME) {
      const [b, r] = [this.teams[0], this.teams[1]];
      if (Math.abs(b.score - r.score) > 1) return this.end(b.score > r.score ? BLUE : RED, 'Time limit - higher conquest score');
      const hpB = this.alive(BLUE).reduce((n, u) => n + u.hp, 0), hpR = this.alive(RED).reduce((n, u) => n + u.hp, 0);
      if (Math.abs(hpB - hpR) > 50) return this.end(hpB > hpR ? BLUE : RED, 'Time limit - stronger surviving army');
      return this.end(-1, 'Time limit - draw');
    }
  }

  /** Fixed-seed random in [0,1) for AI helpers that live outside this class. */
  random() { return this.rand(); }

  setInput(slotId: number, input: ControlInput) { this.submit({ kind: 'input', slotId, input }); }

  currentOrder(u: Unit): Order | null { return u.order; }
}
