import * as THREE from 'three';
import { UNIT_DEFS } from '../sim/units';
import type { Team, UnitTypeId } from '../sim/types';

const geo = {
  box: new THREE.BoxGeometry(1, 1, 1),
  ring: new THREE.RingGeometry(0.62, 0.86, 24),
  selRing: new THREE.RingGeometry(0.98, 1.16, 28),
  cone: new THREE.ConeGeometry(0.3, 0.6, 4),
  plane: new THREE.PlaneGeometry(1, 1),
};
const matCache = new Map<string, THREE.MeshLambertMaterial>();
const lam = (color: string) => {
  let m = matCache.get(color);
  if (!m) { m = new THREE.MeshLambertMaterial({ color }); matCache.set(color, m); }
  return m;
};

const TEAM_MAIN = ['#3f7be0', '#e0453f'];
const TEAM_DARK = ['#2a56a6', '#a8312c'];
const TEAM_LIGHT = ['#8db4f2', '#f2938f'];
export const teamHex = (t: Team) => TEAM_MAIN[t];

function part(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, color: string): THREE.Mesh {
  const m = new THREE.Mesh(geo.box, lam(color));
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

export interface UnitModel {
  root: THREE.Group; // positioned at the unit's feet, rotated by yaw
  body: THREE.Group; // everything that falls over on death
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  gun: THREE.Group;
  flash: THREE.Mesh;
  ring: THREE.Mesh;
  selRing: THREE.Mesh;
  marker: THREE.Mesh; // cone above the head - makes units readable from the commander view
  bar: THREE.Group;
  barFg: THREE.Mesh;
  scale: number;
}

export function createUnitModel(type: UnitTypeId, team: Team): UnitModel {
  const def = UNIT_DEFS[type];
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const skin = '#f1c9a0';
  const pants = '#3d4252';
  const main = TEAM_MAIN[team], dark = TEAM_DARK[team], light = TEAM_LIGHT[team];
  const heavy = type === 'heavy', scout = type === 'scout', ranged = type === 'ranged';
  const tw = heavy ? 0.82 : scout ? 0.52 : 0.62; // torso width
  const armX = tw / 2 + 0.12;

  const legL = new THREE.Group(), legR = new THREE.Group();
  legL.position.set(-0.17, 0.72, 0); legR.position.set(0.17, 0.72, 0);
  part(legL, 0.28, 0.72, 0.3, 0, -0.36, 0, pants);
  part(legR, 0.28, 0.72, 0.3, 0, -0.36, 0, pants);
  part(legL, 0.3, 0.16, 0.36, 0, -0.66, -0.02, '#2a2d38');
  part(legR, 0.3, 0.16, 0.36, 0, -0.66, -0.02, '#2a2d38');
  body.add(legL, legR);

  part(body, tw, 0.72, 0.38, 0, 1.08, 0, main);
  part(body, tw + 0.02, 0.14, 0.4, 0, 0.78, 0, dark); // belt
  if (heavy) {
    part(body, 0.36, 0.22, 0.5, -0.5, 1.46, 0, '#6e7683');
    part(body, 0.36, 0.22, 0.5, 0.5, 1.46, 0, '#6e7683');
    part(body, 0.5, 0.4, 0.06, 0, 1.12, -0.22, '#8a93a1'); // chest plate
  }
  if (scout) part(body, tw + 0.04, 0.16, 0.42, 0, 1.4, 0, light); // scarf
  if (ranged) part(body, 0.34, 0.5, 0.2, 0, 1.12, 0.28, '#6b5a3a'); // backpack

  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-armX, 1.4, 0); armR.position.set(armX, 1.4, 0);
  part(armL, 0.2, 0.66, 0.22, 0, -0.33, 0, main);
  part(armR, 0.2, 0.66, 0.22, 0, -0.33, 0, main);
  part(armL, 0.2, 0.16, 0.22, 0, -0.74, 0, skin);
  part(armR, 0.2, 0.16, 0.22, 0, -0.74, 0, skin);
  body.add(armL, armR);

  part(body, 0.42, 0.42, 0.42, 0, 1.64, 0, skin);
  part(body, 0.05, 0.06, 0.02, -0.1, 1.67, -0.215, '#222');
  part(body, 0.05, 0.06, 0.02, 0.1, 1.67, -0.215, '#222');
  // helmet / cap by role
  if (heavy) { part(body, 0.52, 0.26, 0.52, 0, 1.92, 0, '#7b8492'); part(body, 0.14, 0.12, 0.54, 0, 2.08, 0, dark); }
  else if (scout) { part(body, 0.46, 0.14, 0.46, 0, 1.9, 0, light); part(body, 0.46, 0.06, 0.2, 0, 1.86, -0.3, main); }
  else if (ranged) { part(body, 0.5, 0.2, 0.5, 0, 1.92, 0, '#5b6a3c'); part(body, 0.5, 0.08, 0.5, 0, 1.84, 0, '#4a5632'); }
  else { part(body, 0.48, 0.2, 0.48, 0, 1.92, 0, dark); }

  // weapon carried in the right hand, pointing forward (-Z)
  const gun = new THREE.Group();
  gun.position.set(armX, 1.0, -0.2);
  const len = ranged ? 1.1 : heavy ? 0.8 : scout ? 0.5 : 0.7;
  part(gun, 0.11, 0.14, len, 0, 0, -len / 2 + 0.1, '#2b2f3a');
  part(gun, 0.09, 0.08, 0.18, 0, -0.1, 0.0, '#4a3a2a');
  if (ranged) part(gun, 0.1, 0.1, 0.22, 0, 0.1, -0.2, '#1c1f27'); // scope
  body.add(gun);
  armR.rotation.x = -1.15; // aiming pose
  armL.rotation.x = -0.9;
  armL.position.z = -0.1;

  const flash = new THREE.Mesh(geo.box, new THREE.MeshBasicMaterial({ color: '#ffe07a' }));
  flash.scale.set(0.24, 0.24, 0.3);
  flash.position.set(armX, 1.0, -0.2 - len - 0.1);
  flash.visible = false;
  body.add(flash);

  const ring = new THREE.Mesh(geo.ring, new THREE.MeshBasicMaterial({ color: main, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06;
  const selRing = new THREE.Mesh(geo.selRing, new THREE.MeshBasicMaterial({ color: '#ffe96b', side: THREE.DoubleSide, depthWrite: false }));
  selRing.rotation.x = -Math.PI / 2; selRing.position.y = 0.08; selRing.visible = false;
  root.add(ring, selRing);

  const marker = new THREE.Mesh(geo.cone, new THREE.MeshBasicMaterial({ color: main }));
  marker.rotation.x = Math.PI; // point down
  marker.position.y = 2.75;
  root.add(marker);

  const bar = new THREE.Group();
  bar.position.y = 3.35;
  const bg = new THREE.Mesh(geo.plane, new THREE.MeshBasicMaterial({ color: '#10131c', transparent: true, opacity: 0.75, depthTest: false }));
  bg.scale.set(1.1, 0.15, 1);
  const barFg = new THREE.Mesh(geo.plane, new THREE.MeshBasicMaterial({ color: '#59d36b', depthTest: false, transparent: true }));
  barFg.scale.set(1.04, 0.09, 1); barFg.position.z = 0.01;
  bg.renderOrder = 10; barFg.renderOrder = 11;
  bar.add(bg, barFg);
  root.add(bar);

  const s = def.scale;
  body.scale.setScalar(s);
  ring.scale.setScalar(s);
  selRing.scale.setScalar(s);
  marker.position.y = 2.75 * s;
  bar.position.y = 3.35 * s;
  return { root, body, legL, legR, armL, armR, gun, flash, ring, selRing, marker, bar, barFg, scale: s };
}

/** Viewmodel gun shown in first person, parented to the camera. */
export function createViewModel(type: UnitTypeId): { group: THREE.Group; flash: THREE.Mesh } {
  const g = new THREE.Group();
  const len = type === 'ranged' ? 0.95 : type === 'heavy' ? 0.7 : type === 'scout' ? 0.45 : 0.6;
  const matDark = lam('#2b2f3a');
  const barrel = new THREE.Mesh(geo.box, matDark); barrel.scale.set(0.09, 0.1, len); barrel.position.set(0, 0, -len / 2);
  const stock = new THREE.Mesh(geo.box, lam('#6b4a2b')); stock.scale.set(0.1, 0.16, 0.28); stock.position.set(0, -0.04, 0.06);
  const grip = new THREE.Mesh(geo.box, lam('#3a2c1f')); grip.scale.set(0.08, 0.2, 0.09); grip.position.set(0, -0.14, -0.04);
  const hand = new THREE.Mesh(geo.box, lam('#f1c9a0')); hand.scale.set(0.12, 0.12, 0.14); hand.position.set(0, -0.18, -0.04);
  g.add(barrel, stock, grip, hand);
  if (type === 'ranged') { const sc = new THREE.Mesh(geo.box, matDark); sc.scale.set(0.07, 0.07, 0.24); sc.position.set(0, 0.08, -0.3); g.add(sc); }
  const flash = new THREE.Mesh(geo.box, new THREE.MeshBasicMaterial({ color: '#ffe07a' }));
  flash.scale.set(0.16, 0.16, 0.2); flash.position.set(0, 0, -len - 0.08); flash.visible = false;
  g.add(flash);
  g.position.set(0.26, -0.24, -0.5);
  g.traverse((o) => { o.renderOrder = 20; const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.depthTest = true; });
  return { group: g, flash };
}
