import { Vec3, cross, norm } from "./geo-math";

// Minimal quaternion kit for the globe camera. q maps world space into
// view space: +x screen right, +y screen up, +z toward the viewer.

export type Quat = [number, number, number, number]; // x,y,z,w

export const QID: Quat = [0, 0, 0, 1];

export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotate a world-space vector into view space. */
export function qRot(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [x, y, z] = v;
  // v + 2*cross(q.xyz, cross(q.xyz, v) + w*v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

export function qAxis(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

export function qNorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Shortest-path interpolation between orientations. */
export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  if (d < 0) d = -d;
  if (d > 0.9995) return qNorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(Math.min(1, d));
  const sa = Math.sin((1 - t) * th) / Math.sin(th);
  const sb = Math.sin(t * th) / Math.sin(th);
  return [a[0] * sa + bb[0] * sb, a[1] * sa + bb[1] * sb, a[2] * sa + bb[2] * sb, a[3] * sa + bb[3] * sb];
}

/** Quaternion from a rotation matrix given as its view-space rows. */
export function qFromRows(eR: Vec3, eU: Vec3, eV: Vec3): Quat {
  const m00 = eR[0], m01 = eR[1], m02 = eR[2];
  const m10 = eU[0], m11 = eU[1], m12 = eU[2];
  const m20 = eV[0], m21 = eV[1], m22 = eV[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return qNorm(q);
}

/**
 * Orientation that puts world direction `facing` front-and-center
 * (viewer-facing), with `upHint` projected onto screen-up as the roll.
 */
export function qLookAt(facing: Vec3, upHint: Vec3): Quat {
  const eV = norm(facing);
  let eR = cross(upHint, eV);
  if (Math.hypot(eR[0], eR[1], eR[2]) < 1e-6) {
    // up hint parallel to facing — pick any perpendicular
    const ref: Vec3 = Math.abs(eV[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    eR = cross(ref, eV);
  }
  eR = norm(eR);
  const eU = cross(eV, eR);
  return qFromRows(eR, eU, eV);
}

/** The world direction currently facing the viewer. */
export function qForward(q: Quat): Vec3 {
  // inverse(q) rotates view +z back into world space
  const inv: Quat = [-q[0], -q[1], -q[2], q[3]];
  return qRot(inv, [0, 0, 1]);
}

/** The world direction currently at screen-up. */
export function qUp(q: Quat): Vec3 {
  const inv: Quat = [-q[0], -q[1], -q[2], q[3]];
  return qRot(inv, [0, 1, 0]);
}
