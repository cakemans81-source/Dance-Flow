/**
 * lib/supabase.ts — Supabase 클라이언트 싱글톤
 *
 * 환경 변수 설정 방법:
 *  1. 프로젝트 루트에 .env.local 파일 생성
 *  2. 아래 두 줄 추가:
 *       NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
 *       NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *  3. 값은 Supabase 대시보드 → Project Settings → API에서 확인
 *
 * Supabase 테이블 스키마 (SQL Editor에서 실행):
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │  CREATE TABLE motions (                                             │
 *  │    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,          │
 *  │    name        text NOT NULL,                                       │
 *  │    motion_data jsonb NOT NULL,                                      │
 *  │    created_at  timestamptz DEFAULT now()                            │
 *  │  );                                                                 │
 *  │                                                                     │
 *  │  -- pose_data 컬럼 추가 (기존 테이블에 적용):                         │
 *  │  ALTER TABLE motions                                                │
 *  │    ADD COLUMN IF NOT EXISTS pose_data jsonb;                        │
 *  └─────────────────────────────────────────────────────────────────────┘
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// DB 행 타입 — motion_data는 녹화 프레임 배열
export type MotionRow = {
  id?: string;
  name: string;
  motion_data: MotionData;
  created_at?: string;
};

export type LandmarkPoint = {
  x: number;
  y: number;
  z: number;
  visibility: number;
};

export type MotionFrame = {
  time: number;
  landmarks: LandmarkPoint[];
};

export type MotionData = MotionFrame[];

// ── LERP용 압축 포즈 데이터 ────────────────────────────────────────────────
// motion_data(구형)와 별도로 pose_data 컬럼에 저장한다.
//
// 설계 원칙:
//   - lm: number[][] — 오브젝트 키 제거로 storage 약 8배 절약
//     형식: [[x, y, z, visibility], ...] (MediaPipe 33 landmarks)
//   - t: number — 초 단위 타임스탬프 (LERP 연산의 기준축)
//   - meta — fps/duration을 미리 계산해 LERP 시 재계산 불필요
//
// 예상 크기: 30s 녹화 × 10fps × 33 lm × 4값 = 약 48 KB (JSON 압축 후)
export type CompactFrame = {
  t:  number;       // timestamp (seconds)
  lm: number[][];   // [[x, y, z, vis], …] per landmark
};

export type PoseMeta = {
  fps:        number;   // 평균 캡처 FPS
  frameCount: number;
  duration:   number;   // seconds (lastFrame.t - firstFrame.t)
  capturedAt: string;   // ISO 8601
  landmarkCount: number; // 33 (MediaPipe Pose)
};

export type PoseData = {
  meta:   PoseMeta;
  frames: CompactFrame[];
};

/**
 * MotionFrame[] → PoseData 변환
 * ControlPanel의 저장 직전에 호출해 메타데이터를 함께 계산한다.
 */
export function buildPoseData(frames: MotionFrame[]): PoseData {
  const frameCount = frames.length;
  const first = frames[0];
  const last  = frames[frameCount - 1];
  const duration = frameCount > 1 ? parseFloat((last.time - first.time).toFixed(3)) : 0;
  const fps = duration > 0 ? Math.round(frameCount / duration) : 10;

  return {
    meta: {
      fps,
      frameCount,
      duration,
      capturedAt:    new Date().toISOString(),
      landmarkCount: first?.landmarks.length ?? 33,
    },
    frames: frames.map((f) => ({
      t:  f.time,
      lm: f.landmarks.map((l) => [l.x, l.y, l.z, l.visibility]),
    })),
  };
}

// ── 싱글톤 패턴 ───────────────────────────────────────────────────────────
// 모듈이 로드될 때 즉시 throw하면 env 미설정 시 빌드가 깨진다.
// getSupabase()를 첫 호출 시점에 초기화해 런타임에만 검증한다.
let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "[Supabase] 환경 변수가 설정되지 않았습니다.\n" +
        ".env.local 에 NEXT_PUBLIC_SUPABASE_URL 과 NEXT_PUBLIC_SUPABASE_ANON_KEY 를 추가하세요."
    );
  }

  _client = createClient(url, key);
  return _client;
}

// ── 모션 저장 함수 ─────────────────────────────────────────────────────────
export async function saveMotion(
  name: string,
  motionData: MotionData,
  poseData?: PoseData,   // 압축 LERP 데이터 (pose_data 컬럼, optional)
): Promise<{ id: string }> {
  const supabase = getSupabase();

  const payload: Record<string, unknown> = { name, motion_data: motionData };
  if (poseData) payload.pose_data = poseData;

  const { data, error } = await supabase
    .from("motions")
    .insert(payload)
    .select("id")
    .single();

  if (error) {
    throw new Error(`[Supabase Insert] ${error.message} (code: ${error.code})`);
  }

  return { id: data.id };
}

// ── 최근 모션 목록 조회 ───────────────────────────────────────────────────
export type MotionSummary = {
  id: string;
  name: string;
  created_at: string;
};

export async function getRecentMotions(limit = 3): Promise<MotionSummary[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("motions")
    .select("id, name, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`[Supabase Query] ${error.message} (code: ${error.code})`);
  }

  return data ?? [];
}

// ── 디렉팅 모드용 전체 목록 조회 ─────────────────────────────────────────
export async function getMotionSummaries(limit = 50): Promise<MotionSummary[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("motions")
    .select("id, name, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`[Supabase Query] ${error.message} (code: ${error.code})`);
  }

  return data ?? [];
}

// ── 모션 삭제 ─────────────────────────────────────────────────────────────
export async function deleteMotion(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("motions").delete().eq("id", id);
  if (error) {
    throw new Error(`[Supabase Delete] ${error.message} (code: ${error.code})`);
  }
}

// ── 모션 전체 데이터 단건 조회 (motion_data 포함) ────────────────────────
export async function getMotionById(
  id: string
): Promise<MotionRow & { id: string }> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("motions")
    .select("id, name, motion_data, created_at")
    .eq("id", id)
    .single();

  if (error) {
    throw new Error(`[Supabase Query] ${error.message} (code: ${error.code})`);
  }

  return data;
}
