import * as THREE from 'three';

/** Tiny helper for building one merged, vertex-coloured mesh out of quads and boxes. */
export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];

  quad(
    a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number],
    n: [number, number, number], color: THREE.Color, shade = 1,
  ) {
    const r = color.r * shade, g = color.g * shade, bl = color.b * shade;
    for (const p of [a, b, c, a, c, d]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
      this.colors.push(r, g, bl);
    }
  }

  /** Axis-aligned box. `top`/`side` colours let blocks have a distinct lid. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, top: THREE.Color, side: THREE.Color = top, bottom = false) {
    // +Y (top)
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], top, 1);
    // +Z
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], side, 0.94);
    // -Z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], side, 0.94);
    // +X
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], side, 0.86);
    // -X
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], side, 0.86);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], side, 0.6);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Deterministic hash noise in [0,1) so colour variation is stable between runs. */
export function hash2(x: number, z: number, salt = 0): number {
  let h = (x * 374761393 + z * 668265263 + salt * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return ((h >>> 0) % 10000) / 10000;
}

export const hex = (c: string) => new THREE.Color(c);
export function tint(c: THREE.Color, amount: number): THREE.Color {
  // amount in roughly [-0.1, 0.1]: lighten / darken
  return c.clone().multiplyScalar(1 + amount);
}
