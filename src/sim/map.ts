import type { Team } from './types';

export const MAP_W = 64;
export const MAP_H = 64;

// Ground surface kinds (rendering only).
export const G = { grass: 0, road: 1, sand: 2, stone: 3, bluePad: 4, redPad: 5 } as const;
// Obstacle kinds. Obstacles sit on top of terrain columns and block movement and bullets.
export const OB = { none: 0, wall: 1, cover: 2, rock: 3, tree: 4, hq: 5, crate: 6 } as const;

export interface CPDef { id: number; name: string; x: number; z: number; radius: number }
export interface SpawnPoint { x: number; z: number }

export interface RayHit { t: number; cx: number; cz: number; kind: number; owner: number }

// A small mulberry32 so the map is identical on every machine.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export class GameMap {
  readonly w = MAP_W;
  readonly h = MAP_H;
  readonly heights = new Int8Array(MAP_W * MAP_H);
  readonly ground = new Uint8Array(MAP_W * MAP_H);
  readonly obsH = new Float32Array(MAP_W * MAP_H); // obstacle height above terrain (0 = none)
  readonly obsKind = new Uint8Array(MAP_W * MAP_H);
  readonly obsOwner = new Int8Array(MAP_W * MAP_H).fill(-1); // team of an HQ cell
  readonly controlPoints: CPDef[] = [
    { id: 0, name: 'A', x: 12, z: 32, radius: 4.2 },
    { id: 1, name: 'B', x: 32, z: 32, radius: 4.8 },
    { id: 2, name: 'C', x: 52, z: 32, radius: 4.2 },
  ];
  readonly hq: [{ x: number; z: number }, { x: number; z: number }] = [{ x: 32, z: 58 }, { x: 32, z: 6 }];
  readonly spawns: [SpawnPoint[], SpawnPoint[]] = [[], []];
  private fields = new Map<number, Float64Array>();

  constructor() {
    this.generate();
  }

  idx(cx: number, cz: number) { return cz * MAP_W + cx; }
  inBounds(cx: number, cz: number) { return cx >= 0 && cz >= 0 && cx < MAP_W && cz < MAP_H; }

  /** Terrain column height at a continuous position. Out of bounds is a solid wall. */
  terrainAt(x: number, z: number): number {
    const cx = Math.floor(x), cz = Math.floor(z);
    if (!this.inBounds(cx, cz)) return 99;
    return this.heights[this.idx(cx, cz)];
  }

  /** Top of terrain + obstacle at a continuous position. */
  topAt(x: number, z: number): number {
    const cx = Math.floor(x), cz = Math.floor(z);
    if (!this.inBounds(cx, cz)) return 99;
    const i = this.idx(cx, cz);
    return this.heights[i] + this.obsH[i];
  }

  walkable(cx: number, cz: number): boolean {
    return this.inBounds(cx, cz) && this.obsH[this.idx(cx, cz)] === 0;
  }

  canStep(ax: number, az: number, bx: number, bz: number): boolean {
    if (!this.walkable(ax, az) || !this.walkable(bx, bz)) return false;
    return Math.abs(this.heights[this.idx(ax, az)] - this.heights[this.idx(bx, bz)]) <= 1;
  }

  /** Marches a ray through the voxel world. Returns the first solid cell hit, or null. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RayHit | null {
    const step = 0.12;
    for (let t = 0.05; t <= maxDist; t += step) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      const cx = Math.floor(x), cz = Math.floor(z);
      if (!this.inBounds(cx, cz)) return { t, cx, cz, kind: OB.wall, owner: -1 };
      const i = this.idx(cx, cz);
      if (y < this.heights[i] + this.obsH[i]) {
        return { t, cx, cz, kind: this.obsH[i] > 0 ? this.obsKind[i] : 0, owner: this.obsOwner[i] };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- navigation

  nearestWalkable(cx: number, cz: number): [number, number] {
    cx = Math.max(0, Math.min(MAP_W - 1, cx));
    cz = Math.max(0, Math.min(MAP_H - 1, cz));
    if (this.walkable(cx, cz)) return [cx, cz];
    for (let r = 1; r < 12; r++) {
      let best: [number, number] | null = null;
      let bd = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (!this.walkable(cx + dx, cz + dz)) continue;
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; best = [cx + dx, cz + dz]; }
        }
      }
      if (best) return best;
    }
    return [cx, cz];
  }

  /** Cost-to-goal field (Dijkstra). Shared between every unit heading to the same goal cell. */
  field(goalX: number, goalZ: number): Float64Array {
    const [gx, gz] = this.nearestWalkable(goalX, goalZ);
    const key = gz * MAP_W + gx;
    const cached = this.fields.get(key);
    if (cached) return cached;
    const dist = new Float64Array(MAP_W * MAP_H).fill(Infinity);
    // binary heap of [cost, index]
    const heap: number[] = [];
    const costs: number[] = [];
    const push = (c: number, i: number) => {
      let n = heap.length;
      heap.push(i); costs.push(c);
      while (n > 0) {
        const p = (n - 1) >> 1;
        if (costs[p] <= costs[n]) break;
        [costs[p], costs[n]] = [costs[n], costs[p]];
        [heap[p], heap[n]] = [heap[n], heap[p]];
        n = p;
      }
    };
    const pop = (): [number, number] => {
      const top: [number, number] = [costs[0], heap[0]];
      const lc = costs.pop()!, li = heap.pop()!;
      if (heap.length > 0) {
        costs[0] = lc; heap[0] = li;
        let n = 0;
        for (;;) {
          const l = 2 * n + 1, r = l + 1;
          let m = n;
          if (l < heap.length && costs[l] < costs[m]) m = l;
          if (r < heap.length && costs[r] < costs[m]) m = r;
          if (m === n) break;
          [costs[m], costs[n]] = [costs[n], costs[m]];
          [heap[m], heap[n]] = [heap[n], heap[m]];
          n = m;
        }
      }
      return top;
    };
    dist[key] = 0;
    push(0, key);
    while (heap.length) {
      const [c, i] = pop();
      if (c > dist[i]) continue;
      const cx = i % MAP_W, cz = (i / MAP_W) | 0;
      for (const [dx, dz, w] of DIRS) {
        const nx = cx + dx, nz = cz + dz;
        if (!this.canStep(cx, cz, nx, nz)) continue;
        if (dx !== 0 && dz !== 0 && (!this.canStep(cx, cz, cx + dx, cz) || !this.canStep(cx, cz, cx, cz + dz))) continue;
        const ni = nz * MAP_W + nx;
        const nc = c + w;
        if (nc < dist[ni]) { dist[ni] = nc; push(nc, ni); }
      }
    }
    if (this.fields.size > 96) this.fields.clear();
    this.fields.set(key, dist);
    return dist;
  }

  /** Best neighbouring cell to walk to when following a field. Null when at goal or boxed in. */
  nextCell(field: Float64Array, cx: number, cz: number): [number, number] | null {
    let best: [number, number] | null = null;
    let bv = field[cz * MAP_W + cx];
    for (const [dx, dz] of DIRS) {
      const nx = cx + dx, nz = cz + dz;
      if (!this.canStep(cx, cz, nx, nz)) continue;
      if (dx !== 0 && dz !== 0 && (!this.canStep(cx, cz, cx + dx, cz) || !this.canStep(cx, cz, cx, cz + dz))) continue;
      const v = field[nz * MAP_W + nx];
      if (v < bv) { bv = v; best = [nx, nz]; }
    }
    return best;
  }

  // ---------------------------------------------------------------- generation

  private mirrorZ(z: number) { return MAP_H - 1 - z; }

  private setObs(x: number, z: number, h: number, kind: number, owner = -1, mirror = true) {
    const put = (zz: number) => {
      if (!this.inBounds(x, zz)) return;
      const i = this.idx(x, zz);
      this.obsH[i] = h; this.obsKind[i] = kind; this.obsOwner[i] = owner;
    };
    put(z);
    if (mirror) put(this.mirrorZ(z));
  }

  private clearObs(x: number, z: number) {
    for (const zz of [z, this.mirrorZ(z)]) {
      if (!this.inBounds(x, zz)) continue;
      const i = this.idx(x, zz);
      this.obsH[i] = 0; this.obsKind[i] = 0; this.obsOwner[i] = -1;
    }
  }

  private occupied(x: number, z: number) { return !this.inBounds(x, z) || this.obsH[this.idx(x, z)] > 0; }

  private building(x0: number, z0: number, w: number, d: number, doors: [number, number][]) {
    for (let x = x0; x < x0 + w; x++) {
      for (let z = z0; z < z0 + d; z++) {
        const edge = x === x0 || z === z0 || x === x0 + w - 1 || z === z0 + d - 1;
        if (edge) this.setObs(x, z, 3, OB.wall);
      }
    }
    for (const [dx, dz] of doors) this.clearObs(dx, dz);
  }

  private generate() {
    // ---- terrain heights (symmetric about z = 32 so both armies get a fair map)
    for (let z = 0; z < MAP_H; z++) {
      for (let x = 0; x < MAP_W; x++) {
        const cx = x + 0.5, cz = z + 0.5, dz = Math.abs(cz - 32);
        let h = 1;
        const dB = Math.hypot(cx - 32, dz * 1.15); // central plateau
        if (dB < 4.2) h = 3; else if (dB < 6.2) h = 2;
        const dA = Math.hypot(cx - 12, dz * 0.95); // west hill (point A)
        if (dA < 3.4) h = 3; else if (dA < 5.8) h = Math.max(h, 2);
        const dC = Math.hypot(cx - 52, dz); // east bowl (point C)
        if (dC < 5.6) h = 0;
        for (const fx of [20, 44]) { // forward hills in front of each base
          const dF = Math.hypot(cx - fx, dz - 13);
          if (dF < 3.3) h = 2;
        }
        if (cx >= 22 && cx < 42 && dz >= 18) h = 1; // base pads stay flat
        this.heights[this.idx(x, z)] = h;
      }
    }

    // ---- ground surface kinds
    for (let z = 0; z < MAP_H; z++) {
      for (let x = 0; x < MAP_W; x++) {
        const cx = x + 0.5, cz = z + 0.5, dz = Math.abs(cz - 32);
        let g: number = G.grass;
        if (Math.abs(cx - 32) < 1.6 && dz > 4 && dz < 20) g = G.road; // main road to centre
        if (dz < 1.1 && cx > 6 && cx < 58) g = G.road; // front-line road
        if (Math.hypot(cx - 52, dz) < 5.6) g = G.sand;
        if (Math.hypot(cx - 32, dz * 1.15) < 3.2) g = G.stone;
        if (Math.hypot(cx - 12, dz * 0.95) < 2.6) g = G.stone;
        if (cx >= 22 && cx < 42 && dz >= 20) g = cz > 32 ? G.bluePad : G.redPad;
        this.ground[this.idx(x, z)] = g;
      }
    }

    // ---- headquarters (4x4 solid blocks)
    ([0, 1] as Team[]).forEach((team) => {
      const c = this.hq[team];
      for (let x = c.x - 2; x < c.x + 2; x++) {
        for (let z = c.z - 2; z < c.z + 2; z++) this.setObs(x, z, 3, OB.hq, team, false);
      }
    });

    // ---- buildings: ruins flanking the centre, with doorways so there are several ways in
    this.building(22, 34, 5, 4, [[24, 34], [26, 36]]);
    this.building(37, 34, 5, 4, [[39, 34], [37, 36]]);
    // narrow alley on the west side (3 cells wide) leading to point A
    for (let z = 40; z <= 47; z++) { this.setObs(22, z, 3, OB.wall); this.setObs(26, z, 3, OB.wall); }
    // pillars near the base
    for (const [x, z] of [[27, 56], [27, 59], [36, 56], [36, 59]]) this.setObs(x, z, 3, OB.wall);

    // ---- cover (sandbags / crates) - low enough to shoot over only when standing off, high enough to hide behind
    const cover = (x: number, z: number, n: number, horizontal = true, kind: number = OB.cover) => {
      for (let i = 0; i < n; i++) this.setObs(horizontal ? x + i : x, horizontal ? z : z + i, 1.2, kind);
    };
    cover(29, 35, 2); cover(33, 35, 2); cover(28, 38, 1); cover(35, 38, 1);                 // around the plateau
    cover(46, 40, 3); cover(52, 44, 3); cover(44, 48, 2, false, OB.crate); cover(57, 41, 2, false); // open east field
    cover(26, 53, 3); cover(37, 53, 3); cover(31, 46, 1, true, OB.crate); cover(34, 46, 1, true, OB.crate); // base front
    cover(8, 35, 2); cover(14, 35, 2); cover(11, 36, 1); cover(16, 30, 1, false);           // around hill A
    cover(5, 44, 3); cover(18, 50, 2);

    // ---- rocks ringing the east bowl and scattered around
    for (const [x, z] of [[46, 34], [58, 34], [52, 38], [49, 37], [55, 37], [47, 31], [57, 31], [60, 45], [40, 44], [3, 40]]) {
      this.setObs(x, z, 1.5 + ((x * 7 + z * 3) % 3) * 0.5, OB.rock);
    }

    // ---- trees (seeded scatter, kept away from lanes, points and buildings)
    const rand = rng(1337);
    let placed = 0;
    for (let tries = 0; tries < 400 && placed < 34; tries++) {
      const x = 1 + Math.floor(rand() * (MAP_W - 2));
      const z = 33 + Math.floor(rand() * 30);
      if (this.heights[this.idx(x, z)] !== 1) continue;
      if (this.ground[this.idx(x, z)] !== G.grass) continue;
      if (x >= 29 && x <= 35) continue; // keep the main road clear
      let blocked = false;
      for (let dx = -1; dx <= 1 && !blocked; dx++) for (let dz = -1; dz <= 1; dz++) if (this.occupied(x + dx, z + dz)) { blocked = true; break; }
      if (blocked) continue;
      if (this.controlPoints.some((c) => Math.hypot(x + 0.5 - c.x, z + 0.5 - c.z) < c.radius + 3)) continue;
      if (z >= 40 && z <= 47 && x >= 21 && x <= 27) continue; // alley mouth
      this.setObs(x, z, 3.4, OB.tree);
      placed++;
    }

    // ---- spawn points in front of each HQ
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 9; i++) {
        const x = 27.5 + i * 1.2, z = 52.5 - row * 1.4; // blue: north of HQ (towards the enemy)
        this.spawns[0].push({ x, z });
        this.spawns[1].push({ x, z: MAP_H - z });
      }
    }
  }
}
