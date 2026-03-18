"use client";

/**
 * MotionMixer — 원본 영상 크로스페이드 편집기
 *
 * 흐름:
 *   Clip A + B 업로드 → 전환 구간 설정 →
 *   RAF 60fps 크로스페이드 캔버스 렌더 → MediaRecorder WebM 추출
 *
 * 재생 3단계:
 *   Phase A    : Clip A 단독 재생 (globalAlpha = 1)
 *   Phase fade : A(1→0) + B(0→1) 동시 렌더 (크로스페이드)
 *   Phase B    : Clip B 단독 재생 (globalAlpha = 1)
 *
 * 설계 포인트:
 *   - <video> 2개를 DOM 밖에 생성 → drawImage 소스로만 사용 (CORS 무관)
 *   - object-fit: cover 수식으로 해상도/비율 불일치 자동 크롭
 *   - URL.revokeObjectURL로 메모리 누수 방지
 */

import { useRef, useState, useEffect, useCallback } from "react";

// ── 캔버스 해상도 (9:16 세로, Kling AI 권장 비율) ────────────────────────────
const CANVAS_W = 720;
const CANVAS_H = 1280;

// ── object-fit: cover 효과 ────────────────────────────────────────────────────
// 영상 원본 비율을 유지하면서 캔버스를 꽉 채움 (넘치는 부분은 잘림)
function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  alpha: number,
) {
  if (alpha <= 0 || !video.videoWidth || !video.videoHeight) return;
  const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
  const dw = video.videoWidth  * scale;
  const dh = video.videoHeight * scale;
  ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.globalAlpha = 1;
}

function fmtSec(s: number) {
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

type Phase = "idle" | "A" | "fade" | "B";

// ── DropZone (컴포넌트 외부 정의 → 재마운트 방지) ───────────────────────────
function DropZone({
  which, file, onFile,
}: {
  which: "A" | "B";
  file: File | null;
  onFile: (which: "A" | "B", f: File) => void;
}) {
  return (
    <label
      className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed
        cursor-pointer transition-colors h-24
        ${file
          ? "border-violet-500 bg-violet-950/30"
          : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f?.type.startsWith("video/")) onFile(which, f);
      }}
    >
      <input
        type="file" accept="video/*" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(which, f);
          e.target.value = "";
        }}
      />
      {file ? (
        <>
          <span className="text-xs font-semibold text-violet-300 truncate max-w-full px-2">{file.name}</span>
          <span className="text-[10px] text-zinc-500">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
        </>
      ) : (
        <>
          <span className="text-xl">{which === "A" ? "🎬" : "🎞️"}</span>
          <span className="text-xs text-zinc-500">Clip {which} 드롭 또는 클릭</span>
        </>
      )}
    </label>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
