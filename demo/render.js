// 两个演示页共用的绘制层：球桌、袋口、球。
//
// 为什么单独一个模块：练习页和球局页必须画得一模一样，
// 否则同一颗球在两边颜色不同、同一张桌在两边袋口不同，会让人怀疑哪边算错了。
//
// 拟真度的取舍：这是俯视 2D，不追求照片级。真正影响"看起来像台球桌"的是四件事，
// 按性价比排序：
//   1. 木框有纹理而不是一块纯色 —— 大面积的纯色是最强的"这是示意图"信号；
//   2. 袋口有深度（黑心 + 内圈 + 高光弧），而不是一个黑圆点；
//   3. 球有高光和接触阴影，条纹球是"白球加一条色带"而不是半个色块；
//   4. 库边有内阴影，让人看出台呢是凹进去的。
// 这四件都不增加依赖，全是 Canvas 2D 原生路径。

import { ballStyle } from '../src/rack.js';

export function interpolateBallStates(from, to, amount) {
  const t = Math.max(0, Math.min(1, amount));
  if (!Array.isArray(from) || !Array.isArray(to)) return [];
  return from.map((ball, index) => {
    const next = to[index] ?? ball;
    if (ball.pocketed || next.pocketed) return ball;
    const rollDirX = (ball.rollDirX ?? 0) + ((next.rollDirX ?? ball.rollDirX ?? 0) - (ball.rollDirX ?? 0)) * t;
    const rollDirY = (ball.rollDirY ?? 0) + ((next.rollDirY ?? ball.rollDirY ?? 0) - (ball.rollDirY ?? 0)) * t;
    const rollDirLength = Math.hypot(rollDirX, rollDirY);
    return {
      ...ball,
      x: ball.x + (next.x - ball.x) * t,
      y: ball.y + (next.y - ball.y) * t,
      rollAngle: (ball.rollAngle ?? 0) + ((next.rollAngle ?? ball.rollAngle ?? 0) - (ball.rollAngle ?? 0)) * t,
      rollDirX: rollDirLength > 1e-9 ? rollDirX / rollDirLength : 0,
      rollDirY: rollDirLength > 1e-9 ? rollDirY / rollDirLength : 0,
    };
  });
}

export function sampleDampedCamera(from, to, velocity, elapsed, frequency = 13.5) {
  const t = Math.max(0, elapsed);
  const offset = from - to;
  const impulse = velocity + frequency * offset;
  const decay = Math.exp(-frequency * t);
  const value = to + (offset + impulse * t) * decay;
  const speed = (impulse - frequency * (offset + impulse * t)) * decay;
  return { value, velocity: speed };
}

/** 木框在台面外占的宽度（米）。0.13 m 接近真实台球桌的框宽。 */
export const FRAME_MARGIN = 0.13;

