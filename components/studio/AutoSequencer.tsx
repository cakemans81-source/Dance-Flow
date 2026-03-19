"use client";

/**
 * AutoSequencer.tsx — 태그 기반 자동 안무 시퀀서
 *
 * 1. genre / tempo 드롭다운으로 후보 필터링
 * 2. "🤖 자동 안무 조합" → DB에서 영상 보유 모션을 랜덤 선별 (3~5개)
 * 3. 캔버스에서 N-clip 연쇄 크로스페이드 미리보기 (RAF 60fps)
 * 4. "✅ 최종 동영상 렌더링 승인 및 추출" → 사용자가 명시적으로 클릭해야만 MediaRecorder 동작
 *
 * 필수 선행 작업 (최초 1회):
 *   A. Supabase 대시보드 → Storage → "dance-videos" 버킷 생성 (Public)
 *   B. SQL Editor: ALTER TABLE motions ADD COLUMN IF NOT EXISTS video_url text;
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { getMotionsWithVideo, type MotionVideoRow } from "@/lib/supabase";

// ── 캔버스 사이즈 (9:16 세로) ────────────────────────────────────────────
const CW = 720;
const CH = 1280;

// ── 태그 파싱 ────────────────────────────────────────────────────────────
function parseTags(name: string) {
  const p = name.split("_");
  return { genre: p[0] ?? "", vibe: p[1] ?? "", tempo: p[2] ?? "", difficulty: p[3] ?? "" };
}

// ── Object-fit cover 드로우 ──────────────────────────────────────────────
function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  alpha: number
) {
  if (!video.videoWidth || !video.videoHeight) return;
  const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
  const dw = video.videoWidth * scale;
  const dh = video.videoHeight * scale;
  ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.globalAlpha = 1;
}

// ── 시퀀스 RAF 엔진 ──────────────────────────────────────────────────────
// returns cancel()
function runSequence(
  vels: HTMLVideoElement[],
  canvas: HTMLCanvasElement,
  crossfade: number,
  onProgress: (clipIdx: number) => void,
  onDone: () => void
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx || vels.length === 0) { onDone(); return () => {}; }

  let clipIdx = 0;
  let crossfading = false;
  let cancelled = false;

  vels[0].currentTime = 0;
  vels[0].play().catch(() => {});

  const tick = () => {
    if (cancelled) return;
    const ci = clipIdx;
    if (ci >= vels.length) { onDone(); return; }

    const cur = vels[ci];
    const next = ci + 1 < vels.length ? vels[ci + 1] : null;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, CW, CH);

    const remaining = isFinite(cur.duration) ? Math.max(0, cur.duration - cur.currentTime) : 9999;

    // 크로스페이드 시작 조건
    if (next && remaining <= crossfade && !crossfading) {
      crossfading = true;
      next.currentTime = 0;
      next.play().catch(() => {});
    }

    if (crossfading && next) {
      const progress = crossfade > 0 ? Math.min(1, 1 - remaining / crossfade) : 1;
      drawCover(ctx, cur, CW, CH, 1 - progress);
      drawCover(ctx, next, CW, CH, progress);
    } else {
      drawCover(ctx, cur, CW, CH, 1);
    }

    // 클립 종료 감지
    if (cur.ended || remaining <= 0.05) {
      clipIdx = ci + 1;
      crossfading = false;
      if (clipIdx >= vels.length) { onDone(); return; }
      onProgress(clipIdx);
    }

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
  return () => { cancelled = true; };
}

// ── 컴포넌트 ─────────────────────────────────────────────────────────────
type Phase = "idle" | "loading" | "ready" | "playing" | "exporting" | "done";

export default function AutoSequencer() {
  // 필터
  const [filterGenre, setFilterGenre] = useState("");
  const [filterTempo, setFilterTempo] = useState("");
  const [targetCount, setTargetCount] = useState(4);
  const [crossfade, setCrossfade] = useState(0.5);

  // 데이터
  const [allMotions, setAllMotions] = useState<MotionVideoRow[]>([]);
  const [selectedClips, setSelectedClips] = useState<MotionVideoRow[]>([]);
  const [currentClipIdx, setCurrentClipIdx] = useState(0);

  // UI 상태
  const [phase, setPhase] = useState<Phase>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [dbLoading, setDbLoading] = useState(true);

  // refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoEls = useRef<HTMLVideoElement[]>([]);
  const cancelRafRef = useRef<(() => void) | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // ── 고유 태그 목록 ────────────────────────────────────────────────────
  const uniqueGenres = [...new Set(allMotions.map((m) => parseTags(m.name).genre).filter(Boolean))];
  const uniqueTempos = [...new Set(allMotions.map((m) => parseTags(m.name).tempo).filter(Boolean))];

  const filteredCandidates = allMotions.filter((m) => {
    const { genre, tempo } = parseTags(m.name);
    if (filterGenre && genre !== filterGenre) return false;
    if (filterTempo && tempo !== filterTempo) return false;
    return true;
  });

  // ── DB 로드 ───────────────────────────────────────────────────────────
  useEffect(() => {
    setDbLoading(true);
    getMotionsWithVideo()
      .then((rows) => setAllMotions(rows))
      .catch((e) => setLoadError(e.message))
      .finally(() => setDbLoading(false));
  }, []);

  // ── cleanup ───────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelRafRef.current?.();
      releaseVideos();
      if (exportUrl) URL.revokeObjectURL(exportUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function releaseVideos() {
    videoEls.current.forEach((v) => { v.pause(); v.src = ""; v.load(); });
    videoEls.current = [];
  }

  // ── 비디오 로드 ───────────────────────────────────────────────────────
  async function loadVideos(clips: MotionVideoRow[]): Promise<HTMLVideoElement[]> {
    return Promise.all(
      clips.map(
        (clip) =>
          new Promise<HTMLVideoElement>((resolve, reject) => {
            const v = document.createElement("video");
            v.src = clip.video_url;
            v.crossOrigin = "anonymous";
            v.preload = "auto";
            const onMeta = () => { v.removeEventListener("loadedmetadata", onMeta); resolve(v); };
            const onErr = () => reject(new Error(`영상 로드 실패: ${clip.name}`));
            v.addEventListener("loadedmetadata", onMeta);
            v.addEventListener("error", onErr);
          })
      )
    );
  }

  // ── 자동 안무 조합 ────────────────────────────────────────────────────
  const handleAutoSelect = useCallback(() => {
    if (filteredCandidates.length === 0) return;
    const shuffled = [...filteredCandidates].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(targetCount, shuffled.length));
    setSelectedClips(picked);
    setCurrentClipIdx(0);
    setPhase("ready");
    setExportUrl(null);
    setLoadError(null);
    cancelRafRef.current?.();
    releaseVideos();
  }, [filteredCandidates, targetCount]);

  // ── 미리보기 재생 ─────────────────────────────────────────────────────
  const handlePlay = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || selectedClips.length === 0) return;
    cancelRafRef.current?.();
    releaseVideos();
    setPhase("loading");
    setLoadError(null);
    setCurrentClipIdx(0);
    try {
      const vels = await loadVideos(selectedClips);
      videoEls.current = vels;
      setPhase("playing");
      cancelRafRef.current = runSequence(
        vels,
        canvas,
        crossfade,
        (idx) => setCurrentClipIdx(idx),
        () => {
          cancelRafRef.current = null;
          setPhase("done");
        }
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "로드 실패");
      setPhase("ready");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClips, crossfade]);

  // ── 재생 중지 ─────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    cancelRafRef.current?.();
    cancelRafRef.current = null;
    videoEls.current.forEach((v) => v.pause());
    setPhase("ready");
  }, []);

  // ── 최종 렌더링 Export (명시적 승인) ─────────────────────────────────
  const handleExport = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || selectedClips.length === 0) return;
    cancelRafRef.current?.();
    releaseVideos();
    if (exportUrl) { URL.revokeObjectURL(exportUrl); setExportUrl(null); }
    setPhase("loading");
    setLoadError(null);
    setCurrentClipIdx(0);

    try {
      const vels = await loadVideos(selectedClips);
      videoEls.current = vels;

      // MediaRecorder 설정 (captureStream은 명시적 승인 후에만 실행)
      const stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30);
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm";
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        setExportUrl(url);
        setPhase("done");
      };

      recorder.start(100);
      setPhase("exporting");

      cancelRafRef.current = runSequence(
        vels,
        canvas,
        crossfade,
        (idx) => setCurrentClipIdx(idx),
        () => {
          cancelRafRef.current = null;
          // 마지막 프레임이 완전히 기록되도록 300ms 대기 후 중지
          setTimeout(() => {
            if (recorderRef.current?.state === "recording") {
              recorderRef.current.stop();
            }
          }, 300);
        }
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "렌더링 실패");
      setPhase("ready");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClips, crossfade, exportUrl]);

  // ── 다운로드 ─────────────────────────────────────────────────────────
  const handleDownload = useCallback(() => {
    if (!exportUrl) return;
    const a = document.createElement("a");
    a.href = exportUrl;
    a.download = `auto_sequence_${Date.now()}.webm`;
    a.click();
  }, [exportUrl]);

  // ── JSX ──────────────────────────────────────────────────────────────
  const isbusy = phase === "loading" || phase === "playing" || phase === "exporting";

  return (
    <div className="flex h-full overflow-hidden bg-[#0a0a0a]">

      {/* 좌측: 컨트롤 */}
      <div className="w-[280px] flex-shrink-0 flex flex-col gap-3 p-4 border-r border-zinc-800 overflow-y-auto">

        {/* 헤더 */}
        <div>
          <h2 className="text-sm font-bold text-zinc-100">🤖 Auto-Sequencer</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">태그 기반 자동 안무 조합 + 크로스페이드</p>
        </div>

        {/* DB 상태 */}
        {dbLoading && (
          <p className="text-[11px] text-zinc-500 animate-pulse">DB 조회 중…</p>
        )}
        {!dbLoading && allMotions.length === 0 && (
          <div className="rounded-lg bg-amber-950/40 border border-amber-800/50 p-3 text-[11px] text-amber-300 leading-relaxed">
            영상 보유 모션이 없습니다.<br />
            Extract 모드에서 영상을 업로드하고 저장하면 자동으로 등록됩니다.
          </div>
        )}

        {/* 필터 */}
        {allMotions.length > 0 && (
          <>
            <Section label="장르 필터">
              <Select value={filterGenre} onChange={setFilterGenre} options={uniqueGenres} placeholder="전체" />
            </Section>

            <Section label="템포 필터">
              <Select value={filterTempo} onChange={setFilterTempo} options={uniqueTempos} placeholder="전체" />
            </Section>

            <Section label={`클립 수 — ${targetCount}개`}>
              <input
                type="range" min={1} max={10} step={1}
                value={targetCount}
                onChange={(e) => setTargetCount(Number(e.target.value))}
                className="w-full accent-violet-500"
                disabled={isbusy}
              />
              <div className="flex justify-between text-[10px] text-zinc-600">
                <span>1</span><span>10</span>
              </div>
            </Section>

            <Section label={`크로스페이드 — ${crossfade.toFixed(1)}s`}>
              <input
                type="range" min={0.1} max={2} step={0.1}
                value={crossfade}
                onChange={(e) => setCrossfade(Number(e.target.value))}
                className="w-full accent-violet-500"
                disabled={isbusy}
              />
              <div className="flex justify-between text-[10px] text-zinc-600">
                <span>0.1s</span><span>2.0s</span>
              </div>
            </Section>

            {/* 후보 수 */}
            <p className="text-[11px] text-zinc-500">
              후보 <span className="text-zinc-300 font-semibold">{filteredCandidates.length}</span>개
              {filterGenre || filterTempo ? ` (전체 ${allMotions.length}개 중)` : ""}
            </p>

            {/* 자동 조합 버튼 */}
            <button
              onClick={handleAutoSelect}
              disabled={filteredCandidates.length === 0 || isbusy}
              className="w-full py-2 rounded-lg text-sm font-semibold bg-violet-700 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              🤖 자동 안무 조합
            </button>
          </>
        )}

        {/* 선택된 클립 목록 */}
        {selectedClips.length > 0 && (
          <Section label="선택된 클립">
            <div className="flex flex-col gap-1">
              {selectedClips.map((clip, i) => {
                const { genre, tempo } = parseTags(clip.name);
                const isActive = phase === "playing" || phase === "exporting"
                  ? i === currentClipIdx
                  : false;
                return (
                  <div
                    key={clip.id}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] transition-colors ${
                      isActive ? "bg-violet-900/60 border border-violet-600" : "bg-zinc-900 border border-zinc-800"
                    }`}
                  >
                    <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 ${
                      isActive ? "bg-violet-500 text-white" : "bg-zinc-700 text-zinc-400"
                    }`}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-zinc-200 truncate">{clip.name}</div>
                      <div className="text-zinc-500">{genre} · {tempo}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* 재생 / 중지 */}
        {selectedClips.length > 0 && (
          <div className="flex gap-2">
            {phase !== "playing" ? (
              <button
                onClick={handlePlay}
                disabled={isbusy || phase === "exporting"}
                className="flex-1 py-2 rounded-lg text-xs font-semibold bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
              >
                {phase === "loading" ? "로드 중…" : "▶ 미리보기"}
              </button>
            ) : (
              <button
                onClick={handleStop}
                className="flex-1 py-2 rounded-lg text-xs font-semibold bg-zinc-700 hover:bg-zinc-600 text-white transition-colors"
              >
                ■ 중지
              </button>
            )}
          </div>
        )}

        {/* 오류 */}
        {loadError && (
          <p className="text-[11px] text-red-400 bg-red-950/40 border border-red-900/40 rounded-lg px-3 py-2">
            {loadError}
          </p>
        )}

        {/* ── Export 승인 버튼 ── */}
        {selectedClips.length > 0 && phase !== "exporting" && (
          <div className="mt-auto pt-3 border-t border-zinc-800">
            <p className="text-[10px] text-zinc-500 mb-2 leading-relaxed">
              아래 버튼을 클릭하면 캔버스 캡처가 시작되고<br />
              전체 시퀀스를 WebM으로 렌더링합니다.
            </p>
            <button
              onClick={handleExport}
              disabled={isbusy}
              className="w-full py-2.5 rounded-lg text-sm font-bold bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              ✅ 최종 동영상 렌더링 승인 및 추출
            </button>
          </div>
        )}

        {/* 렌더링 중 */}
        {phase === "exporting" && (
          <div className="mt-auto pt-3 border-t border-zinc-800">
            <div className="flex items-center gap-2 text-[12px] text-emerald-400">
              <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              렌더링 중… ({currentClipIdx + 1}/{selectedClips.length})
            </div>
          </div>
        )}

        {/* 다운로드 */}
        {exportUrl && phase === "done" && (
          <div className="mt-auto pt-3 border-t border-zinc-800 flex flex-col gap-2">
            <p className="text-[11px] text-emerald-400 font-semibold">✅ 렌더링 완료!</p>
            <button
              onClick={handleDownload}
              className="w-full py-2 rounded-lg text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 text-white transition-colors"
            >
              ⬇ WebM 다운로드
            </button>
          </div>
        )}
      </div>

      {/* 우측: 캔버스 */}
      <div className="flex-1 flex items-center justify-center bg-black overflow-hidden">
        <div className="relative" style={{ height: "100%", aspectRatio: "9/16", maxWidth: "100%" }}>
          <canvas
            ref={canvasRef}
            width={CW}
            height={CH}
            className="h-full w-full object-contain"
          />
          {/* 오버레이 — 대기 상태 */}
          {selectedClips.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-600 pointer-events-none">
              <span className="text-3xl">🎬</span>
              <span className="text-xs">자동 안무 조합 후 재생</span>
            </div>
          )}
          {/* 클립 인디케이터 */}
          {(phase === "playing" || phase === "exporting") && selectedClips.length > 1 && (
            <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-1.5 pointer-events-none">
              {selectedClips.map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${
                    i === currentClipIdx ? "w-6 bg-violet-400" : "w-1.5 bg-zinc-600"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 소형 유틸 컴포넌트 ───────────────────────────────────────────────────
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{label}</span>
      {children}
    </div>
  );
}

function Select({
  value, onChange, options, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500 transition-colors"
    >
      <option value="">{placeholder ?? "전체"}</option>
      {options.map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  );
}
