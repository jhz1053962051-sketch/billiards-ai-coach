// 平面几何工具。台球是纯 2D 问题，不需要任何向量库。

export const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  mul: (a, k) => ({ x: a.x * k, y: a.y * k }),
  len: (a) => Math.hypot(a.x, a.y),
  dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  norm: (a) => {
    const l = Math.hypot(a.x, a.y) || 1;
    return { x: a.x / l, y: a.y / l };
  },
  dot: (a, b) => a.x * b.x + a.y * b.y,
  cross: (a, b) => a.x * b.y - a.y * b.x,
  /** 逆时针旋转 90° */
  perp: (a) => ({ x: -a.y, y: a.x }),
  angle: (a) => Math.atan2(a.y, a.x),
  fromAngle: (r, a) => ({ x: Math.cos(a) * r, y: Math.sin(a) * r }),
};

export const DEG = 180 / Math.PI;

/**
 * 点到线段的最短距离。
 * @param {{x:number,y:number}} p
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 */
export function pointSegmentDistance(p, a, b) {
  const ab = V.sub(b, a);
  const ap = V.sub(p, a);
  const denom = V.dot(ab, ab);
  if (denom < 1e-12) return V.dist(p, a);
  let t = V.dot(ap, ab) / denom;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const closest = V.add(a, V.mul(ab, t));
  return V.dist(p, closest);
}
