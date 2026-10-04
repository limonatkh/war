import * as THREE from 'three';
import type { Battle } from '../sim/battle';
import { MAP_H, MAP_W } from '../sim/map';
import { UNIT_DEFS } from '../sim/units';
import type { OrderType, SimEvent, Team, Unit } from '../sim/types';
import { Effects } from './effects';
import { createUnitModel, createViewModel, teamHex, type UnitModel } from './unitModel';
import { buildControlPoint, buildHq, buildProps, buildTerrain, type CpView, type HqView } from './world';

export type ViewMode = 'commander' | 'fpp';

export const ORDER_COLORS: Record<OrderType, string> = {
  move: '#6be07a', attack: '#ff6b5b', defend: '#6bb7ff', hold: '#c7c7c7', retreat: '#ffb347', capture: '#ffe96b',
};

interface UnitView {
  id: number;
  model: UnitModel;
  phase: number;
  y: number;
  fall: number;
  gone: boolean;
  type: Unit['type'];
}

/** Top-down RTS style camera: pan with WASD, rotate with Q/E, zoom with the wheel. */
export class CommanderCamera {
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.5, 400);
  tx = 32; tz = 32;
  yaw = 0;
  dist = 46;
  readonly pitch = (58 * Math.PI) / 180;
  private ty = 1;

  constructor(team: Team) {
    this.yaw = team === 0 ? 0 : Math.PI;
    this.tz = team === 0 ? 45 : 19;
    this.apply();
  }

  /** Drag-pan by a screen-space delta in pixels (touch). */
  panPx(dx: number, dy: number) {
    const k = this.dist * 0.0017;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    this.tx = Math.max(2, Math.min(MAP_W - 2, this.tx - rx * dx * k + fx * dy * k));
    this.tz = Math.max(2, Math.min(MAP_H - 2, this.tz - rz * dx * k + fz * dy * k));
  }

  zoom(delta: number) { this.dist = Math.max(14, Math.min(72, this.dist * (1 + delta * 0.0012))); }

  update(dt: number, keys: Set<string>) {
    const speed = this.dist * 0.9 * dt;
    let f = 0, r = 0, rot = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
    if (keys.has('KeyQ')) rot -= 1;
    if (keys.has('KeyE')) rot += 1;
    this.yaw += rot * 1.6 * dt;
    // "forward" on screen points from the camera towards the target
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    this.tx += (fx * f + rx * r) * speed;
    this.tz += (fz * f + rz * r) * speed;
    this.tx = Math.max(2, Math.min(MAP_W - 2, this.tx));
    this.tz = Math.max(2, Math.min(MAP_H - 2, this.tz));
    this.apply();
  }

  focus(x: number, z: number) { this.tx = x; this.tz = z; this.apply(); }

  apply() {
    const horiz = Math.cos(this.pitch) * this.dist;
    this.camera.position.set(this.tx + Math.sin(this.yaw) * horiz, this.ty + Math.sin(this.pitch) * this.dist, this.tz + Math.cos(this.yaw) * horiz);
    this.camera.lookAt(this.tx, this.ty, this.tz);
  }
}

