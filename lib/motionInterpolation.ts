/**
 * motionInterpolation — 관절 좌표 선형 보간(LERP) 엔진
 *
 * 용도: 두 모션 클립을 뚝 끊기지 않게 이어 붙이기 위해
 *       관절(landmark) 좌표를 프레임 단위로 선형 보간한다.
 *
 * 핵심 자료구조: PoseData (lib/supabase.ts)
 *   { meta: PoseMeta, frames: CompactFrame[] }
 *   CompactFrame: { t: number, lm: [[x,y,z,vis], ...] }
 */

import type { CompactFrame, PoseData } from "./supabase";

// ── 기본 수학 ──────────────────────────────────────────────────────────────

/** 스칼라 선형 보간 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** landmark 배열 선형 보간 (element-wise) */
function lerpLandmarks(lm1: number[][], lm2: number[][], t: number): number[][] {
  return lm1.map((l1, i) => {
    const l2 = lm2[i] ?? l1;
    return [
      lerp(l1[0], l2[0], t),
      lerp(l1[1], l2[1], t),
      lerp(l1[2], l2[2], t),
      lerp(l1[3], l2[3], t),
    ];
  });
}

/** CompactFrame 두 프레임 사이를 t(0~1)로 보간 */
function lerpFrame(f1: CompactFrame, f2: CompactFrame, t: number): CompactFrame {
  return {
    t:  lerp(f1.t, f2.t, t),
    lm: lerpLandmarks(f1.lm, f2.lm, t),
  };
}

// ── 공개 API ──────────────────────────────────────────────────────────────

/**
 * PoseData에서 특정 시간(targetTime)의 보간 프레임을 반환한다.
 *
 * - 이진 탐색으로 주변 두 프레임을 O(log n)으로 찾는다.
 * - targetTime이 범위 밖이면 첫/마지막 프레임을 클램프해 반환한다.
 */
export function interpolateAt(poseData: PoseData, targetTime: number): CompactFrame | null {
  const { frames } = poseData;
  if (frames.length === 0) return null;
  if (frames.length === 1 || targetTime <= frames[0].t) return frames[0];
  if (targetTime >= frames[frames.length - 1].t)        return frames[frames.length - 1];

  // 이진 탐색: targetTime을 기준으로 [lo, hi] 구간 압축
  let lo = 0, hi = frames.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= targetTime) lo = mid;
    else                              hi = mid;
  }

  const f1 = frames[lo];
  const f2 = frames[hi];
  const t  = (targetTime - f1.t) / (f2.t - f1.t); // 0~1 정규화
  return lerpFrame(f1, f2, t);
}

/**
 * 두 PoseData 클립을 blendDuration(초) 구간 동안 크로스페이드 이어 붙이기.
 *
 * 반환값: 이음새가 부드럽게 연결된 단일 PoseData
 *
 * 동작:
 *   [clipA 전체] → [blendDuration 구간: A·(1-t) + B·t LERP] → [clipB 나머지]
 */
export function blendClips(
  clipA: PoseData,
  clipB: PoseData,
  blendDuration = 0.5, // seconds
): PoseData {
  const fps   = clipA.meta.fps;
  const dt    = 1 / fps;
  const durA  = clipA.meta.duration;
  const durB  = clipB.meta.duration;

  const outFrames: CompactFrame[] = [];
  let t = 0;

  // 1. clipA 전체 (blendDuration 이전까지 원본, 이후 LERP 시작)
  const blendStartA = Math.max(0, durA - blendDuration);
  for (; t <= durA + 1e-9; t = parseFloat((t + dt).toFixed(6))) {
    const frameA = interpolateAt(clipA, t);
    if (!frameA) break;

    if (t < blendStartA) {
      // 순수 clipA 구간
      outFrames.push({ t, lm: frameA.lm });
    } else {
      // LERP 구간: clipA 끝 ↔ clipB 시작
      const blendT  = (t - blendStartA) / blendDuration; // 0→1
      const frameB  = interpolateAt(clipB, t - blendStartA);
      if (!frameB) { outFrames.push({ t, lm: frameA.lm }); continue; }
      outFrames.push({ t, lm: lerpLandmarks(frameA.lm, frameB.lm, blendT) });
    }
  }

  // 2. clipB 나머지 (blendDuration 이후)
  const clipBOffset = durA; // clipB 시작 시각 = clipA 끝
  for (let tb = blendDuration + dt; tb <= durB + 1e-9; tb = parseFloat((tb + dt).toFixed(6))) {
    const frameB = interpolateAt(clipB, tb);
    if (!frameB) break;
    outFrames.push({ t: clipBOffset + tb, lm: frameB.lm });
  }

  const totalDuration = outFrames.length > 1
    ? outFrames[outFrames.length - 1].t - outFrames[0].t
    : 0;

  return {
    meta: {
      fps,
      frameCount:    outFrames.length,
      duration:      parseFloat(totalDuration.toFixed(3)),
      capturedAt:    new Date().toISOString(),
      landmarkCount: clipA.meta.landmarkCount,
    },
    frames: outFrames,
  };
}

/**
 * CompactFrame → MotionFrame 역변환
 * (재생 엔진이 기존 MotionFrame[] 형식을 요구할 때 사용)
 */
export function compactToMotionFrames(
  frames: CompactFrame[],
): Array<{ time: number; landmarks: Array<{ x: number; y: number; z: number; visibility: number }> }> {
  return frames.map((f) => ({
    time:      f.t,
    landmarks: f.lm.map(([x, y, z, visibility]) => ({ x, y, z, visibility })),
  }));
}
