"use client";

/**
 * MotionMixer — LERP 기반 모션 블렌딩 + 캔버스 재생 + WebM 추출
 *
 * 흐름:
 *   DB에서 Clip A / B 선택 → pose_data 로드 → blendClips() →
 *   RAF로 skeleton 60fps 렌더 → MediaRecorder로 WebM 추출
 */

import {
  useRef, useState, useEffect, useCallback,
} from "react";
import {
  getMotionSummaries, getPoseDataById, getMotionById, buildPoseData,
  type MotionSummary, type PoseData,
} from "@/lib/supabase";
import { blendClips, interpolateAt } from "@/lib/motionInterpolation";
import type { CompactFrame } from "@/lib/supabase";

// ── 캔버스 해상도 ─────────────────────────────────────────────────────────
// 녹화·재생 모두 이 해상도를 사용 (MediaRecorder 캡처 대상)
const CANVAS_W = 480;
const CANVAS_H = 640;


// ── ControlNet OpenPose 표준 컬러 스키마 ──────────────────────────────────
// Kling AI가 인식하는 DWPose/OpenPose ControlNet 훈련 포맷
//
// 색상 기준 (업계 표준):
//   머리 (코·눈·귀)          : #FF0000 빨강
//   몸통 (어깨↔어깨, 골반↔골반, 어깨↔골반) : #FF00FF 마젠타
//   오른팔 (어깨→팔꿈치→손목) : #00FF00 초록
//   왼팔  (어깨→팔꿈치→손목) : #0000FF 파랑
//   오른다리 (골반→무릎→발목) : #FFFF00 노랑
//   왼다리  (골반→무릎→발목) : #00FFFF 시안
//
// lineWidth 10 — 표준 OpenPose 두께 (너무 얇지도 두껍지도 않음)

const OPENPOSE_CONNECTIONS: [number, number, string][] = [
  // 머리 — 빨강
  [0, 1], [1, 2], [2, 3], [3, 7],   // 코→왼눈 내→왼눈→왼눈 외→왼귀
  [0, 4], [4, 5], [5, 6], [6, 8],   // 코→오른눈 내→오른눈→오른눈 외→오른귀

  // 몸통 — 마젠타
  [11, 12], [23, 24], [11, 23], [12, 24],

  // 오른팔 — 초록  (MediaPipe: 12=오른어깨, 14=오른팔꿈치, 16=오른손목)
  [12, 14], [14, 16],

  // 왼팔 — 파랑   (MediaPipe: 11=왼어깨, 13=왼팔꿈치, 15=왼손목)
  [11, 13], [13, 15],

  // 오른다리 — 노랑  (24=오른골반, 26=오른무릎, 28=오른발목)
  [24, 26], [26, 28],

  // 왼다리 — 시안   (23=왼골반, 25=왼무릎, 27=왼발목)
  [23, 25], [25, 27],
].map(([a, b], i) => {
  // 인덱스 범위로 색상 자동 매핑
  const color =
    i < 8  ? "#FF0000" :  // 머리 (0~7)
    i < 12 ? "#FF00FF" :  // 몸통 (8~11)
    i < 14 ? "#00FF00" :  // 오른팔 (12~13)
    i < 16 ? "#0000FF" :  // 왼팔 (14~15)
    i < 18 ? "#FFFF00" :  // 오른다리 (16~17)
             "#00FFFF";   // 왼다리 (18~19)
  return [a, b, color] as [number, number, string];
});

// 랜드마크별 색상 (관절 점)
const JOINT_COLOR: Record<number, string> = {
  0:1,1:1,2:1,3:1,4:1,5:1,6:1,7:1,8:1,  // 머리
  11:2,12:2,23:2,24:2,                    // 몸통
  13:4,15:4,                              // 왼팔
  14:3,16:3,                              // 오른팔
  25:6,27:6,                             // 왼다리
  26:5,28:5,                             // 오른다리
} as unknown as Record<number, string>;

