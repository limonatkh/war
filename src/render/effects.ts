import * as THREE from 'three';

/** Pooled tracer streaks, spark cubes and rising markers. No allocation per shot. */
export class Effects {
  readonly group = new THREE.Group();
  private tracers: { a: THREE.Vector3; dir: THREE.Vector3; len: number; age: number; life: number; color: THREE.Color; live: boolean }[] = [];
  private tracerGeo = new THREE.BufferGeometry();
  private tracerPos: Float32Array;
  private tracerCol: Float32Array;
  private tracerLines: THREE.LineSegments;
  private sparks: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; max: number }[] = [];
  private readonly MAXT = 64;

  constructor() {
    this.tracerPos = new Float32Array(this.MAXT * 6);
    this.tracerCol = new Float32Array(this.MAXT * 6);
    for (let i = 0; i < this.MAXT; i++) this.tracers.push({ a: new THREE.Vector3(), dir: new THREE.Vector3(), len: 0, age: 0, life: 0, color: new THREE.Color(), live: false });
    this.tracerGeo.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3));
    this.tracerGeo.setAttribute('color', new THREE.BufferAttribute(this.tracerCol, 3));
    this.tracerLines = new THREE.LineSegments(this.tracerGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.tracerLines.frustumCulled = false;
    this.group.add(this.tracerLines);

    const cube = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(cube, new THREE.MeshBasicMaterial({ color: '#fff' }));
      m.visible = false;
      this.group.add(m);
      this.sparks.push({ mesh: m, vel: new THREE.Vector3(), life: 0, max: 1 });
    }
  }

  tracer(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, color: string) {
    const t = this.tracers.find((x) => !x.live) ?? this.tracers[0];
    t.a.set(fx, fy, fz);
    t.dir.set(tx - fx, ty - fy, tz - fz);
    t.len = t.dir.length();
    if (t.len < 0.001) return;
    t.dir.divideScalar(t.len);
    t.age = 0; t.life = 0.09; t.live = true;
    t.color.set(color);
  }

  burst(x: number, y: number, z: number, color: string, count: number, power = 3, size = 0.12) {
    let n = 0;
    for (const s of this.sparks) {
      if (s.life > 0) continue;
      s.life = s.max = 0.35 + Math.random() * 0.3;
      s.mesh.visible = true;
      s.mesh.position.set(x, y, z);
      s.mesh.scale.setScalar(size * (0.6 + Math.random() * 0.8));
      (s.mesh.material as THREE.MeshBasicMaterial).color.set(color);
      s.vel.set((Math.random() - 0.5) * power, Math.random() * power * 0.9 + 0.5, (Math.random() - 0.5) * power);
      if (++n >= count) break;
    }
  }

  update(dt: number) {
    let k = 0;
    for (const t of this.tracers) {
      if (!t.live) continue;
      t.age += dt;
      if (t.age >= t.life) { t.live = false; continue; }
      const f = t.age / t.life;
      const headD = Math.min(t.len, t.len * (0.25 + f * 0.9));
      const tailD = Math.max(0, headD - Math.min(3.2, t.len));
      const i = k * 6;
      this.tracerPos[i] = t.a.x + t.dir.x * tailD; this.tracerPos[i + 1] = t.a.y + t.dir.y * tailD; this.tracerPos[i + 2] = t.a.z + t.dir.z * tailD;
      this.tracerPos[i + 3] = t.a.x + t.dir.x * headD; this.tracerPos[i + 4] = t.a.y + t.dir.y * headD; this.tracerPos[i + 5] = t.a.z + t.dir.z * headD;
      const fade = 1 - f * 0.6;
      this.tracerCol[i] = t.color.r * 0.3 * fade; this.tracerCol[i + 1] = t.color.g * 0.3 * fade; this.tracerCol[i + 2] = t.color.b * 0.3 * fade;
      this.tracerCol[i + 3] = t.color.r * fade; this.tracerCol[i + 4] = t.color.g * fade; this.tracerCol[i + 5] = t.color.b * fade;
      k++;
    }
    this.tracerGeo.setDrawRange(0, k * 2);
    this.tracerGeo.attributes.position.needsUpdate = true;
    this.tracerGeo.attributes.color.needsUpdate = true;

    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.mesh.visible = false; continue; }
      s.vel.y -= 9 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.scale.multiplyScalar(1 - dt * 1.2);
    }
  }
}