export default function MotionMixer() {
  // ── 파일 상태 ─────────────────────────────────────────────────────────────
  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [blendSec, setBlendSec] = useState(0.5);

  // ── 재생·녹화 상태 ────────────────────────────────────────────────────────
  const [phase,       setPhase]       = useState<Phase>("idle");
  const [elapsed,     setElapsed]     = useState(0);
  const [isRecording, setIsRecording] = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const videoARef    = useRef<HTMLVideoElement | null>(null);
  const videoBRef    = useRef<HTMLVideoElement | null>(null);
  const urlARef      = useRef<string | null>(null);
  const urlBRef      = useRef<string | null>(null);
  const rafRef       = useRef<number>(0);
  const phaseRef     = useRef<Phase>("idle");
  const fadeStartRef = useRef<number>(0); // performance.now() 기준
  const blendSecRef  = useRef(blendSec);
  const recorderRef  = useRef<MediaRecorder | null>(null);
  const chunksRef    = useRef<BlobPart[]>([]);

  useEffect(() => { blendSecRef.current = blendSec; }, [blendSec]);

  // ── 비디오 엘리먼트 생성 (마운트 1회, DOM 미삽입) ────────────────────────
  useEffect(() => {
    const make = () => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      return v;
    };
    const vA = make();
    const vB = make();
    videoARef.current = vA;
    videoBRef.current = vB;

    return () => {
      cancelAnimationFrame(rafRef.current);
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      vA.pause(); vA.src = "";
      vB.pause(); vB.src = "";
      if (urlARef.current) URL.revokeObjectURL(urlARef.current);
      if (urlBRef.current) URL.revokeObjectURL(urlBRef.current);
    };
  }, []);

  // ── 파일 설정 ─────────────────────────────────────────────────────────────
  const handleFile = useCallback((which: "A" | "B", file: File) => {
    const urlRef = which === "A" ? urlARef : urlBRef;
    const vidRef = which === "A" ? videoARef : videoBRef;

    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(file);
    urlRef.current = url;
    if (vidRef.current) { vidRef.current.src = url; vidRef.current.load(); }

    if (which === "A") setFileA(file); else setFileB(file);

    // 진행 중 재생 중단
    cancelAnimationFrame(rafRef.current);
    phaseRef.current = "idle";
    setPhase("idle");
    setElapsed(0);
  }, []);

  // ── 재생 중단 ─────────────────────────────────────────────────────────────
  const stopPlayback = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    videoARef.current?.pause();
    videoBRef.current?.pause();
    phaseRef.current = "idle";
    setPhase("idle");
    setElapsed(0);
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H); }
  }, []);

  // ── 재생 시작 ─────────────────────────────────────────────────────────────
  const startPlayback = useCallback((record = false) => {
    const vA = videoARef.current;
    const vB = videoBRef.current;
    const canvas = canvasRef.current;
    if (!vA || !vB || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    cancelAnimationFrame(rafRef.current);
    vA.pause(); vA.currentTime = 0;
    vB.pause(); vB.currentTime = 0;

    phaseRef.current = "A";
    setPhase("A");
    setElapsed(0);

    const launch = () => {
      vA.play().catch(console.warn);

      const tick = () => {
        // ── 배경 ──────────────────────────────────────────────────────────
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        const ph = phaseRef.current;

        if (ph === "A") {
          // ─ Phase A: Clip A 단독 재생 ────────────────────────────────────
          drawCover(ctx, vA, CANVAS_W, CANVAS_H, 1);
          setElapsed(vA.currentTime);

          const blendDur = blendSecRef.current;
          const timeLeft = (vA.duration || 0) - vA.currentTime;

          // A 종료 blendDur 전 → B 시작 + 페이드 전환
          if ((timeLeft <= blendDur && timeLeft >= 0) || vA.ended) {
            vB.play().catch(console.warn);
            phaseRef.current = "fade";
            setPhase("fade");
            fadeStartRef.current = performance.now();
          }

        } else if (ph === "fade") {
          // ─ Phase fade: A 투명 → B 불투명 크로스페이드 ──────────────────
          const blendDur = blendSecRef.current;
          const prog     = Math.min(
            (performance.now() - fadeStartRef.current) / (blendDur * 1000),
            1,
          );
          drawCover(ctx, vA, CANVAS_W, CANVAS_H, 1 - prog);
          drawCover(ctx, vB, CANVAS_W, CANVAS_H, prog);

          if (prog >= 1) {
            vA.pause();
            phaseRef.current = "B";
            setPhase("B");
          }

        } else if (ph === "B") {
          // ─ Phase B: Clip B 단독 재생 ────────────────────────────────────
          drawCover(ctx, vB, CANVAS_W, CANVAS_H, 1);
          setElapsed(vB.currentTime);

          if (vB.ended) {
            cancelAnimationFrame(rafRef.current);
            if (record && recorderRef.current?.state === "recording") {
              recorderRef.current.stop();
            }
            phaseRef.current = "idle";
            setPhase("idle");
            setIsRecording(false);
            return;
          }
        }

        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    };

    // 영상 메타데이터 준비 확인 후 시작
    if (vA.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      launch();
    } else {
      vA.addEventListener("canplay", launch, { once: true });
    }
  }, []);

  // ── WebM 추출 ─────────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !fileA || !fileB) return;

    stopPlayback();

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
      Object.assign(document.createElement("a"), {
        href: url, download: "crossfade_mix.webm",
      }).click();
      URL.revokeObjectURL(url);
      setIsRecording(false);
    };

    recorder.start();
    recorderRef.current = recorder;
    setIsRecording(true);
    startPlayback(/* record= */ true);
  }, [fileA, fileB, startPlayback, stopPlayback]);

  const canPreview = !!fileA && !!fileB;

  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="h-full flex flex-col bg-[#0a0a0a] overflow-hidden">

      {/* ── 헤더 ──────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 pt-5 pb-3 border-b border-zinc-800">
        <h2 className="text-sm font-bold text-zinc-100 tracking-tight">
          🎭 Video CrossFade Mixer
        </h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          원본 영상 두 개를 자연스럽게 크로스페이드로 이어 붙입니다
        </p>
      </div>

      {/* ── 컨트롤 ────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 py-4 flex flex-col gap-4 border-b border-zinc-800">

        {/* 업로드 존 */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-400 mb-1.5">
              Clip A (앞)
            </p>
            <DropZone which="A" file={fileA} onFile={handleFile} />
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-pink-400 mb-1.5">
              Clip B (뒤)
            </p>
            <DropZone which="B" file={fileB} onFile={handleFile} />
          </div>
        </div>

        {/* 크로스페이드 슬라이더 */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              크로스페이드 전환 구간
            </label>
            <span className="text-xs font-mono text-violet-300">{blendSec.toFixed(1)}s</span>
          </div>
          <input
            type="range" min={0.1} max={2.0} step={0.1}
            value={blendSec}
            onChange={(e) => setBlendSec(parseFloat(e.target.value))}
            className="w-full accent-violet-500 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] text-zinc-600">
            <span>0.1s</span><span>2.0s</span>
          </div>
        </div>

        {/* 미리보기 토글 */}
        <button
          onClick={() => phase === "idle" ? startPlayback() : stopPlayback()}
          disabled={!canPreview}
          className="w-full py-2 rounded-lg text-xs font-semibold
            bg-violet-700 hover:bg-violet-600
            disabled:opacity-40 disabled:cursor-not-allowed
            text-white transition-colors"
        >
          {phase === "idle" ? "▶ 미리보기" : "⏹ 정지"}
        </button>
      </div>

      {/* ── 캔버스 ────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center bg-black relative overflow-hidden">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="max-w-full max-h-full object-contain"
          style={{ background: "#000" }}
        />

        {/* 재생 상태 오버레이 */}
        {phase !== "idle" && (
          <div className="absolute bottom-3 right-3 bg-black/70 rounded px-2 py-1
            text-[10px] font-mono text-zinc-300 flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${
              phase === "A"    ? "bg-violet-400" :
              phase === "fade" ? "bg-yellow-400 animate-pulse" :
                                 "bg-pink-400"
            }`} />
            {phase === "A"    ? `Clip A 재생 · ${fmtSec(elapsed)}` :
             phase === "fade" ? "크로스페이드 전환 중…" :
                                `Clip B 재생 · ${fmtSec(elapsed)}`}
            {isRecording && <span className="ml-1 text-red-400 animate-pulse">● REC</span>}
          </div>
        )}

        {!canPreview && phase === "idle" && (
          <p className="absolute text-xs text-zinc-600 select-none">
            Clip A · B 영상을 모두 업로드하세요
          </p>
        )}
      </div>

      {/* ── 추출 버튼 ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 py-4 border-t border-zinc-800">
        <button
          onClick={handleExport}
          disabled={!canPreview || isRecording || phase !== "idle"}
          className="w-full py-2.5 rounded-lg text-xs font-semibold
            bg-emerald-800 hover:bg-emerald-700
            disabled:opacity-40 disabled:cursor-not-allowed
            text-white transition-colors flex items-center justify-center gap-2"
        >
          {isRecording ? (
            <>
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
              녹화 중…
            </>
          ) : "💾 CrossFade WebM 추출"}
        </button>
        <p className="text-[10px] text-zinc-600 text-center mt-1.5">
          A 전체 → 크로스페이드 → B 전체 · 전 구간 자동 녹화
        </p>
      </div>

    </div>
  );
}