export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly effects = new Effects();
  readonly cmd: CommanderCamera;
  readonly fppCam = new THREE.PerspectiveCamera(78, 1, 0.05, 260);
  mode: ViewMode = 'commander';
  selection = new Set<number>();
  /** Possessed unit and its look direction (first-person mode). */
  fppUnitId = -1;
  look = { yaw: 0, pitch: 0 };

  private units = new Map<number, UnitView>();
  private hq: HqView[] = [];
  private cps: CpView[] = [];
  private viewModel: ReturnType<typeof createViewModel> | null = null;
  private viewModelType = '';
  private fppFlashT = 0;
  private recoil = 0;
  private bob = 0;
  private markerPool: { group: THREE.Group; ring: THREE.Mesh; beam: THREE.Mesh }[] = [];
  private lineGeo = new THREE.BufferGeometry();
  private linePos = new Float32Array(80 * 6);
  private lines: THREE.LineSegments;
  private raycaster = new THREE.Raycaster();
  private tmp = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  constructor(readonly canvas: HTMLCanvasElement, readonly battle: Battle, readonly humanTeam: Team) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene.background = new THREE.Color('#a8dcff');
    this.scene.fog = new THREE.Fog('#a8dcff', 90, 190);
    this.scene.add(new THREE.HemisphereLight('#e8f6ff', '#8aa05c', 1.0));
    const sun = new THREE.DirectionalLight('#fff4d6', 1.15);
    sun.position.set(30, 70, 20);
    this.scene.add(sun);

    this.scene.add(buildTerrain(battle.map), buildProps(battle.map), this.effects.group);
    for (const s of battle.structures) {
      const hq = buildHq(s.team, s.x, s.z, battle.map.terrainAt(s.x, s.z));
      this.hq.push(hq);
      this.scene.add(hq.group);
    }
    for (const c of battle.cps) {
      const v = buildControlPoint(c.name, c.x, c.z, c.radius, battle.map.terrainAt(c.x, c.z));
      this.cps.push(v);
      this.scene.add(v.group);
    }
    this.cmd = new CommanderCamera(humanTeam);
    this.scene.add(this.fppCam); // so the viewmodel (a camera child) is rendered

    // order markers: ring + beam, pooled
    for (let i = 0; i < 16; i++) {
      const group = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 32), new THREE.MeshBasicMaterial({ color: '#fff', side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.1;
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.16, 9, 0.16), new THREE.MeshBasicMaterial({ color: '#fff', transparent: true, opacity: 0.55 }));
      beam.position.y = 4.5;
      group.add(ring, beam);
      group.visible = false;
      this.markerPool.push({ group, ring, beam });
      this.scene.add(group);
    }
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lines = new THREE.LineSegments(this.lineGeo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);
    this.resize();
  }

  get camera(): THREE.PerspectiveCamera { return this.mode === 'fpp' ? this.fppCam : this.cmd.camera; }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    for (const c of [this.cmd.camera, this.fppCam]) { c.aspect = w / h; c.updateProjectionMatrix(); }
  }

  dispose() {
    this.renderer.dispose();
  }

  // ----------------------------------------------------------------- events -> effects

  processEvents(events: SimEvent[], audio?: { shot(d: number, mine: boolean): void; hit(): void; death(): void }) {
    const cam = this.camera.position;
    for (const e of events) {
      switch (e.t) {
        case 'shot': {
          const own = e.unitId === this.fppUnitId;
          this.effects.tracer(e.fx, e.fy, e.fz, e.tx, e.ty, e.tz, own ? '#fff3a6' : e.team === 0 ? '#8fc0ff' : '#ffa59f');
          if (e.hit === 'world') this.effects.burst(e.tx, e.ty, e.tz, '#d8cfae', 3, 2.2, 0.1);
          if (e.hit === 'structure') this.effects.burst(e.tx, e.ty, e.tz, '#ffb347', 3, 2.5, 0.12);
          if (own) { this.fppFlashT = 0.05; this.recoil = 1; }
          audio?.shot(Math.hypot(e.fx - cam.x, e.fz - cam.z), own);
          break;
        }
        case 'hit': {
          this.effects.burst(e.x, e.y, e.z, e.head ? '#ffe96b' : '#ff6a5b', e.head ? 9 : 5, 3.2, 0.13);
          audio?.hit();
          break;
        }
        case 'death': {
          const u = this.battle.unitById(e.unitId);
          if (u) this.effects.burst(u.x, u.y + 1.0, u.z, teamHex(u.team), 16, 4.2, 0.18);
          audio?.death();
          break;
        }
        default:
      }
    }
  }

  // ----------------------------------------------------------------- picking

  pickGround(clientX: number, clientY: number): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.cmd.camera);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    const map = this.battle.map;
    // outside the map there is nothing to hit (the camera itself hovers outside the map edge)
    const top = (x: number, z: number) => (x < 0 || z < 0 || x >= MAP_W || z >= MAP_H ? -1 : map.topAt(x, z));
    let prev = 0;
    for (let t = 0; t < 260; t += 0.4) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (y <= top(x, z)) {
        // refine between prev and t
        let lo = prev, hi = t;
        for (let i = 0; i < 8; i++) {
          const m = (lo + hi) / 2;
          if (o.y + d.y * m <= top(o.x + d.x * m, o.z + d.z * m)) hi = m; else lo = m;
        }
        return { x: o.x + d.x * hi, z: o.z + d.z * hi };
      }
      prev = t;
    }
    return null;
  }

  screenPos(x: number, y: number, z: number, camera = this.cmd.camera): { x: number; y: number; ok: boolean } {
    this.tmp.set(x, y, z).project(camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + (this.tmp.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-this.tmp.y * 0.5 + 0.5) * rect.height,
      ok: this.tmp.z > -1 && this.tmp.z < 1,
    };
  }

  /** Friendly, living units whose screen position falls inside the box. */
  unitsInRect(x0: number, y0: number, x1: number, y1: number): number[] {
    const [minX, maxX] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [minY, maxY] = [Math.min(y0, y1), Math.max(y0, y1)];
    const out: number[] = [];
    for (const u of this.battle.units) {
      if (!u.alive || u.team !== this.humanTeam) continue;
      const p = this.screenPos(u.x, u.y + 0.9, u.z);
      if (p.ok && p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) out.push(u.id);
    }
    return out;
  }

  unitAt(clientX: number, clientY: number, ownOnly = true): number | null {
    let best: number | null = null;
    let bd = 26 * 26;
    for (const u of this.battle.units) {
      if (!u.alive) continue;
      if (ownOnly && u.team !== this.humanTeam) continue;
      if (!ownOnly && !this.battle.canSee(this.humanTeam, u)) continue;
      const p = this.screenPos(u.x, u.y + 0.9, u.z);
      if (!p.ok) continue;
      const d = (p.x - clientX) ** 2 + (p.y - clientY) ** 2;
      if (d < bd) { bd = d; best = u.id; }
    }
    return best;
  }

  // ----------------------------------------------------------------- per-frame

  private getView(u: Unit): UnitView {
    let v = this.units.get(u.id);
    if (!v) {
      const model = createUnitModel(u.type, u.team);
      v = { id: u.id, model, phase: Math.random() * 6, y: u.y, fall: 0, gone: false, type: u.type };
      this.units.set(u.id, v);
      this.scene.add(model.root);
    }
    return v;
  }

  private lerpAngle(a: number, b: number, t: number) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  frame(alpha: number, dt: number, now: number) {
    const b = this.battle;
    const fpp = this.mode === 'fpp';
    const cam = this.camera;

    for (const u of b.units) {
      const v = this.getView(u);
      if (v.gone) continue;
      const m = v.model;
      const x = u.px + (u.x - u.px) * alpha, z = u.pz + (u.z - u.pz) * alpha;
      const ty = u.py + (u.y - u.py) * alpha;
      v.y += (ty - v.y) * Math.min(1, dt * (u.controller >= 0 ? 30 : 16));
      if (Math.abs(ty - v.y) > 2) v.y = ty;
      m.root.position.set(x, v.y, z);
      m.root.rotation.y = this.lerpAngle(u.pyaw, u.yaw, alpha);

      const hidden = !u.alive && b.time - u.deadAt > 7;
      const foggedEnemy = !fpp && u.team !== this.humanTeam && !b.canSee(this.humanTeam, u) && u.alive;
      const deadHiddenEnemy = !fpp && u.team !== this.humanTeam && !u.alive && !b.canSee(this.humanTeam, u) && b.time - u.deadAt > 0.5;
      if (hidden) { m.root.visible = false; v.gone = true; this.scene.remove(m.root); continue; }
      m.root.visible = !foggedEnemy && !deadHiddenEnemy;
      if (fpp && u.id === this.fppUnitId) m.root.visible = false; // never draw your own body in first person

      // walking animation
      const moving = u.alive && u.moving;
      if (moving) v.phase += dt * UNIT_DEFS[u.type].speed * 2.3;
      const swing = moving ? Math.sin(v.phase) * 0.75 : 0;
      m.legL.rotation.x += (swing - m.legL.rotation.x) * Math.min(1, dt * 18);
      m.legR.rotation.x += (-swing - m.legR.rotation.x) * Math.min(1, dt * 18);
      m.body.position.y = moving ? Math.abs(Math.sin(v.phase)) * 0.05 : 0;

      // death animation
      if (!u.alive) {
        v.fall = Math.min(1, v.fall + dt * 3.2);
        m.body.rotation.x = -v.fall * (Math.PI / 2) * 0.98;
        m.body.position.y = -v.fall * 0.05;
        m.ring.visible = m.selRing.visible = m.marker.visible = m.bar.visible = false;
        if (b.time - u.deadAt > 5.5) m.root.scale.setScalar(Math.max(0.01, 1 - (b.time - u.deadAt - 5.5) / 1.5));
        continue;
      }
      m.flash.visible = b.time - u.lastShotAt < 0.06 && !(fpp && u.id === this.fppUnitId);

      // overlays (commander readability)
      const sel = this.selection.has(u.id);
      const mine = u.team === this.humanTeam;
      const possessed = u.controller >= 0 && mine;
      m.marker.visible = !fpp;
      m.marker.position.y = (2.75 + Math.sin(now * 0.004 + u.id) * 0.08) * m.scale;
      m.selRing.visible = !fpp && (sel || possessed);
      (m.selRing.material as THREE.MeshBasicMaterial).color.set(possessed ? '#58e6ff' : '#ffe96b');
      m.ring.visible = true;
      const hpFrac = u.hp / u.maxHp;
      m.bar.visible = !fpp && (hpFrac < 0.999 || sel);
      if (m.bar.visible) {
        // billboard: cancel the unit's own yaw so the bar always faces the camera
        this.tmpQ.copy(m.root.quaternion).invert().multiply(cam.quaternion);
        m.bar.quaternion.copy(this.tmpQ);
        m.barFg.scale.x = Math.max(0.001, 1.04 * hpFrac);
        m.barFg.position.x = -(1.04 * (1 - hpFrac)) / 2;
        (m.barFg.material as THREE.MeshBasicMaterial).color.set(hpFrac > 0.55 ? '#59d36b' : hpFrac > 0.28 ? '#f2c94c' : '#ef5350');
      }
    }

    // headquarters and control points
    for (const s of b.structures) {
      const hv = this.hq[s.team];
      hv.setHp(s.hp / s.maxHp, s.alive);
      hv.bar.quaternion.copy(cam.quaternion);
      hv.flag.rotation.y = Math.sin(now * 0.004 + s.team) * 0.25;
    }
    for (const c of b.cps) this.cps[c.id].update(c.progress, c.owner, c.contested, now / 1000);

    this.updateMarkers(now);
    this.effects.update(dt);

    if (fpp) this.updateFpp(dt, alpha);
    this.renderer.render(this.scene, cam);
  }

  private updateFpp(dt: number, alpha: number) {
    const u = this.battle.unitById(this.fppUnitId);
    const v = u ? this.units.get(u.id) : undefined;
    if (!u || !v) return;
    const def = UNIT_DEFS[u.type];
    if (this.viewModelType !== u.type) {
      if (this.viewModel) this.fppCam.remove(this.viewModel.group);
      this.viewModel = createViewModel(u.type);
      this.viewModelType = u.type;
      this.fppCam.add(this.viewModel.group);
    }
    const moving = u.moving && u.alive;
    this.bob += moving ? dt * def.speed * 2.6 : 0;
    const bobY = moving ? Math.sin(this.bob * 2) * 0.025 : 0;
    this.fppCam.position.set(
      u.px + (u.x - u.px) * alpha, v.y + (u.alive ? 1.55 * def.scale + bobY : 0.4), u.pz + (u.z - u.pz) * alpha,
    );
    this.fppCam.rotation.order = 'YXZ';
    this.fppCam.rotation.set(this.look.pitch + this.recoil * 0.012, this.look.yaw, 0);
    this.recoil = Math.max(0, this.recoil - dt * 12);
    this.fppFlashT = Math.max(0, this.fppFlashT - dt);
    if (this.viewModel) {
      this.viewModel.flash.visible = this.fppFlashT > 0;
      this.viewModel.group.position.set(0.26, -0.24 + bobY * 0.6, -0.5 + this.recoil * 0.05);
      this.viewModel.group.rotation.x = this.recoil * 0.08;
      this.viewModel.group.visible = u.alive && u.reloadT <= 0;
      if (u.reloadT > 0 && u.alive) { // tip the weapon down while reloading
        this.viewModel.group.visible = true;
        this.viewModel.group.rotation.x = -0.9;
        this.viewModel.group.position.y = -0.4;
      }
    }
  }

  /** Order lines + target markers for the selection (commander) or for the possessed unit (first person). */
  private updateMarkers(now: number) {
    const b = this.battle;
    const fpp = this.mode === 'fpp';
    const ids = fpp ? [this.fppUnitId] : [...this.selection];
    let lineN = 0, mi = 0;
    const seen = new Set<string>();
    for (const id of ids) {
      const u = b.unitById(id);
      if (!u || !u.alive || !u.order || u.order.type === 'hold') continue;
      const o = u.order;
      const col = ORDER_COLORS[o.type];
      const key = `${o.type}|${Math.round(o.x)}|${Math.round(o.z)}`;
      if (!fpp && lineN < 80) {
        const i = lineN * 6;
        this.linePos[i] = u.x; this.linePos[i + 1] = u.y + 0.4; this.linePos[i + 2] = u.z;
        this.linePos[i + 3] = o.x; this.linePos[i + 4] = b.map.terrainAt(o.x, o.z) + 0.4; this.linePos[i + 5] = o.z;
        lineN++;
      }
      if (seen.has(key) || mi >= this.markerPool.length) continue;
      seen.add(key);
      const mk = this.markerPool[mi++];
      mk.group.visible = true;
      mk.group.position.set(o.x, b.map.terrainAt(o.x, o.z), o.z);
      const r = Math.max(1.2, o.radius);
      mk.ring.scale.setScalar(r * (1 + Math.sin(now * 0.006) * 0.03));
      (mk.ring.material as THREE.MeshBasicMaterial).color.set(col);
      (mk.beam.material as THREE.MeshBasicMaterial).color.set(col);
      mk.beam.visible = fpp;
    }
    for (; mi < this.markerPool.length; mi++) this.markerPool[mi].group.visible = false;
    this.lineGeo.setDrawRange(0, lineN * 2);
    this.lineGeo.attributes.position.needsUpdate = true;
  }
}
