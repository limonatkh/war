// Core data types for the Lemonat: WAR simulation.
// The simulation is pure TypeScript (no rendering / DOM / THREE), so it can run headless,
// be unit-tested, and later be driven over a network (commands in, state/events out).

export type Team = 0 | 1; // 0 = Blue, 1 = Red
export const BLUE: Team = 0;
export const RED: Team = 1;
export const enemyOf = (t: Team): Team => (t === 0 ? 1 : 0);
export const TEAM_NAME = ['Blue', 'Red'] as const;

export type UnitTypeId = 'infantry' | 'heavy' | 'scout' | 'ranged';
export const UNIT_TYPE_IDS: UnitTypeId[] = ['infantry', 'heavy', 'scout', 'ranged'];

export interface UnitDef {
  id: UnitTypeId;
  name: string;
  role: string;
  cost: number; // troop points (composition) and supplies (reinforcement)
  hp: number;
  speed: number; // cells / second
  damage: number;
  range: number;
  cooldown: number; // seconds between shots
  spread: number; // radians of aim error (AI) / base bloom (player)
  mag: number;
  reload: number; // seconds
  vision: number; // how far this unit reveals enemies to its commander
  scale: number; // visual + hitbox scale
}

export type OrderType = 'move' | 'attack' | 'defend' | 'hold' | 'retreat' | 'capture';
export const ORDER_TYPES: OrderType[] = ['move', 'attack', 'defend', 'hold', 'retreat', 'capture'];

export interface Order {
  type: OrderType;
  x: number;
  z: number;
  radius: number;
  cpId: number; // -1 when not tied to a control point
  issuer: number; // PlayerSlot id (commander) that issued it
  issuedAt: number;
}

export interface ControlInput {
  moveF: number; // -1..1 forward/back
  moveR: number; // -1..1 strafe right/left
  yaw: number;
  pitch: number;
  fire: boolean;
  jump: boolean;
  sprint: boolean;
  reload: boolean;
}

export const emptyInput = (): ControlInput => ({
  moveF: 0, moveR: 0, yaw: 0, pitch: 0, fire: false, jump: false, sprint: false, reload: false,
});

export interface UnitStats {
  kills: number;
  deaths: number;
  shots: number;
  hits: number;
  headshots: number;
  damage: number;
}

export interface Unit {
  id: number;
  team: Team;
  type: UnitTypeId;
  x: number; y: number; z: number;
  px: number; py: number; pz: number; // previous tick position (render interpolation)
  yaw: number; pyaw: number;
  pitch: number;
  vy: number;
  grounded: boolean;
  hp: number;
  maxHp: number;
  alive: boolean;
  deadAt: number;
  order: Order | null;
  controller: number; // PlayerSlot id or -1 (AI)
  input: ControlInput;
  cooldown: number;
  ammo: number;
  reloadT: number;
  targetId: number; // enemy unit id, -2 = enemy HQ, -1 none
  retargetT: number;
  lastDamagedAt: number;
  coverT: number;
  coverCd: number;
  coverX: number; coverZ: number;
  offX: number; offZ: number; // personal offset inside an order radius so units don't stack
  moving: boolean;
  spottedUntil: number; // revealed to the enemy commander until this time (after shooting)
  lastShotAt: number;
  stats: UnitStats;
}

export interface Structure {
  id: number;
  team: Team;
  x: number; z: number; // center
  hp: number;
  maxHp: number;
  alive: boolean;
}

export interface ControlPoint {
  id: number;
  name: string;
  x: number; z: number;
  radius: number;
  progress: number; // -1 (red) .. +1 (blue)
  owner: -1 | Team;
  contested: boolean;
  heldBy: [number, number]; // units inside per team (last tick)
}

export type SlotRole = 'commander' | 'soldier';
export interface PlayerSlot {
  id: number;
  team: Team;
  role: SlotRole;
  human: boolean;
  name: string;
  unitId: number; // possessed unit id or -1
  respawnT: number; // seconds until respawn when role === 'soldier' and dead (<=0: none pending)
  soldierType: UnitTypeId;
  stats: UnitStats;
}

export type Phase = 'deploy' | 'running' | 'ended';

export interface BattleResult {
  winner: Team | -1; // -1 = draw
  reason: string;
  duration: number;
}

export interface TeamState {
  supplies: number;
  score: number;
  suppliesSpent: number;
  unitsLost: number;
  kills: number;
  spawned: number;
  cpSeconds: number; // control-point-seconds held
}

export type SimEvent =
  | { t: 'shot'; team: Team; unitId: number; fx: number; fy: number; fz: number; tx: number; ty: number; tz: number; hit: 'none' | 'world' | 'unit' | 'structure' }
  | { t: 'hit'; unitId: number; x: number; y: number; z: number; damage: number; head: boolean; attackerId: number }
  | { t: 'death'; unitId: number; team: Team; killerId: number }
  | { t: 'order'; team: Team; unitIds: number[]; order: OrderType }
  | { t: 'capture'; cpId: number; owner: -1 | Team }
  | { t: 'spawn'; unitId: number; team: Team }
  | { t: 'structureHit'; structureId: number; hp: number }
  | { t: 'possessLost'; slotId: number }
  | { t: 'respawn'; slotId: number; unitId: number }
  | { t: 'end'; result: BattleResult };

export type Command =
  | { kind: 'order'; slotId: number; unitIds: number[]; order: { type: OrderType; x: number; z: number; cpId?: number; radius?: number } }
  | { kind: 'buy'; slotId: number; unitType: UnitTypeId }
  | { kind: 'possess'; slotId: number; unitId: number } // -1 releases
  | { kind: 'input'; slotId: number; input: ControlInput }
  | { kind: 'begin' };

export type Composition = Record<UnitTypeId, number>;