/** 确定性伪随机：同一张桌每次重绘的纹理必须一样，否则拖动球时木纹会跳。 */
function makeRand(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const FELT_FIBERS = (() => {
  const rand = makeRand(0x51f15e);
  return Array.from({ length: 720 }, () => ({
    x: 0.01 + rand() * 0.98,
    y: 0.01 + rand() * 0.98,
    length: 0.002 + rand() * 0.005,
    angle: rand() < 0.84 ? 0 : Math.PI / 2,
    alpha: 0.025 + rand() * 0.045,
  }));
})();

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function createRenderer({ canvas, table: initialTable }) {
  let ctx = canvas.getContext('2d');
  // 球台可换（9 尺 / 8 尺 / 斯诺克）。不用参数而是 let，
  // 是因为 toPx/toWorld/fit 全都依赖台面尺寸，换台必须换这三者的结果。
  let table = initialTable;
  let scale = 1;
  let offset = { x: 0, y: 0 };
  let dpr = 1;

  // 台面缓存：俯视 2D 模式下整张台面是静态内容（木框、台呢、库边、袋口、纤维），
  // 不随相机或球位变化。预渲染到离屏 canvas 后，每帧只需一次 drawImage，
  // 省掉几百次渐变创建和路径操作。换台或 fit 时重建。
  let tableCache = null;
  let tableCacheKey = null; // `${preset}:${scale}:${dpr}` 用于检测是否需要重建

  // 视角相机模型：t = 0 为第三人称俯视，t = 1 为第一人称趴杆瞄准视角
  const camera = {
    t: 0,
    aimAngle: 0,
    cueBall: { x: 0, y: 0 },
    strokeOffset: 0,
  };

  // 内部计算的当前相机实时参数（四元数 Slerp 与空间矩阵）
  const currentCam = {
    C: [0, 0, 0],
    R: [1, 0, 0],
    V: [0, -1, 0],
    F: [0, 0, -1],
    cx: 0,
    cy: 0,
    f: 0,
  };

  function setCamera(opts = {}) {
    if (opts.t !== undefined) camera.t = Math.max(0, Math.min(1, opts.t));
    if (opts.aimAngle !== undefined) camera.aimAngle = opts.aimAngle;
    if (opts.cueBall) camera.cueBall = { ...opts.cueBall };
    if (opts.strokeOffset !== undefined) camera.strokeOffset = opts.strokeOffset;
  }

  function getCamera() {
    return { ...camera };
  }

  /** 将三维正交右手系矩阵 (R, V, F) 转化为四元数 [qx, qy, qz, qw] */
  function matToQuat(R, V, F) {
    const m00 = R[0], m01 = R[1], m02 = R[2];
    const m10 = V[0], m11 = V[1], m12 = V[2];
    const m20 = F[0], m21 = F[1], m22 = F[2];
    const tr = m00 + m11 + m22;
    let qx, qy, qz, qw;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1.0);
      qw = 0.25 / s;
      qx = (m21 - m12) * s;
      qy = (m02 - m20) * s;
      qz = (m10 - m01) * s;
    } else if ((m00 > m11) && (m00 > m22)) {
      const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
      qw = (m21 - m12) / s;
      qx = 0.25 * s;
      qy = (m01 + m10) / s;
      qz = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
      qw = (m02 - m20) / s;
      qx = (m01 + m10) / s;
      qy = 0.25 * s;
      qz = (m12 + m21) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
      qw = (m10 - m01) / s;
      qx = (m02 + m20) / s;
      qy = (m12 + m21) / s;
      qz = 0.25 * s;
    }
    return [qx, qy, qz, qw];
  }

  /** 将四元数转化为 3x3 空间矩阵 */
  function quatToMat(q) {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return {
      R: [1 - (yy + zz), xy - wz, xz + wy],
      V: [xy + wz, 1 - (xx + zz), yz - wx],
      F: [xz - wy, yz + wx, 1 - (xx + yy)],
    };
  }

  /** 四元数球面最短弧插值 (Slerp) */
  function quatSlerp(qa, qb, t) {
    let cosHalfTheta = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
    let qbTarget = [qb[0], qb[1], qb[2], qb[3]];
    if (cosHalfTheta < 0) {
      cosHalfTheta = -cosHalfTheta;
      qbTarget[0] = -qbTarget[0];
      qbTarget[1] = -qbTarget[1];
      qbTarget[2] = -qbTarget[2];
      qbTarget[3] = -qbTarget[3];
    }
    if (Math.abs(cosHalfTheta) >= 1.0) return [qa[0], qa[1], qa[2], qa[3]];
    const halfTheta = Math.acos(cosHalfTheta);
    const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);
    if (Math.abs(sinHalfTheta) < 0.001) {
      return [
        0.5 * (qa[0] + qbTarget[0]),
        0.5 * (qa[1] + qbTarget[1]),
        0.5 * (qa[2] + qbTarget[2]),
        0.5 * (qa[3] + qbTarget[3]),
      ];
    }
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
    return [
      qa[0] * ratioA + qbTarget[0] * ratioB,
      qa[1] * ratioA + qbTarget[1] * ratioB,
      qa[2] * ratioA + qbTarget[2] * ratioB,
      qa[3] * ratioA + qbTarget[3] * ratioB,
    ];
  }

  /** 根据当前 camera.t, aimAngle, cueBall 计算电影级 3D 相机空间状态 */
  function computeCurrentCamera() {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const u = camera.t;

    const cueX = camera.cueBall?.x ?? table.length * 0.25;
    const cueY = camera.cueBall?.y ?? table.width * 0.5;
    const theta = camera.aimAngle ?? 0;

    const D_cam = 0.62;
    const H_cam = 0.24;
    const pitch = 0.19;

    // 0 态：正交俯视相机 (R0, V0, F0)
    const R0 = [1, 0, 0];
    const V0 = [0, -1, 0];
    const F0 = [0, 0, -1];
    const q0 = matToQuat(R0, V0, F0);

    // 1 态：第一人称趴杆瞄准相机 (R1, V1, F1)
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    const R1 = [sinT, -cosT, 0];
    const V1 = [cosT * sinP, sinT * sinP, -cosP];
    const F1 = [cosT * cosP, sinT * cosP, sinP];
    const q1 = matToQuat(R1, V1, F1);

    // 四元数球面插值
    const q = quatSlerp(q0, q1, u);
    const m = quatToMat(q);

    // 空间位置弧线过渡：高空俯视位置 -> 趴杆眼位
    const Ztop = (h * 0.72) / scale;
    const C0 = [table.length * 0.5, table.width * 0.5, Ztop];
    const C1 = [cueX - D_cam * cosT, cueY - D_cam * sinT, H_cam];

    // 微拱形飞行弧线：在飞行中微抬 14cm 产生逼真的飞降/拉起运镜质感
    const liftArc = Math.sin(Math.PI * u) * 0.14;
    currentCam.C = [
      (1 - u) * C0[0] + u * C1[0],
      (1 - u) * C0[1] + u * C1[1],
      (1 - u) * C0[2] + u * C1[2] + liftArc,
    ];
    currentCam.R = m.R;
    currentCam.V = m.V;
    currentCam.F = m.F;

    currentCam.cx = w * 0.5;
    currentCam.cy = (1 - u) * (h * 0.5) + u * (h * 0.12);
    currentCam.f = (1 - u) * (Ztop * scale) + u * (h * 0.9);
  }

  /**
   * 将世界坐标 (x, y, z) 投影到屏幕像素坐标。
   * 基于纯三维四元数摄像机刚体运动变换，杜绝任何二维扭曲与畸变拉扯。
   */
  function project(x, y, z = 0) {
    // 第三人称 2D 坐标（与经典俯视图严格一致）
    const p2d = {
      x: offset.x + x * scale,
      y: offset.y + (table.width - y) * scale,
    };
    const r2d = scale;

    if (camera.t <= 0.0001) {
      return {
        x: p2d.x,
        y: p2d.y,
        scale: r2d,
        depth: 1,
        zCam: 1,
        behind: false,
      };
    }

    const C = currentCam.C;
    const R = currentCam.R;
    const V = currentCam.V;
    const F = currentCam.F;

    const dx = x - C[0];
    const dy = y - C[1];
    const dz = z - C[2];

    const xCam = dx * R[0] + dy * R[1] + dz * R[2];
    const yScreen = dx * V[0] + dy * V[1] + dz * V[2];
    const zCam = dx * F[0] + dy * F[1] + dz * F[2];

    const behind = zCam < 0.03;
    const safeZ = Math.max(0.04, zCam);

    const p3d = {
      x: currentCam.cx + (xCam / safeZ) * currentCam.f,
      y: currentCam.cy + (yScreen / safeZ) * currentCam.f,
    };
    const r3d = currentCam.f / safeZ;

    // 当 t 极度接近 0 时平滑混合，实现完全平稳无缝的对接
    if (camera.t < 0.08) {
      const blend = camera.t / 0.08;
      const bSmooth = blend * blend * (3 - 2 * blend);
      return {
        x: (1 - bSmooth) * p2d.x + bSmooth * p3d.x,
        y: (1 - bSmooth) * p2d.y + bSmooth * p3d.y,
        scale: (1 - bSmooth) * r2d + bSmooth * r3d,
        depth: safeZ,
        zCam,
        behind: false,
      };
    }

    return {
      x: p3d.x,
      y: p3d.y,
      scale: r3d,
      depth: safeZ,
      zCam,
      behind: behind && camera.t > 0.35,
    };
  }

  /** 多边形针对摄像机近平面 (zCam >= nearZ) 进行平滑几何裁剪，防止背面顶点翻转畸变 */
  function clipPolygonNear(poly, nearZ = 0.05) {
    if (camera.t <= 0.001) return poly;

    const C = currentCam.C;
    const F = currentCam.F;

    const getZCam = (pt) => {
      const dx = pt.x - C[0];
      const dy = pt.y - C[1];
      const dz = (pt.z ?? 0) - C[2];
      return dx * F[0] + dy * F[1] + dz * F[2];
    };

    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i];
      const next = poly[(i + 1) % poly.length];
      const curZ = getZCam(cur);
      const nextZ = getZCam(next);
      const curIn = curZ >= nearZ;
      const nextIn = nextZ >= nearZ;

      if (curIn) {
        out.push(cur);
        if (!nextIn) {
          const t = (nearZ - curZ) / (nextZ - curZ);
          out.push({
            x: cur.x + (next.x - cur.x) * t,
            y: cur.y + (next.y - cur.y) * t,
            z: (cur.z ?? 0) + ((next.z ?? 0) - (cur.z ?? 0)) * t,
          });
        }
      } else if (nextIn) {
        const t = (nearZ - curZ) / (nextZ - curZ);
        out.push({
          x: cur.x + (next.x - cur.x) * t,
          y: cur.y + (next.y - cur.y) * t,
          z: (cur.z ?? 0) + ((next.z ?? 0) - (cur.z ?? 0)) * t,
        });
      }
    }
    return out;
  }

  function drawProjectedPolygon(poly, fillStyle, strokeStyle = null, lineWidth = 1) {
    const clipped = camera.t > 0.001 ? clipPolygonNear(poly, 0.05) : poly;
    if (clipped.length < 3) return;
    ctx.beginPath();
    const first = project(clipped[0].x, clipped[0].y, clipped[0].z ?? 0);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < clipped.length; i++) {
      const p = project(clipped[i].x, clipped[i].y, clipped[i].z ?? 0);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    if (fillStyle) {
      ctx.fillStyle = fillStyle;
      ctx.fill();
    }
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  const toPx = (p) => ({
    x: offset.x + p.x * scale,
    y: offset.y + (table.width - p.y) * scale,
  });

  const toWorld = (px, py) => ({
    x: (px - offset.x) / scale,
    y: table.width - (py - offset.y) / scale,
  });

  /** 按可用像素尺寸自适应缩放，并把 canvas 尺寸设成 CSS 像素 × dpr。 */
  function fit(availW, availH) {
    const totalW = table.length + FRAME_MARGIN * 2;
    const totalH = table.width + FRAME_MARGIN * 2;
    scale = Math.min(availW / totalW, availH / totalH);
    dpr = Math.min(window.devicePixelRatio || 1, 2);

    const w = totalW * scale;
    const h = totalH * scale;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    offset = { x: FRAME_MARGIN * scale, y: FRAME_MARGIN * scale };
    tableCache = null; // 缩放变了，缓存失效
    return { w, h, scale };
  }

  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // -------------------------------------------------------------- 球桌

  function drawWood(w, h) {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#7b4a28');
    grad.addColorStop(0.45, '#5d3618');
    grad.addColorStop(1, '#3d2210');
    roundRectPath(ctx, 0, 0, w, h, 16);
    ctx.fillStyle = grad;
    ctx.fill();

    // 木纹：几十条横向细线，透明度很低，只在近看时透出来
    ctx.save();
    roundRectPath(ctx, 0, 0, w, h, 16);
    ctx.clip();
    const rand = makeRand(0x9e3779b9);
    const lines = Math.max(24, Math.round(h / 9));
    for (let i = 0; i < lines; i++) {
      const y = (i / lines) * h + rand() * 6;
      const amp = 1.2 + rand() * 2.6;
      const phase = rand() * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(-4, y);
      for (let x = -4; x <= w + 4; x += 14) {
        ctx.lineTo(x, y + Math.sin(x / 47 + phase) * amp);
      }
      ctx.strokeStyle = i % 3 === 0 ? 'rgba(0,0,0,0.16)' : 'rgba(255,214,170,0.055)';
      ctx.lineWidth = 0.6 + rand() * 0.9;
      ctx.stroke();
    }
    // 整体压暗一点，让台呢更亮
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // 外沿高光
    roundRectPath(ctx, 0.5, 0.5, w - 1, h - 1, 16);
    ctx.strokeStyle = 'rgba(255,222,180,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawCushionBand() {
    // 台面外一圈：库边顶面，比木框暗，形成台阶
    const m = FRAME_MARGIN * scale;
    const inset = m * 0.42;
    const tl = { x: m - inset, y: m - inset };
    const w = table.length * scale + inset * 2;
    const h = table.width * scale + inset * 2;
    roundRectPath(ctx, tl.x, tl.y, w, h, 10);
    const grad = ctx.createLinearGradient(tl.x, tl.y, tl.x, tl.y + h);
    grad.addColorStop(0, '#1d3b28');
    grad.addColorStop(0.5, '#16301f');
    grad.addColorStop(1, '#122718');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawFelt() {
    const tl = toPx({ x: 0, y: table.width });
    const br = toPx({ x: table.length, y: 0 });
    const w = br.x - tl.x;
    const h = br.y - tl.y;

    const grad = ctx.createRadialGradient(
      tl.x + w * 0.34, tl.y + h * 0.3, Math.min(w, h) * 0.05,
      tl.x + w * 0.5, tl.y + h * 0.55, Math.max(w, h) * 0.78
    );
    grad.addColorStop(0, '#157a49');
    grad.addColorStop(0.55, '#0f5c37');
    grad.addColorStop(1, '#0a3f26');
    ctx.fillStyle = grad;
    ctx.fillRect(tl.x, tl.y, w, h);

    // 库边内阴影：四条边各一条渐变，让台呢看起来是凹的
    const depth = Math.max(4, Math.min(14, Math.min(w, h) * 0.045));
    const edges = [
      [tl.x, tl.y, w, depth, 0, 0, 0, 1],
      [tl.x, tl.y + h - depth, w, depth, 0, 0, 0, -1],
      [tl.x, tl.y, depth, h, 0, 0, 1, 0],
      [tl.x + w - depth, tl.y, depth, h, 0, 0, -1, 0],
    ];
    for (const [x, y, ew, eh, gx0, gy0, gx1, gy1] of edges) {
      const g = ctx.createLinearGradient(
        x + (gx0 ? 0 : gx1 ? ew : 0),
        y + (gy0 ? 0 : gy1 ? eh : 0),
        x + (gx0 ? 0 : gx1 ? 0 : 0),
        y + (gy0 ? 0 : gy1 ? 0 : 0)
      );
      g.addColorStop(0, 'rgba(0,0,0,0.42)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, ew, eh);
    }

    // 台呢织纹：极淡的斜线，只在放大时可见
    ctx.save();
    ctx.beginPath();
    ctx.rect(tl.x, tl.y, w, h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.018)';
    ctx.lineWidth = 1;
    for (let x = -h; x < w; x += 7) {
      ctx.beginPath();
      ctx.moveTo(tl.x + x, tl.y);
      ctx.lineTo(tl.x + x + h, tl.y + h);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMarkings() {
    const hs = table.length / 4;
    const fs = (table.length * 3) / 4;

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    const a = toPx({ x: hs, y: 0 });
    const b = toPx({ x: hs, y: table.width });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    for (const spot of [{ x: fs, y: table.width / 2 }, { x: table.length / 2, y: table.width / 2 }]) {
      const p = toPx(spot);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.5, 0.006 * scale), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fill();
    }
  }

  function drawDiamonds() {
    // 长边每 1/8 一个、短边每 1/4 一个，画在木框上——这是真实球台的瞄点
    const size = Math.max(2.2, Math.min(5, FRAME_MARGIN * scale * 0.24));
    const spots = [];
    for (let i = 1; i < 8; i++) {
      const x = (table.length * i) / 8;
      spots.push({ x, y: table.width + FRAME_MARGIN * 0.5 });
      spots.push({ x, y: -FRAME_MARGIN * 0.5 });
    }
    for (let i = 1; i < 4; i++) {
      const y = (table.width * i) / 4;
      spots.push({ x: -FRAME_MARGIN * 0.5, y });
      spots.push({ x: table.length + FRAME_MARGIN * 0.5, y });
    }
    ctx.fillStyle = 'rgba(255,236,205,0.62)';
    for (const s of spots) {
      const p = toPx(s);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - size);
      ctx.lineTo(p.x + size, p.y);
      ctx.lineTo(p.x, p.y + size);
      ctx.lineTo(p.x - size, p.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawPockets() {
    for (const p of table.pockets) {
      const c = toPx(p);
      const r = p.captureR * scale;

      // 袋口皮圈
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * 1.24, 0, Math.PI * 2);
      ctx.fillStyle = '#241309';
      ctx.fill();

      // 黑洞：中心更深，边缘略亮，模拟袋底不是纯黑
      const g = ctx.createRadialGradient(c.x, c.y, r * 0.1, c.x, c.y, r * 1.05);
      g.addColorStop(0, '#000000');
      g.addColorStop(0.72, '#04070a');
      g.addColorStop(1, '#101820');
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * 1.02, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      // 袋口内沿高光（只画上半圈，像是被台面挡住的一侧反光）
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * 1.12, Math.PI * 1.06, Math.PI * 1.94);
      ctx.strokeStyle = 'rgba(255,220,180,0.20)';
      ctx.lineWidth = Math.max(1, r * 0.1);
      ctx.stroke();
    }
  }

  function drawTable3D() {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const L = table.length;
    const W = table.width;
    const Mc = FRAME_MARGIN * 0.42;
    const Mw = FRAME_MARGIN;

    // 1. 球馆氛围背景：柔和顶灯与深暗夜色聚光（平滑淡入，过渡期无跳变）
    const bgAlpha = Math.min(1, Math.max(0, (camera.t - 0.02) / 0.35));
    if (bgAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = bgAlpha;
      const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.4, h * 0.1, w * 0.5, h * 0.5, h * 1.1);
      bgGrad.addColorStop(0, '#16222f');
      bgGrad.addColorStop(0.55, '#0d1520');
      bgGrad.addColorStop(1, '#070b10');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // 台面顶部温润灯光漫射
      const lamp = ctx.createRadialGradient(w * 0.5, h * 0.35, 20, w * 0.5, h * 0.35, w * 0.55);
      lamp.addColorStop(0, 'rgba(255, 240, 215, 0.08)');
      lamp.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = lamp;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    // 桌身侧板补出真实厚度，让低机位下的桌沿不再像一张平面贴图。
    const apronZ = -0.085;
    const apronFaces = [
      [[-Mw, -Mw, 0], [L + Mw, -Mw, 0], [L + Mw, -Mw, apronZ], [-Mw, -Mw, apronZ]],
      [[L + Mw, -Mw, 0], [L + Mw, W + Mw, 0], [L + Mw, W + Mw, apronZ], [L + Mw, -Mw, apronZ]],
      [[L + Mw, W + Mw, 0], [-Mw, W + Mw, 0], [-Mw, W + Mw, apronZ], [L + Mw, W + Mw, apronZ]],
      [[-Mw, W + Mw, 0], [-Mw, -Mw, 0], [-Mw, -Mw, apronZ], [-Mw, W + Mw, apronZ]],
    ];
    for (const face of apronFaces) {
      drawProjectedPolygon(face.map(([x, y, z]) => ({ x, y, z })), '#35200f', 'rgba(0,0,0,0.65)', 1);
    }

    // 2. 木框（四条外边，使用与 2D 完全统一的实木配色）
    const woodGrad = ctx.createLinearGradient(0, 0, w, h);
    woodGrad.addColorStop(0, '#533118');
    woodGrad.addColorStop(0.5, '#3d2210');
    woodGrad.addColorStop(1, '#2a160a');

    // 下、右、上、左 4 条木质长边
    const woodRails = [
      [{ x: -Mw, y: -Mw }, { x: L + Mw, y: -Mw }, { x: L + Mc, y: -Mc }, { x: -Mc, y: -Mc }],
      [{ x: L + Mc, y: -Mc }, { x: L + Mw, y: -Mw }, { x: L + Mw, y: W + Mw }, { x: L + Mc, y: W + Mc }],
      [{ x: -Mc, y: W + Mc }, { x: L + Mc, y: W + Mc }, { x: L + Mw, y: W + Mw }, { x: -Mw, y: W + Mw }],
      [{ x: -Mw, y: -Mw }, { x: -Mc, y: -Mc }, { x: -Mc, y: W + Mc }, { x: -Mw, y: W + Mw }],
    ];
    for (const r of woodRails) {
      drawProjectedPolygon(r, woodGrad, 'rgba(0,0,0,0.5)', 1);
    }

    // 顺木纹细线固定在桌面坐标上，运镜时不会随屏幕漂移。
    for (let i = 1; i <= 12; i++) {
      const ratio = i / 13;
      const yNear = -Mw + (Mw - Mc) * ratio;
      const yFar = W + Mc + Mw * ratio;
      for (const y of [yNear, yFar]) {
        const a = project(-Mw * 0.8, y, 0.001);
        const b = project(L + Mw * 0.8, y, 0.001);
        if (a.behind || b.behind) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = i % 3 === 0 ? 'rgba(0,0,0,0.12)' : 'rgba(255,215,165,0.055)';
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }

    // 3. 瞄点（菱形 / 珍珠贝母标志点）
    const spots = [];
    for (let i = 1; i < 8; i++) {
      const x = (L * i) / 8;
      spots.push({ x, y: W + Mw * 0.5 });
      spots.push({ x, y: -Mw * 0.5 });
    }
    for (let i = 1; i < 4; i++) {
      const y = (W * i) / 4;
      spots.push({ x: -Mw * 0.5, y });
      spots.push({ x: L + Mw * 0.5, y });
    }
    ctx.fillStyle = 'rgba(255, 236, 205, 0.75)';
    for (const s of spots) {
      const p = project(s.x, s.y, 0.005);
      if (p.behind) continue;
      const sz = Math.max(1.8, 3.2 * (p.scale / scale));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - sz);
      ctx.lineTo(p.x + sz, p.y);
      ctx.lineTo(p.x, p.y + sz);
      ctx.lineTo(p.x - sz, p.y);
      ctx.closePath();
      ctx.fill();
    }

    // 4. 库边缓冲带（四条内边坡度）
    const cushGrad = ctx.createLinearGradient(0, 0, 0, h);
    cushGrad.addColorStop(0, '#1a3824');
    cushGrad.addColorStop(0.5, '#122b1c');
    cushGrad.addColorStop(1, '#0e2015');

    const cushionBands = [
      [{ x: -Mc, y: -Mc }, { x: L + Mc, y: -Mc }, { x: L, y: 0 }, { x: 0, y: 0 }],
      [{ x: L + Mc, y: -Mc }, { x: L + Mc, y: W + Mc }, { x: L, y: W }, { x: L, y: 0 }],
      [{ x: 0, y: W }, { x: L, y: W }, { x: L + Mc, y: W + Mc }, { x: -Mc, y: W + Mc }],
      [{ x: -Mc, y: -Mc }, { x: 0, y: 0 }, { x: 0, y: W }, { x: -Mc, y: W + Mc }],
    ];
    for (const c of cushionBands) {
      drawProjectedPolygon(c, cushGrad, 'rgba(0,0,0,0.6)', 1.2);
    }

    // 5. 台呢台面
    const feltPoly = [
      { x: 0, y: 0 },
      { x: L, y: 0 },
      { x: L, y: W },
      { x: 0, y: W },
    ];
    const pCenter = project(L * 0.5, W * 0.5, 0);
    const feltR = Math.max(w, h) * 0.75;
    const feltGrad = ctx.createRadialGradient(
      pCenter.x, pCenter.y * 0.95, feltR * 0.05,
      pCenter.x, pCenter.y, feltR
    );
    feltGrad.addColorStop(0, '#157a49');
    feltGrad.addColorStop(0.55, '#0f5c37');
    feltGrad.addColorStop(1, '#083620');
    drawProjectedPolygon(feltPoly, feltGrad, 'rgba(0,0,0,0.4)', 1);

    // 极细的定向织纤维固定在台呢上，近景才看得出布料而非纯色平面。
    ctx.save();
    const feltCorners = feltPoly.map((point) => project(point.x, point.y, 0));
    ctx.beginPath();
    ctx.moveTo(feltCorners[0].x, feltCorners[0].y);
    for (let i = 1; i < feltCorners.length; i++) ctx.lineTo(feltCorners[i].x, feltCorners[i].y);
    ctx.closePath();
    ctx.clip();
    for (const fiber of FELT_FIBERS) {
      const x = fiber.x * L;
      const y = fiber.y * W;
      const dx = Math.cos(fiber.angle) * fiber.length;
      const dy = Math.sin(fiber.angle) * fiber.length;
      const a = project(x, y, 0.001);
      const b = project(x + dx, y + dy, 0.001);
      if (a.behind || b.behind) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(211,255,225,${fiber.alpha})`;
      ctx.lineWidth = Math.max(0.35, Math.min(1, a.scale * fiber.length * 0.16));
      ctx.stroke();
    }
    ctx.restore();

    // 6. 开球线与底点标记
    const hs = L / 4;
    const pa = project(hs, 0, 0);
    const pb = project(hs, W, 0);
    if (!pa.behind && !pb.behind) {
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const fs = (L * 3) / 4;
    for (const spot of [{ x: fs, y: W / 2 }, { x: L / 2, y: W / 2 }]) {
      const p = project(spot.x, spot.y, 0);
      if (!p.behind) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.5, 2.5 * (p.scale / scale)), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.20)';
        ctx.fill();
      }
    }

    // 7. 袋口（3D 深度渐变与皮边）
    for (const p of table.pockets) {
      const proj = project(p.x, p.y, 0);
      if (proj.behind) continue;
      const r = p.captureR * proj.scale;

      ctx.beginPath();
      ctx.arc(proj.x, proj.y, r * 1.22, 0, Math.PI * 2);
      ctx.fillStyle = '#211208';
      ctx.fill();

      const g = ctx.createRadialGradient(proj.x, proj.y, r * 0.1, proj.x, proj.y, r * 1.05);
      g.addColorStop(0, '#000000');
      g.addColorStop(0.75, '#04070a');
      g.addColorStop(1, '#111922');
      ctx.beginPath();
      ctx.arc(proj.x, proj.y, r * 1.02, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(proj.x, proj.y, r * 1.1, Math.PI * 1.05, Math.PI * 1.95);
      ctx.strokeStyle = 'rgba(255, 225, 185, 0.22)';
      ctx.lineWidth = Math.max(1, r * 0.08);
      ctx.stroke();
    }
  }

  /**
   * 把俯视 2D 台面预渲染到离屏 canvas。
   * 木框、台呢、库边、袋口、纤维、标记——全部静态内容一次画完。
   * 后续帧只 drawImage 贴上来，省掉几百次渐变创建。
   */
  function buildTableCache() {
    const totalW = (table.length + FRAME_MARGIN * 2) * scale;
    const totalH = (table.width + FRAME_MARGIN * 2) * scale;
    const cacheDpr = dpr;
    const offscreen = document.createElement('canvas');
    offscreen.width = Math.round(totalW * cacheDpr);
    offscreen.height = Math.round(totalH * cacheDpr);
    const offCtx = offscreen.getContext('2d');
    offCtx.setTransform(cacheDpr, 0, 0, cacheDpr, 0, 0);

    // 临时把 ctx 指向离屏上下文，让 drawWood/drawFelt 等闭包函数画到离屏上
    const savedCtx = ctx;
    ctx = offCtx;
    drawWood(totalW, totalH);
    drawDiamonds();
    drawCushionBand();
    drawFelt();
    drawMarkings();
    drawPockets();
    ctx = savedCtx;

    tableCache = offscreen;
    tableCacheKey = `${table.preset}:${scale}:${cacheDpr}`;
  }

  function drawTable() {
    computeCurrentCamera();
    if (camera.t <= 0.0001) {
      // 俯视 2D 模式：整张台面是静态内容，用缓存
      const cacheKey = `${table.preset}:${scale}:${dpr}`;
      if (!tableCache || tableCacheKey !== cacheKey) {
        buildTableCache();
      }
      // drawImage 自动处理 dpr 缩放：offscreen 像素尺寸 = CSS 尺寸 × dpr
      ctx.drawImage(tableCache, 0, 0, tableCache.width, tableCache.height,
                    0, 0, tableCache.width / dpr, tableCache.height / dpr);
    } else {
      drawTable3D();
    }
  }

  // -------------------------------------------------------------- 球

  /** 球面上的条纹带：把球面看成球体，色带占据中间约 62% 的高度。 */
  function drawStripeBand(cx, cy, r, color, angle) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    const bandH = r * 1.34;
    const g = ctx.createLinearGradient(0, -bandH / 2, 0, bandH / 2);
    g.addColorStop(0, shade(color, -0.12));
    g.addColorStop(0.5, color);
    g.addColorStop(1, shade(color, -0.22));
    ctx.fillStyle = g;
    ctx.fillRect(-r * 1.1, -bandH / 2, r * 2.2, bandH);
    ctx.restore();
  }

  /**
   * 画一颗球。
   * @param {object} b 球（用 number 推颜色，不看 b.color，保证两页一致）
   * @param {{ghost?:boolean, lift?:number}} [opts]
   */
  function drawBall(b, opts = {}) {
    const style = ballStyle(b.number ?? 0);
    const proj = project(b.x, b.y, table.ballRadius);
    if (proj.behind) return;

    const c = { x: proj.x, y: proj.y };
    const r = Math.max(2.5, table.ballRadius * proj.scale);
    const lift = opts.lift ?? 0;

    // 接触阴影：柔和的环境遮蔽比实心黑椭圆更像球压在台呢上。
    const projShadow = project(b.x, b.y, 0);
    if (!projShadow.behind) {
      ctx.save();
      ctx.translate(projShadow.x + r * 0.14, projShadow.y + r * 0.24 + lift);
      ctx.scale(r * 0.96, r * 0.72);
      const shadow = ctx.createRadialGradient(0, 0, 0.08, 0, 0, 1);
      shadow.addColorStop(0, 'rgba(0,0,0,0.38)');
      shadow.addColorStop(0.62, 'rgba(0,0,0,0.20)');
      shadow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fillStyle = shadow;
      ctx.fill();
      ctx.restore();
    }

    const cy = c.y - lift;
    const rollAngle = ((b.rollAngle ?? 0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);

    if (style.stripe) {
      // 条纹球：白底 + 色带
      ctx.beginPath();
      ctx.arc(c.x, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#f4f1e8';
      ctx.fill();
      drawStripeBand(c.x, cy, r, style.color, stripeAngle(b) + rollAngle);
    } else {
      ctx.beginPath();
      ctx.arc(c.x, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = style.color;
      ctx.fill();
    }

    // 球体明暗：左上亮、右下暗
    const g = ctx.createRadialGradient(
      c.x - r * 0.38, cy - r * 0.42, r * 0.05,
      c.x - r * 0.1, cy - r * 0.1, r * 1.35
    );
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.32, 'rgba(255,255,255,0.10)');
    g.addColorStop(0.62, 'rgba(0,0,0,0.02)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.beginPath();
    ctx.arc(c.x, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();

    // 号码盘
    if (b.number > 0 && r > 6 && Math.cos(rollAngle) > -0.02) {
      const facing = Math.max(0.08, Math.cos(rollAngle));
      const rollDistance = -Math.sin(rollAngle) * table.ballRadius;
      const badge = rollAngle > 1e-6
        ? project(
          b.x + (b.rollDirX ?? 0) * rollDistance,
          b.y + (b.rollDirY ?? 0) * rollDistance,
          table.ballRadius * (1 + facing)
        )
        : { x: c.x, y: cy, scale: proj.scale };
      if (!badge.behind) {
        ctx.beginPath();
        ctx.ellipse(badge.x, badge.y - lift, r * 0.46 * facing, r * 0.46 * facing, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#fbfaf6';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.10)';
        ctx.lineWidth = Math.max(0.6, r * 0.045);
        ctx.stroke();

        ctx.fillStyle = '#12161c';
        ctx.font = `700 ${Math.max(4, r * 0.56 * facing)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(b.number), badge.x, badge.y - lift + r * 0.04 * facing);
      }
    }

    // 镜面高光
    ctx.beginPath();
    ctx.ellipse(c.x - r * 0.34, cy - r * 0.38, r * 0.22, r * 0.15, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fill();

    // 轮廓，避免深色球在深色台呢上糊成一团
    ctx.beginPath();
    ctx.arc(c.x, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.30)';
    ctx.lineWidth = Math.max(0.5, r * 0.05);
    ctx.stroke();

    if (opts.ghost) {
      ctx.beginPath();
      ctx.arc(c.x, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(250,204,21,0.9)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  /** 第一人称逼真球杆绘制 */
  function drawCueStick(strokeOffset = 0) {
    if (camera.t <= 0.12) return;
    const alpha = Math.min(1, (camera.t - 0.12) / 0.58);
    ctx.save();
    ctx.globalAlpha = alpha;

    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    const cueProj = project(camera.cueBall.x, camera.cueBall.y, table.ballRadius);
    const cueR = Math.max(12, table.ballRadius * cueProj.scale);

    // 优雅滑入动效：未完全就位时微退，就位时稳稳对准母球
    const dockShift = (1 - alpha) * 40;
    const gap = Math.max(2, strokeOffset * 350 + 6 + dockShift);
    const tipY = cueProj.y + cueR + gap;
    const tipX = cueProj.x;

    const buttY = h + 25 + dockShift * 0.5;
    const buttX = cueProj.x;

    const tipW = Math.max(8, cueR * 0.32);
    const buttW = Math.max(26, cueR * 0.95);

    // 球杆在地面的投影阴影
    ctx.beginPath();
    ctx.moveTo(tipX - tipW * 0.4, tipY + 4);
    ctx.lineTo(tipX + tipW * 0.4, tipY + 4);
    ctx.lineTo(buttX + buttW * 0.4, buttY);
    ctx.lineTo(buttX - buttW * 0.4, buttY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.40)';
    ctx.fill();

    // 1. 前截枫木杆身
    const shaftGrad = ctx.createLinearGradient(tipX - buttW * 0.5, 0, tipX + buttW * 0.5, 0);
    shaftGrad.addColorStop(0, '#854d0e');
    shaftGrad.addColorStop(0.18, '#d97706');
    shaftGrad.addColorStop(0.45, '#fef3c7');
    shaftGrad.addColorStop(0.72, '#fde68a');
    shaftGrad.addColorStop(1, '#92400e');

    ctx.beginPath();
    ctx.moveTo(tipX - tipW * 0.5, tipY);
    ctx.lineTo(tipX + tipW * 0.5, tipY);
    ctx.lineTo(buttX + buttW * 0.5, buttY);
    ctx.lineTo(buttX - buttW * 0.5, buttY);
    ctx.closePath();
    ctx.fillStyle = shaftGrad;
    ctx.fill();

    // 杆身高光反光线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tipX - tipW * 0.1, tipY);
    ctx.lineTo(buttX - buttW * 0.1, buttY);
    ctx.stroke();

    // 2. 握把后截 (Dark Irish Linen Wrap)
    const wrapStartY = tipY + (buttY - tipY) * 0.55;
    const wrapW = tipW + (buttW - tipW) * 0.55;
    const wrapGrad = ctx.createLinearGradient(buttX - buttW * 0.5, 0, buttX + buttW * 0.5, 0);
    wrapGrad.addColorStop(0, '#0f172a');
    wrapGrad.addColorStop(0.25, '#1e293b');
    wrapGrad.addColorStop(0.5, '#334155');
    wrapGrad.addColorStop(0.75, '#1e293b');
    wrapGrad.addColorStop(1, '#020617');

    ctx.beginPath();
    ctx.moveTo(tipX - wrapW * 0.5, wrapStartY);
    ctx.lineTo(tipX + wrapW * 0.5, wrapStartY);
    ctx.lineTo(buttX + buttW * 0.5, buttY);
    ctx.lineTo(buttX - buttW * 0.5, buttY);
    ctx.closePath();
    ctx.fillStyle = wrapGrad;
    ctx.fill();

    // 握把防滑细密纹路
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 1;
    for (let y = wrapStartY; y < buttY; y += 6) {
      const curW = tipW + ((buttW - tipW) * (y - tipY)) / (buttY - tipY);
      ctx.beginPath();
      ctx.moveTo(tipX - curW * 0.48, y);
      ctx.lineTo(tipX + curW * 0.48, y);
      ctx.stroke();
    }

    // 3. 先角 (Ferrule，象牙白)
    const ferruleH = Math.max(12, cueR * 0.36);
    const ferruleGrad = ctx.createLinearGradient(tipX - tipW * 0.5, 0, tipX + tipW * 0.5, 0);
    ferruleGrad.addColorStop(0, '#94a3b8');
    ferruleGrad.addColorStop(0.3, '#ffffff');
    ferruleGrad.addColorStop(0.7, '#f8fafc');
    ferruleGrad.addColorStop(1, '#64748b');

    ctx.beginPath();
    ctx.moveTo(tipX - tipW * 0.5, tipY);
    ctx.lineTo(tipX + tipW * 0.5, tipY);
    ctx.lineTo(tipX + tipW * 0.54, tipY + ferruleH);
    ctx.lineTo(tipX - tipW * 0.54, tipY + ferruleH);
    ctx.closePath();
    ctx.fillStyle = ferruleGrad;
    ctx.fill();

    // 4. 巧克皮头 (Leather Tip，蓝色巧克粉)
    const tipH = Math.max(6, cueR * 0.18);
    const tipGrad = ctx.createLinearGradient(tipX - tipW * 0.5, 0, tipX + tipW * 0.5, 0);
    tipGrad.addColorStop(0, '#0369a1');
    tipGrad.addColorStop(0.35, '#38bdf8');
    tipGrad.addColorStop(0.75, '#0ea5e9');
    tipGrad.addColorStop(1, '#0c4a6e');

    ctx.beginPath();
    ctx.moveTo(tipX - tipW * 0.48, tipY);
    ctx.bezierCurveTo(tipX - tipW * 0.48, tipY - tipH, tipX + tipW * 0.48, tipY - tipH, tipX + tipW * 0.48, tipY);
    ctx.closePath();
    ctx.fillStyle = tipGrad;
    ctx.fill();

    ctx.restore();
  }

  /** 第一人称瞄准准星 HUD */
  function draw1stPersonHUD(aimInfo) {
    if (camera.t <= 0.22) return;
    const alpha = Math.min(1, (camera.t - 0.22) / 0.58);
    ctx.save();
    ctx.globalAlpha = alpha;

    const w = canvas.width / dpr;

    // 1. 顶部 HUD 战术胶囊
    if (aimInfo) {
      const text = aimInfo.title || '第一人称瞄准模式';
      const sub = aimInfo.detail || '';
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      const fullText = '🎯 ' + text + (sub ? '  ·  ' + sub : '');
      const tw = ctx.measureText(fullText).width;
      const bw = Math.max(260, tw + 36);
      const bh = 34;
      const bx = (w - bw) / 2;
      const by = 22;

      roundRectPath(ctx, bx, by, bw, bh, 17);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(fullText, w / 2, by + bh / 2);
    }

    // 2. 光学瞄准准星（目标球击打接触点）
    if (aimInfo?.ghost) {
      const gProj = project(aimInfo.ghost.x, aimInfo.ghost.y, table.ballRadius);
      if (!gProj.behind) {
        const gx = gProj.x;
        const gy = gProj.y;
        const gr = Math.max(9, table.ballRadius * gProj.scale);

        // 环形刻度圈
        ctx.beginPath();
        ctx.arc(gx, gy, gr, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // 准星十字刻度标
        const tick = gr * 0.42;
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.95)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(gx - gr - tick, gy);
        ctx.lineTo(gx - gr + 2, gy);
        ctx.moveTo(gx + gr - 2, gy);
        ctx.lineTo(gx + gr + tick, gy);
        ctx.moveTo(gx, gy - gr - tick);
        ctx.lineTo(gx, gy - gr + 2);
        ctx.moveTo(gx, gy + gr - 2);
        ctx.lineTo(gx, gy + gr + tick);
        ctx.stroke();

        // 中心红点
        ctx.beginPath();
        ctx.arc(gx, gy, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#f59e0b';
        ctx.fill();
      }
    }

    ctx.restore();
  }

  return {
    ctx,
    toPx,
    toWorld,
    project,
    setCamera,
    getCamera,
    drawCueStick,
    draw1stPersonHUD,
    fit,
    clear,
    drawTable,
    drawBall,
    /** 换一张球台。调用方随后必须重新 fit()，否则缩放与偏移还是旧台的。 */
    setTable(next) {
      table = next;
      tableCache = null; // 换台，缓存失效
    },
    get table() {
      return table;
    },
    get scale() {
      return scale;
    },
    get offset() {
      return offset;
    },
  };
}

/** 每颗球的色带角度不同，看起来才不像批量贴图。 */
function stripeAngle(b) {
  const id = String(b.id ?? b.number ?? '');
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ((h % 628) / 100) - Math.PI;
}

function shade(hex, k) {
  const h = String(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}