const JOINT_COLORS = ["", "#FF0000","#FF00FF","#00FF00","#0000FF","#FFFF00","#00FFFF"];

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  frame: CompactFrame,
) {
  // 완전한 검은 배경
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);

  const lm = frame.lm;
  if (!lm || lm.length < 33) return;

  const px  = (i: number) => lm[i][0] * w;
  const py  = (i: number) => lm[i][1] * h;
  const vis = (i: number) => lm[i]?.[3] ?? 0;

  ctx.lineCap  = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 10;

  // ── OpenPose 컬러 연결선
  for (const [a, b, color] of OPENPOSE_CONNECTIONS) {
    if (vis(a) < 0.3 || vis(b) < 0.3) continue;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.moveTo(px(a), py(a));
    ctx.lineTo(px(b), py(b));
    ctx.stroke();
  }

  // ── 관절 점 (연결선 위에 덧그림)
  for (const [idxStr, colorIdx] of Object.entries(JOINT_COLOR)) {
    const i = Number(idxStr);
    if (vis(i) < 0.3) continue;
    ctx.beginPath();
    ctx.fillStyle = JOINT_COLORS[colorIdx as unknown as number];
    ctx.arc(px(i), py(i), 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── pose_data 로드 (구형 레코드 폴백) ─────────────────────────────────────
async function loadPoseData(id: string): Promise<PoseData> {
  const pd = await getPoseDataById(id);
  if (pd) return pd;
  // pose_data 컬럼 없는 구형 모션 → motion_data에서 변환
  const row = await getMotionById(id);
  return buildPoseData(row.motion_data);
}

// ── 시간 포맷 ─────────────────────────────────────────────────────────────
function fmtSec(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

// ══════════════════════════════════════════════════════════════════════════
export default function MotionMixer() {
  // ── 모션 목록 ─────────────────────────────────────────────────────────
  const [motions, setMotions] = useState<MotionSummary[]>([]);

  // ── 클립 선택 ─────────────────────────────────────────────────────────
  const [clipAId, setClipAId] = useState("");
  const [clipBId, setClipBId] = useState("");
  const [blendSec, setBlendSec] = useState(0.5);

  // ── 블렌딩 결과 ───────────────────────────────────────────────────────
  const [blendedPose, setBlendedPose] = useState<PoseData | null>(null);
  const [blendError,  setBlendError]  = useState<string | null>(null);
  const [blending,    setBlending]    = useState(false);

  // ── 재생 상태 ─────────────────────────────────────────────────────────
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [elapsed,     setElapsed]     = useState(0); // seconds

  // ── 녹화 상태 ─────────────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const rafRef         = useRef<number>(0);
  const playStartRef   = useRef<number>(0); // performance.now()
  const recorderRef    = useRef<MediaRecorder | null>(null);
  const chunksRef      = useRef<BlobPart[]>([]);
  const blendedPoseRef = useRef<PoseData | null>(null); // RAF에서 stale-closure 방지

  // ── 초기 모션 목록 로드 ───────────────────────────────────────────────
  useEffect(() => {
    getMotionSummaries(100).then(setMotions).catch(console.error);
  }, []);

  // ── 언마운트 시 RAF + 녹화 정리 ───────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    };
  }, []);

  // ── RAF 루프 (재생·녹화 공통) ─────────────────────────────────────────
  const startRAF = useCallback((pose: PoseData, once = false) => {
    blendedPoseRef.current = pose;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const firstT   = pose.frames[0]?.t ?? 0;
    const duration = pose.meta.duration;
    playStartRef.current = performance.now();

    const tick = () => {
      const elSec = (performance.now() - playStartRef.current) / 1000;
      setElapsed(Math.min(elSec, duration));

      if (once && elSec >= duration) {
        // 단일 재생 완료 → 녹화 종료
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
        cancelAnimationFrame(rafRef.current);
        setIsPlaying(false);
        return;
      }

      const loopedT = firstT + (once ? elSec : elSec % duration);
      const frame   = interpolateAt(blendedPoseRef.current!, loopedT);
      if (frame) drawSkeleton(ctx, CANVAS_W, CANVAS_H, frame);

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    setIsPlaying(true);
  }, []);

  const stopRAF = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    setIsPlaying(false);
    setElapsed(0);
    // 캔버스 초기화
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  }, []);

  // ── 블렌딩 실행 ───────────────────────────────────────────────────────
  const handleBlend = useCallback(async () => {
    if (!clipAId || !clipBId) return;
    if (clipAId === clipBId) { setBlendError("서로 다른 클립을 선택하세요."); return; }

    stopRAF();
    setBlending(true);
    setBlendError(null);
    setBlendedPose(null);

    try {
      const [poseA, poseB] = await Promise.all([
        loadPoseData(clipAId),
        loadPoseData(clipBId),
      ]);
      const result = blendClips(poseA, poseB, blendSec);
      setBlendedPose(result);
      blendedPoseRef.current = result;
      startRAF(result);          // 블렌딩 완료 → 즉시 미리보기 시작
    } catch (e) {
      setBlendError(e instanceof Error ? e.message : String(e));
    } finally {
      setBlending(false);
    }
  }, [clipAId, clipBId, blendSec, startRAF, stopRAF]);

  // ── WebM 녹화 추출 ────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    const pose   = blendedPoseRef.current;
    const canvas = canvasRef.current;
    if (!pose || !canvas) return;

    stopRAF(); // 기존 루프 중단

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";

    const stream   = canvas.captureStream(60);
    const recorder = new MediaRecorder(stream, { mimeType });
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: "video/webm" });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement("a"), {
        href:     url,
        download: `blended_${clipAId.slice(0,4)}_${clipBId.slice(0,4)}.webm`,
      });
      a.click();
      URL.revokeObjectURL(url);
      setIsRecording(false);
      setElapsed(0);
    };

    recorder.start();
    recorderRef.current = recorder;
    setIsRecording(true);

    // 애니메이션을 처음부터 1회만 재생하며 녹화
    startRAF(pose, /* once= */ true);
  }, [startRAF, stopRAF, clipAId, clipBId]);

  // ── 미리보기 토글 ─────────────────────────────────────────────────────
  const handlePreviewToggle = useCallback(() => {
    if (isPlaying) { stopRAF(); }
    else if (blendedPoseRef.current) { startRAF(blendedPoseRef.current); }
  }, [isPlaying, startRAF, stopRAF]);

  // ── 모션 옵션 렌더 ────────────────────────────────────────────────────
  const motionOptions = motions.map((m) => (
    <option key={m.id} value={m.id}>{m.name}</option>
  ));

  const blendedDuration = blendedPose?.meta.duration ?? 0;

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a] overflow-hidden">
      {/* ── 헤더 ──────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 pt-5 pb-3 border-b border-zinc-800">
        <h2 className="text-sm font-bold text-zinc-100 tracking-tight">
          🎭 Motion Mixer
        </h2>
        <p className="text-xs text-zinc-500 mt-0.5">두 모션을 LERP 블렌딩해 부드럽게 이어 붙입니다</p>
      </div>

      {/* ── 컨트롤 영역 ───────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 py-4 flex flex-col gap-4 border-b border-zinc-800">
        {/* 클립 선택 */}
        <div className="grid grid-cols-2 gap-3">
          {/* Clip A */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-violet-400">
              Clip A
            </label>
            <select
              value={clipAId}
              onChange={(e) => setClipAId(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-violet-500 transition-colors"
            >
              <option value="">— 선택 —</option>
              {motionOptions}
            </select>
          </div>

          {/* Clip B */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-pink-400">
              Clip B
            </label>
            <select
              value={clipBId}
              onChange={(e) => setClipBId(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-pink-500 transition-colors"
            >
              <option value="">— 선택 —</option>
              {motionOptions}
            </select>
          </div>
        </div>

        {/* 블렌드 슬라이더 */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              크로스페이드 전환
            </label>
            <span className="text-xs font-mono text-violet-300">{blendSec.toFixed(1)}s</span>
          </div>
          <input
            type="range"
            min={0.1} max={1.0} step={0.1}
            value={blendSec}
            onChange={(e) => setBlendSec(parseFloat(e.target.value))}
            className="w-full accent-violet-500 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] text-zinc-600">
            <span>0.1s</span><span>1.0s</span>
          </div>
        </div>

        {/* 실행 버튼 열 */}
        <div className="flex gap-2">
          <button
            onClick={handleBlend}
            disabled={!clipAId || !clipBId || blending}
            className="flex-1 py-2 rounded-lg text-xs font-semibold bg-violet-700 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex items-center justify-center gap-1.5"
          >
            {blending ? (
              <><svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>블렌딩 중…</>
            ) : "▶️ 블렌딩 미리보기"}
          </button>

          {blendedPose && (
            <button
              onClick={handlePreviewToggle}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
          )}
        </div>

        {/* 에러 */}
        {blendError && (
          <p className="text-xs text-red-400">❌ {blendError}</p>
        )}
      </div>

      {/* ── 캔버스 영역 ───────────────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center bg-black relative overflow-hidden">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="max-w-full max-h-full object-contain"
          style={{ background: "#000" }}
        />

        {/* 타임코드 오버레이 */}
        {(isPlaying || isRecording) && blendedDuration > 0 && (
          <div className="absolute bottom-3 right-3 bg-black/70 rounded px-2 py-0.5 text-[10px] font-mono text-zinc-300">
            {fmtSec(elapsed)} / {fmtSec(blendedDuration)}
            {isRecording && <span className="ml-2 text-red-400 animate-pulse">● REC</span>}
          </div>
        )}

        {!blendedPose && !blending && (
          <p className="absolute text-xs text-zinc-600 select-none">
            클립을 선택하고 블렌딩을 실행하세요
          </p>
        )}
      </div>

      {/* ── 추출 버튼 ─────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 py-4 border-t border-zinc-800">
        <button
          onClick={handleExport}
          disabled={!blendedPose || isRecording}
          className="w-full py-2.5 rounded-lg text-xs font-semibold bg-emerald-800 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex items-center justify-center gap-2"
        >
          {isRecording ? (
            <><svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
            </svg>녹화 중… ({fmtSec(elapsed)})</>
          ) : "💾 통합 모션 WebM 추출"}
        </button>
        {blendedPose && (
          <p className="text-[10px] text-zinc-600 text-center mt-1.5">
            총 {fmtSec(blendedPose.meta.duration)} · {blendedPose.meta.frameCount}프레임 · {blendedPose.meta.fps}fps
          </p>
        )}
      </div>
    </div>
  );
}
