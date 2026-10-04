import * as THREE from 'three';
import { G, GameMap, MAP_H, MAP_W, OB } from '../sim/map';
import { MeshBuilder, hash2, hex, tint } from './mesh';

const GROUND_COLORS: Record<number, THREE.Color> = {
  [G.grass]: hex('#86c94b'),
  [G.road]: hex('#dcc791'),
  [G.sand]: hex('#efdca3'),
  [G.stone]: hex('#bcc2ca'),
  [G.bluePad]: hex('#93b9ea'),
  [G.redPad]: hex('#eaa49d'),
};
const DIRT = hex('#a07f54');
const DIRT_DEEP = hex('#7e6240');

const PROP = {
  wall: hex('#e9dcbd'), wallTop: hex('#cdbc98'),
  cover: hex('#cdb27a'), coverTop: hex('#dcc48c'),
  crate: hex('#b27a3c'), crateTop: hex('#c98f4d'),
  rock: hex('#9ca2a8'), rockTop: hex('#b4bac0'),
  trunk: hex('#8a5a32'), leaf: hex('#3f9d45'), leaf2: hex('#58b84e'),
};

/** Whole terrain as one mesh: top faces plus only the side faces that are actually visible. */
export function buildTerrain(map: GameMap): THREE.Mesh {
  const mb = new MeshBuilder();
  const BOTTOM = -2;
  for (let z = 0; z < MAP_H; z++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = map.idx(x, z);
      const h = map.heights[i];
      const base = GROUND_COLORS[map.ground[i]] ?? GROUND_COLORS[G.grass];
      const top = tint(base, (hash2(x, z) - 0.5) * 0.12 + h * 0.025);
      mb.quad([x, h, z + 1], [x + 1, h, z + 1], [x + 1, h, z], [x, h, z], [0, 1, 0], top, 1);
      // side faces towards lower neighbours (or the world edge)
      const nb: [number, number, number, number, number, number, number][] = [
        // dx, dz, then quad corners handled below
        [0, 1, 0, 0, 0, 0, 0], [0, -1, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0], [-1, 0, 0, 0, 0, 0, 0],
      ];
      for (const [dx, dz] of nb) {
        const nx = x + dx, nz = z + dz;
        const nh = map.inBounds(nx, nz) ? map.heights[map.idx(nx, nz)] : BOTTOM;
        if (nh >= h) continue;
        const dirt = tint(h - nh > 1 || !map.inBounds(nx, nz) ? DIRT_DEEP : DIRT, (hash2(x, z, 3) - 0.5) * 0.1);
        if (dz === 1) mb.quad([x, nh, z + 1], [x + 1, nh, z + 1], [x + 1, h, z + 1], [x, h, z + 1], [0, 0, 1], dirt, 0.94);
        else if (dz === -1) mb.quad([x + 1, nh, z], [x, nh, z], [x, h, z], [x + 1, h, z], [0, 0, -1], dirt, 0.94);
        else if (dx === 1) mb.quad([x + 1, nh, z + 1], [x + 1, nh, z], [x + 1, h, z], [x + 1, h, z + 1], [1, 0, 0], dirt, 0.86);
        else mb.quad([x, nh, z], [x, nh, z + 1], [x, h, z + 1], [x, h, z], [-1, 0, 0], dirt, 0.86);
      }
    }
  }
  const mesh = new THREE.Mesh(mb.build(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'terrain';
  return mesh;
}

/** Walls, cover, rocks and trees as one merged mesh (the HQ is built separately because it changes). */
export function buildProps(map: GameMap): THREE.Mesh {
  const mb = new MeshBuilder();
  for (let z = 0; z < MAP_H; z++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = map.idx(x, z);
      const oh = map.obsH[i];
      if (oh <= 0) continue;
      const kind = map.obsKind[i];
      if (kind === OB.hq) continue;
      const h = map.heights[i];
      const n = (hash2(x, z, 9) - 0.5) * 0.1;
      switch (kind) {
        case OB.wall: {
          // a stone course pattern: darker band every other block of height
          mb.box(x, h, z, x + 1, h + oh, z + 1, tint(PROP.wallTop, n), tint(PROP.wall, n));
          mb.box(x - 0.02, h + oh * 0.66, z - 0.02, x + 1.02, h + oh * 0.7, z + 1.02, tint(PROP.wallTop, n - 0.08), tint(PROP.wallTop, n - 0.08));
          break;
        }
        case OB.cover:
          mb.box(x + 0.05, h, z + 0.1, x + 0.95, h + oh, z + 0.9, tint(PROP.coverTop, n), tint(PROP.cover, n));
          break;
        case OB.crate:
          mb.box(x + 0.08, h, z + 0.08, x + 0.92, h + oh, z + 0.92, tint(PROP.crateTop, n), tint(PROP.crate, n));
          break;
        case OB.rock:
          mb.box(x + 0.05, h, z + 0.05, x + 0.95, h + oh * 0.7, z + 0.95, tint(PROP.rockTop, n), tint(PROP.rock, n));
          mb.box(x + 0.2, h + oh * 0.7, z + 0.2, x + 0.8, h + oh, z + 0.8, tint(PROP.rockTop, n + 0.04), tint(PROP.rock, n + 0.04));
          break;
        case OB.tree: {
          mb.box(x + 0.35, h, z + 0.35, x + 0.65, h + oh * 0.55, z + 0.65, PROP.trunk, PROP.trunk);
          const leaf = hash2(x, z, 4) > 0.5 ? PROP.leaf : PROP.leaf2;
          mb.box(x - 0.25, h + oh * 0.5, z - 0.25, x + 1.25, h + oh * 0.5 + 1.0, z + 1.25, tint(leaf, 0.06), leaf);
          mb.box(x + 0.05, h + oh * 0.5 + 1.0, z + 0.05, x + 0.95, h + oh * 0.5 + 1.7, z + 0.95, tint(leaf, 0.12), tint(leaf, 0.03));
          break;
        }
        default:
          mb.box(x, h, z, x + 1, h + oh, z + 1, PROP.rockTop, PROP.rock);
      }
    }
  }
  const mesh = new THREE.Mesh(mb.build(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'props';
  return mesh;
}

export interface HqView {
  group: THREE.Group;
  roof: THREE.Mesh;
  flag: THREE.Mesh;
  bar: THREE.Group;
  barFg: THREE.Mesh;
  setHp(frac: number, alive: boolean): void;
}

const teamColor = (team: number) => (team === 0 ? hex('#3f7be0') : hex('#e0453f'));

/** Headquarters: a chunky voxel building with a banner and a health bar. */
export function buildHq(team: 0 | 1, cx: number, cz: number, groundY: number): HqView {
  const group = new THREE.Group();
  group.position.set(cx, groundY, cz);
  const body = new THREE.Mesh(new THREE.BoxGeometry(4, 2.6, 4), new THREE.MeshLambertMaterial({ color: team === 0 ? '#dbe6f7' : '#f7dedb' }));
  body.position.y = 1.3;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.6, 4.5), new THREE.MeshLambertMaterial({ color: teamColor(team) }));
  roof.position.y = 2.9;
  const tower = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 1.4), new THREE.MeshLambertMaterial({ color: '#c9c2b0' }));
  tower.position.y = 3.8;
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.2, 0.12), new THREE.MeshLambertMaterial({ color: '#555' }));
  pole.position.set(0, 5.5, 0);
  const flag = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.08), new THREE.MeshLambertMaterial({ color: teamColor(team) }));
  flag.position.set(0.6, 6.2, 0);
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.5, 0.12), new THREE.MeshLambertMaterial({ color: '#6b4a2b' }));
  const dir = team === 0 ? -1 : 1; // door faces the enemy
  door.position.set(0, 0.75, dir * 2.02);
  group.add(body, roof, tower, pole, flag, door);
  for (const wx of [-1.2, 1.2]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.12), new THREE.MeshLambertMaterial({ color: '#ffe9a3', emissive: '#6b5a20' }));
    win.position.set(wx, 1.6, dir * 2.02);
    group.add(win);
  }
  // health bar (billboarded by the view each frame)
  const bar = new THREE.Group();
  bar.position.y = 8;
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(5, 0.55), new THREE.MeshBasicMaterial({ color: '#1b1f2a', transparent: true, opacity: 0.8, depthTest: false }));
  const barFg = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 0.35), new THREE.MeshBasicMaterial({ color: teamColor(team), depthTest: false, transparent: true }));
  barFg.position.z = 0.01;
  bg.renderOrder = 10; barFg.renderOrder = 11;
  bar.add(bg, barFg);
  group.add(bar);
  return {
    group, roof, flag, bar, barFg,
    setHp(frac, alive) {
      barFg.scale.x = Math.max(0.001, frac);
      barFg.position.x = -(4.8 * (1 - frac)) / 2;
      if (!alive) {
        (roof.material as THREE.MeshLambertMaterial).color.set('#555');
        (body.material as THREE.MeshLambertMaterial).color.set('#6a6a6a');
        flag.visible = false;
        group.position.y = groundY - 1.0;
        bar.visible = false;
      }
    },
  };
}

export interface CpView {
  group: THREE.Group;
  update(progress: number, owner: -1 | 0 | 1, contested: boolean, time: number): void;
}

function letterSprite(letter: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(20,24,34,0.82)';
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
  g.lineWidth = 6; g.strokeStyle = '#fff'; g.stroke();
  g.fillStyle = '#fff'; g.font = 'bold 76px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(letter, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(2.6, 2.6, 1);
  s.renderOrder = 12;
  return s;
}

export function buildControlPoint(name: string, x: number, z: number, radius: number, groundY: number): CpView {
  const group = new THREE.Group();
  group.position.set(x, groundY + 0.06, z);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.18, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2;
  const edge = new THREE.Mesh(new THREE.RingGeometry(radius - 0.18, radius, 48), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false }));
  edge.rotation.x = -Math.PI / 2; edge.position.y = 0.01;
  group.add(disc, edge);
  let arc = new THREE.Mesh(new THREE.RingGeometry(radius - 0.75, radius - 0.3, 48, 1, 0, 0.001), new THREE.MeshBasicMaterial({ color: '#fff', side: THREE.DoubleSide, depthWrite: false }));
  arc.rotation.x = -Math.PI / 2; arc.position.y = 0.02;
  group.add(arc);
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.14, 5, 0.14), new THREE.MeshLambertMaterial({ color: '#444' }));
  pole.position.y = 2.5;
  const flag = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 0.08), new THREE.MeshLambertMaterial({ color: '#ffffff' }));
  flag.position.set(0.75, 4.5, 0);
  group.add(pole, flag);
  const label = letterSprite(name);
  label.position.y = 6.4;
  group.add(label);

  let lastLen = 0, lastColor = '';
  return {
    group,
    update(progress, owner, contested, time) {
      const col = owner === 0 ? '#3f7be0' : owner === 1 ? '#e0453f' : '#f2f2f2';
      (edge.material as THREE.MeshBasicMaterial).color.set(col);
      (disc.material as THREE.MeshBasicMaterial).color.set(col);
      (disc.material as THREE.MeshBasicMaterial).opacity = contested ? 0.22 + 0.12 * Math.sin(time * 8) : 0.18;
      const target = progress === 0 ? 0 : progress > 0 ? '#3f7be0' : '#e0453f';
      const len = Math.abs(progress) * Math.PI * 2;
      const c = target === 0 ? '#fff' : (target as string);
      if (Math.abs(len - lastLen) > 0.02 || c !== lastColor) {
        arc.geometry.dispose();
        arc.geometry = new THREE.RingGeometry(radius - 0.75, radius - 0.3, 48, 1, 0, Math.max(0.001, len));
        (arc.material as THREE.MeshBasicMaterial).color.set(c);
        lastLen = len; lastColor = c;
      }
      (flag.material as THREE.MeshLambertMaterial).color.set(col);
      flag.position.y = 1.2 + 3.3 * (owner === -1 ? 0.5 + progress * 0.5 : 1);
    },
  };
}
