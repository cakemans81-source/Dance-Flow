"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import VideoPlayer from "./VideoPlayer";
import TimelineEditor, { type Segment } from "./TimelineEditor";
import RecordingControls from "./RecordingControls";
import MotionLibrary from "./MotionLibrary";
import {
  saveMotion,
  buildPoseData,
  getMotionSummaries,
  getMotionById,
  type MotionFrame,
  type MotionSummary,
} from "@/lib/supabase";
import { extractGridThumbnails, extractAudio } from "@/lib/videoUtils";
import type { Landmark3D } from "@/hooks/usePose";
import type { CaptureBackground } from "./PoseCanvas3D";

type SaveStatus = "idle" | "saving" | "success" | "error";
type Mode = "extract" | "direct" | "toolbox";
type EffectType = "bounce" | "wider_arms";

type TimelineEffect = {
  id: string;
  startTime: number; // 초
  endTime: number;   // 초
  type: EffectType;
  intensity: number; // 0.0 ~ 2.0
};

// ── Auto-Mix: 자동 조립된 단일 클립 ──────────────────────────────────────────
type AutoClip = {
  motionData: MotionFrame[];
  startAudioTime: number; // crop 시작 기준 상대 시간 (초)
  endAudioTime: number;
  playbackSpeed: number;  // 0.9 ~ 1.2x
  isFinish?: boolean;     // 마지막 피니쉬 클립 여부
};

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// 오디오 재생 시각과 가장 가까운 모션 프레임을 이진 탐색으로 찾는다.
// 시간복잡도 O(log n) — 최대 수천 프레임에도 체감 지연 없음.
function findNearestFrame(frames: MotionFrame[], time: number): MotionFrame | null {
  if (frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  // lo = time 이상인 첫 번째 인덱스. lo-1과 비교해 더 가까운 쪽을 반환.
  if (
    lo > 0 &&
    Math.abs(frames[lo - 1].time - time) < Math.abs(frames[lo].time - time)
  ) {
    return frames[lo - 1];
  }
  return frames[lo];
}

// ── Auto-Mix 헬퍼: relTime이 속한 클립 인덱스 (선형 탐색 — 최대 4개) ────────
// relTime = cropStart 기준 경과 시간 (초)
function findClipIndex(clips: AutoClip[], relTime: number): number {
  for (let i = 0; i < clips.length; i++) {
    if (relTime < clips[i].endAudioTime) return i;
  }
  return clips.length - 1; // 마지막 클립 고정
}

// ── Auto-Mix 헬퍼: 클립 시작 기준 offset → 모션 내 scaledTime (루프 고정) ──
function clipScaledTimeFromOffset(
  frames: MotionFrame[],
  offset: number,
  speed: number
): number {
  if (frames.length === 0) return 0;
  const firstTime      = frames[0].time;
  const motionDuration = frames[frames.length - 1].time - firstTime;
  if (motionDuration <= 0) return firstTime;
  const scaled = offset * speed;
  return (scaled % motionDuration + motionDuration) % motionDuration + firstTime;
}

interface ControlPanelProps {
  onLandmarksUpdate: (landmarks: Landmark3D[] | null) => void;
  onSaveSuccess?: (name: string) => void;
  /** 3D 캔버스 녹화 상태 */
  isCapturing3D: boolean;
  captureBackground: CaptureBackground;
  onToggle3DCapture: () => void;
  onChangeCaptureBackground: (bg: CaptureBackground) => void;
  /** 오디오 엘리먼트가 마운트/언마운트될 때 호출 — Kling 녹화 시 오디오 트랙 캡처용 */
  onDirectAudioRef?: (el: HTMLAudioElement | null) => void;
  /** 모드 전환 시 부모에게 알림 (StudioClient가 우측 패널 전환에 사용) */
  onModeChange?: (mode: Mode) => void;
}

export default function ControlPanel({
  onLandmarksUpdate,
  onSaveSuccess,
  isCapturing3D,
  captureBackground,
  onToggle3DCapture,
  onChangeCaptureBackground,
  onDirectAudioRef,
  onModeChange,
}: ControlPanelProps) {
  // ── 모드 ────────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>("extract");

  // ── Extract 모드: 미디어 상태 ────────────────────────────────────────────────
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // ── Extract 모드: 타임라인 구간 ───────────────────────────────────────────────
  const [segments, setSegments] = useState<Segment[]>([]);

  // ── Extract 모드: 명시적 모션 녹화 ─────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  const motionFramesRef = useRef<MotionFrame[]>([]);
  const recordLastTimeRef = useRef<number>(-1);
  const [savedRecording, setSavedRecording] = useState<MotionFrame[] | null>(null);
  const [liveFrameCount, setLiveFrameCount] = useState(0);

  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);

  useEffect(() => {
    const id = setInterval(() => {
      if (isRecordingRef.current) setLiveFrameCount(motionFramesRef.current.length);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Extract 모드: Supabase 저장 상태 ────────────────────────────────────────
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveRefreshKey, setSaveRefreshKey] = useState(0);

  // ── 모션 이름 입력 모달 ─────────────────────────────────────────────────────
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [pendingMotionName, setPendingMotionName] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // ── Extract 모드: Export 프레임 버퍼 ────────────────────────────────────────
  const exportFramesRef = useRef<MotionFrame[]>([]);
  const exportLastTimeRef = useRef<number>(-1);
  const [exportFrameCount, setExportFrameCount] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setExportFrameCount(exportFramesRef.current.length), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Extract 모드: ref 동기화 ─────────────────────────────────────────────────
  const isPlayingRef = useRef(false);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const isSeeking = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const prevVideoUrlRef = useRef<string | null>(null);
  const prevAudioUrlRef = useRef<string | null>(null);

  // ── Direct 모드: 상태 ────────────────────────────────────────────────────────
  const [directAudioUrl, setDirectAudioUrl] = useState<string | null>(null);
  const [directDuration, setDirectDuration] = useState(0);
  const [isDirectPlaying, setIsDirectPlaying] = useState(false);
  const [directTime, setDirectTime] = useState(0);
  const [motionSummaries, setMotionSummaries] = useState<MotionSummary[]>([]);
  const [selectedMotionId, setSelectedMotionId] = useState<string | null>(null);
  const [isDirectMotionLoaded, setIsDirectMotionLoaded] = useState(false);
  const [isDirectLoadingMotion, setIsDirectLoadingMotion] = useState(false);
  const [directMotionName, setDirectMotionName] = useState("");
  const [directFrameCount, setDirectFrameCount] = useState(0);

  // ── Direct 모드: 루프 + 배속 상태 ───────────────────────────────────────────
  const [isLooping, setIsLooping] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);

  // ── Direct 모드: 오디오 Crop 구간 ──────────────────────────────────────────
  // cropStart/cropEnd: 실제 적용 값 (숫자)
  // cropStartText/cropEndText: 입력창에 보여지는 문자열 — 타이핑 중 스냅백 방지
  const [cropStart, setCropStart] = useState(0);
  const [cropEnd, setCropEnd] = useState(0);
  const [cropStartText, setCropStartText] = useState("0");
  const [cropEndText, setCropEndText] = useState("0");

  // cropStart/cropEnd가 코드 쪽에서 바뀔 때(오디오 로드·전체 초기화 등) 텍스트도 동기화
  useEffect(() => { setCropStartText(cropStart.toFixed(1)); }, [cropStart]);
  useEffect(() => { setCropEndText(cropEnd.toFixed(1)); }, [cropEnd]);

  // ── Direct 모드: refs ────────────────────────────────────────────────────────
  // stale closure 방지 — RAF 루프는 state 대신 이 ref들을 직접 읽는다
  const directAudioRef = useRef<HTMLAudioElement>(null);
  // 오디오 엘리먼트 마운트/언마운트 시 부모에게 알리는 callback ref
  const onDirectAudioRefPropRef = useRef(onDirectAudioRef);
  useEffect(() => { onDirectAudioRefPropRef.current = onDirectAudioRef; }, [onDirectAudioRef]);
  const handleAudioCallbackRef = useCallback((el: HTMLAudioElement | null) => {
    // directAudioRef는 useRef(null)로 생성된 RefObject — current는 readonly이나 강제 할당
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (directAudioRef as any).current = el;
    onDirectAudioRefPropRef.current?.(el);
  }, []);
  const isDirectPlayingRef = useRef(false);
  const selectedMotionDataRef = useRef<MotionFrame[]>([]);
  const rafIdRef = useRef<number>(0);
  const onLandmarksUpdateRef = useRef(onLandmarksUpdate);
  const prevDirectAudioUrlRef = useRef<string | null>(null);
  const isLoopingRef = useRef(true);
  const playbackSpeedRef = useRef(1.0);
  const cropStartRef = useRef(0);
  const cropEndRef = useRef(0);
  // isCapturing3D prop을 RAF 루프 내에서 읽기 위한 ref (stale closure 방지)
  const isCapturing3DRef = useRef(isCapturing3D);
  // onToggle3DCapture: StudioClient에서 useCallback([])로 생성되어 안정적이나 일관성을 위해 ref 사용
  const onToggle3DCaptureRef = useRef(onToggle3DCapture);

  useEffect(() => { isDirectPlayingRef.current = isDirectPlaying; }, [isDirectPlaying]);
  useEffect(() => { onLandmarksUpdateRef.current = onLandmarksUpdate; }, [onLandmarksUpdate]);
  useEffect(() => { isLoopingRef.current = isLooping; }, [isLooping]);
  useEffect(() => { playbackSpeedRef.current = playbackSpeed; }, [playbackSpeed]);
  useEffect(() => { cropStartRef.current = cropStart; }, [cropStart]);
  useEffect(() => { cropEndRef.current = cropEnd; }, [cropEnd]);
  useEffect(() => { isCapturing3DRef.current = isCapturing3D; }, [isCapturing3D]);
  useEffect(() => { onToggle3DCaptureRef.current = onToggle3DCapture; }, [onToggle3DCapture]);

  // ── Direct 모드: 타임라인 모션 변형 (Motion Modifiers) ────────────────────
  const [timelineEffects, setTimelineEffects] = useState<TimelineEffect[]>([]);
  // RAF 루프 stale closure 방지 — 효과 목록은 ref로 읽는다
  const timelineEffectsRef = useRef<TimelineEffect[]>([]);
  useEffect(() => { timelineEffectsRef.current = timelineEffects; }, [timelineEffects]);

  // ── Direct 모드: 오디오 파형 디코딩 + Canvas 렌더 ────────────────────────────
  // directAudioUrl이 바뀔 때마다 Web Audio API로 300개 피크값 추출 → waveformPeaks
  // useEffect([waveformPeaks, crop*, directTime])에서 canvas에 그림
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>([]);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  // 드래그 핸들 — ref로 관리해 mousemove 시 re-render 없음
  const dragTargetRef     = useRef<"start" | "end" | null>(null);
  const [canvasCursor, setCanvasCursor] = useState<"default" | "ew-resize">("default");
  // stale closure 방지용 directDuration ref
  const directDurationRef = useRef(0);
  useEffect(() => { directDurationRef.current = directDuration; }, [directDuration]);

  useEffect(() => {
    if (!directAudioUrl) { setWaveformPeaks([]); return; }
    let cancelled = false;
    const NUM_BARS = 300;

    fetch(directAudioUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const ac = new AudioContext();
        return ac.decodeAudioData(buf).then((ab) => { ac.close(); return ab; });
      })
      .then((audioBuffer) => {
        if (cancelled) return;
        const raw   = audioBuffer.getChannelData(0);
        const block = Math.floor(raw.length / NUM_BARS);
        const peaks = new Array<number>(NUM_BARS);
        for (let i = 0; i < NUM_BARS; i++) {
          let max = 0;
          const base = i * block;
          for (let j = 0; j < block; j++) {
            const v = Math.abs(raw[base + j]);
            if (v > max) max = v;
          }
          peaks[i] = max;
        }
        setWaveformPeaks(peaks);
      })
      .catch((err) => console.warn("[DanceFlow] Waveform decode:", err));

    return () => { cancelled = true; };
  }, [directAudioUrl]);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx2d.clearRect(0, 0, W, H);

    // 배경
    ctx2d.fillStyle = "#18181b";
    ctx2d.fillRect(0, 0, W, H);

    if (waveformPeaks.length === 0 || directDuration === 0) return;

    const barW   = W / waveformPeaks.length;
    const cropSX = (cropStart / directDuration) * W;
    const cropEX = (cropEnd   / directDuration) * W;

    // 파형 바
    for (let i = 0; i < waveformPeaks.length; i++) {
      const x        = i * barW;
      const peakTime = (i / waveformPeaks.length) * directDuration;
      const inCrop   = peakTime >= cropStart && peakTime <= cropEnd;
      const barH     = Math.max(waveformPeaks[i] * (H - 4) * 0.95, 1);
      ctx2d.fillStyle = inCrop ? "#7c3aed" : "#3f3f46";
      ctx2d.fillRect(x + 0.5, (H - barH) / 2, Math.max(barW - 1, 0.5), barH);
    }

    // Crop 구간 반투명 오버레이
    ctx2d.fillStyle = "rgba(124,58,237,0.12)";
    ctx2d.fillRect(cropSX, 0, cropEX - cropSX, H);

    // 드래그 핸들 — 4px 바 + 그립 점 3개
    const drawHandle = (hx: number) => {
      ctx2d.fillStyle = "#a78bfa";
      ctx2d.fillRect(hx - 2, 0, 4, H);
      ctx2d.fillStyle = "#ede9fe";
      for (let d = 0; d < 3; d++) {
        ctx2d.fillRect(hx - 1, H / 2 - 6 + d * 5, 2, 3);
      }
    };
    drawHandle(cropSX);
    drawHandle(cropEX);

    // 현재 재생 위치
    if (directTime >= 0) {
      const posX = (directTime / directDuration) * W;
      ctx2d.fillStyle = "#c4b5fd";
      ctx2d.fillRect(Math.round(posX) - 1, 0, 2, H);
    }
  }, [waveformPeaks, cropStart, cropEnd, directTime, directDuration]);

  // ── Auto-Mix: GC 최적화 버퍼 + 클립 목록 ─────────────────────────────────────
  // lerpBufRef: 33개 Landmark3D 고정 크기 배열 — 매 프레임 new 객체 할당 방지
  // buf.slice()로 새 배열 참조만 생성 → PoseCanvas3D useEffect([landmarks]) 호환
  const lerpBufRef = useRef<Landmark3D[]>(
    Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }))
  );
  const [autoClips, setAutoClips] = useState<AutoClip[]>([]);
  const autoClipsRef = useRef<AutoClip[]>([]);
  useEffect(() => { autoClipsRef.current = autoClips; }, [autoClips]);
  const [isAutoMixLoading, setIsAutoMixLoading] = useState(false);
  const [autoMixError, setAutoMixError] = useState<string | null>(null);
  // 피니쉬 모션 선택
  const [finishMotionId, setFinishMotionId] = useState<string | null>(null);

  // ── Object URL 생명주기 ───────────────────────────────────────────────────────
  const handleVideoUpload = useCallback((file: File) => {
    if (prevVideoUrlRef.current) URL.revokeObjectURL(prevVideoUrlRef.current);
    const url = URL.createObjectURL(file);
    prevVideoUrlRef.current = url;
    setVideoUrl(url);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    motionFramesRef.current = [];
    exportFramesRef.current = [];
    recordLastTimeRef.current = -1;
    exportLastTimeRef.current = -1;
    setLiveFrameCount(0);
    setExportFrameCount(0);
    setSavedRecording(null);
    setSaveStatus("idle");
    setSaveError(null);
    setIsRecording(false);
    onLandmarksUpdate(null);
  }, [onLandmarksUpdate]);

  const handleAudioUpload = useCallback((file: File) => {
    if (prevAudioUrlRef.current) URL.revokeObjectURL(prevAudioUrlRef.current);
    const url = URL.createObjectURL(file);
    prevAudioUrlRef.current = url;
    setAudioUrl(url);
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    return () => {
      if (prevVideoUrlRef.current) URL.revokeObjectURL(prevVideoUrlRef.current);
      if (prevAudioUrlRef.current) URL.revokeObjectURL(prevAudioUrlRef.current);
      if (prevDirectAudioUrlRef.current) URL.revokeObjectURL(prevDirectAudioUrlRef.current);
    };
  }, []);

  // ── Extract 모드: duration → 구간 초기화 ─────────────────────────────────────
  useEffect(() => {
    if (duration > 0) {
      setSegments([{ id: "1", startTime: 0, endTime: duration, motionStyle: "", details: "" }]);
    } else {
      setSegments([]);
    }
  }, [duration]);

  // ── Extract 모드: 랜드마크 인터셉터 ─────────────────────────────────────────
  const handleLandmarksUpdate = useCallback((lm: Landmark3D[] | null) => {
    onLandmarksUpdate(lm);
    if (!lm || !videoRef.current || !isPlayingRef.current) return;

    const vTime = videoRef.current.currentTime;
    const frame: MotionFrame = {
      time: parseFloat(vTime.toFixed(3)),
      landmarks: lm.map((l) => ({
        x: parseFloat(l.x.toFixed(4)),
        y: parseFloat(l.y.toFixed(4)),
        z: parseFloat(l.z.toFixed(4)),
        visibility: parseFloat((l.visibility ?? 1).toFixed(3)),
      })),
    };

    if (vTime - exportLastTimeRef.current >= 0.1) {
      exportFramesRef.current.push(frame);
      exportLastTimeRef.current = vTime;
    }

    if (isRecordingRef.current && vTime - recordLastTimeRef.current >= 0.1) {
      motionFramesRef.current.push(frame);
      recordLastTimeRef.current = vTime;
    }
  }, [onLandmarksUpdate]);

  // ── Extract 모드: 녹화 토글 ──────────────────────────────────────────────────
  const handleToggleRecording = useCallback(() => {
    if (isRecordingRef.current) {
      const recorded = [...motionFramesRef.current];
      setSavedRecording(recorded.length > 0 ? recorded : null);
      setLiveFrameCount(recorded.length);
      setIsRecording(false);
      setSaveStatus("idle");
      setSaveError(null);
    } else {
      motionFramesRef.current = [];
      recordLastTimeRef.current = -1;
      setLiveFrameCount(0);
      setSavedRecording(null);
      setSaveStatus("idle");
      setSaveError(null);
      setIsRecording(true);
    }
  }, []);

  // ── Extract 모드: Supabase 저장 ──────────────────────────────────────────────
  const handleSave = useCallback(() => {
    if (!savedRecording || savedRecording.length === 0) return;
    setPendingMotionName("");
    setShowSaveModal(true);
  }, [savedRecording]);

  const handleConfirmSave = useCallback(async () => {
    if (!savedRecording || pendingMotionName.trim() === "") return;
    setShowSaveModal(false);
    setSaveStatus("saving");
    setSaveError(null);

    try {
      const poseData = buildPoseData(savedRecording);
      const { id } = await saveMotion(pendingMotionName.trim(), savedRecording, poseData);
      console.log(`[DanceFlow] 저장 완료 → id: ${id}, name: "${pendingMotionName.trim()}", frames: ${savedRecording.length}, fps: ${poseData.meta.fps}`);
      setSaveStatus("success");
      setSaveRefreshKey((k) => k + 1);
      onSaveSuccess?.(pendingMotionName.trim());
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "알 수 없는 오류";
      console.error("[DanceFlow] Supabase 저장 실패:", msg);
      setSaveError(msg);
      setSaveStatus("error");
    }
  }, [savedRecording, pendingMotionName, onSaveSuccess]);

  const handleCancelSave = useCallback(() => {
    setShowSaveModal(false);
    setPendingMotionName("");
    setAnalyzeError(null);
  }, []);

  // ── Gemini 자동 분석 ─────────────────────────────────────────────────────────
  const handleGeminiAnalyze = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    setIsAnalyzing(true);
    setAnalyzeError(null);

    try {
      // 시각(9컷 그리드) + 청각(오디오) 병렬 추출
      const [gridImage, audioData] = await Promise.all([
        extractGridThumbnails(video),
        extractAudio(video),
      ]);
      const res = await fetch("/api/analyze-dance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gridImage, audioData }),
      });

      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(error ?? "서버 오류");
      }

      const { genre, vibe, tempo, difficulty } = await res.json() as { genre: string; vibe: string; tempo: string; difficulty: string };
      setPendingMotionName(`${genre}_${vibe}_${tempo}_${difficulty}`);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "분석 실패");
    } finally {
      setIsAnalyzing(false);
    }
  }, [videoRef]);

  // ── Extract 모드: TimelineEditor Export ─────────────────────────────────────
  const handleExport = useCallback(() => {
    const record = exportFramesRef.current;
    const payload = {
      exportedAt: new Date().toISOString(),
      videoDuration: parseFloat(duration.toFixed(3)),
      totalFramesRecorded: record.length,
      timeline: segments.map((seg, i) => ({
        segment: i + 1,
        startTime: parseFloat(seg.startTime.toFixed(3)),
        endTime: parseFloat(seg.endTime.toFixed(3)),
        durationSec: parseFloat((seg.endTime - seg.startTime).toFixed(3)),
        prompt: { motionStyle: seg.motionStyle, details: seg.details },
        landmarkFrames: record.filter(
          (f) => f.time >= seg.startTime && f.time < seg.endTime
        ),
      })),
    };
    console.group("🎬 [DanceFlow Export] Motion + Prompts JSON");
    console.log("📊 Summary:", { duration: `${payload.videoDuration}s`, frames: payload.totalFramesRecorded, segments: payload.timeline.length });
    payload.timeline.forEach((seg) => {
      console.group(`🎵 Segment ${seg.segment}  ${formatTime(seg.startTime)} → ${formatTime(seg.endTime)}`);
      console.log("Style:", seg.prompt.motionStyle || "(없음)");
      console.log("Detail:", seg.prompt.details || "(없음)");
      console.log("Frames:", seg.landmarkFrames.length);
      console.groupEnd();
    });
    console.log("📦 Full payload:", payload);
    console.groupEnd();
  }, [segments, duration]);

  // ── Extract 모드: 오디오 재생/일시정지 동기화 ────────────────────────────────
  // AudioPlayer 컴포넌트 제거 후 직접 제어
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (isPlaying) {
      audio.play().catch(console.error);
    } else {
      audio.pause();
    }
  }, [isPlaying, audioUrl]);

  // ── Extract 모드: 재생 제어 ──────────────────────────────────────────────────
  const handlePlayPause = useCallback(() => {
    if (!videoUrl && !audioUrl) return;
    setIsPlaying((prev) => !prev);
  }, [videoUrl, audioUrl]);

  const handleTimeUpdate = useCallback((time: number) => {
    if (!isSeeking.current) setCurrentTime(time);
  }, []);

  useEffect(() => {
    if (duration > 0 && currentTime >= duration - 0.1) setIsPlaying(false);
  }, [currentTime, duration]);

  const handleSeekStart = useCallback(() => { isSeeking.current = true; }, []);

  const handleSeekChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentTime(parseFloat(e.target.value));
  }, []);

  const handleSeekEnd = useCallback(() => {
    setCurrentTime((t) => {
      if (videoRef.current) videoRef.current.currentTime = t;
      if (audioRef.current) audioRef.current.currentTime = t;
      return t;
    });
    isSeeking.current = false;
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLSelectElement)
      ) {
        e.preventDefault();
        if (mode === "extract") handlePlayPause();
        else handleDirectPlayPause();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, handlePlayPause]);

  // ── Direct 모드: RAF 오디오-모션 동기화 루프 ──────────────────────────────────
  //
  // 설계 원칙:
  //  - state 대신 ref만 읽어 stale closure 완전 방지
  //  - 재귀 rAF 패턴 (setInterval 대비 더 정밀한 타이밍)
  //  - audio.ended 감지 시 루프 자체 종료
  //
  // 의존성 배열 [] → 컴포넌트 수명 동안 함수 레퍼런스 고정
  const directRafLoop = useCallback(() => {
    if (!isDirectPlayingRef.current) return;
    const audio = directAudioRef.current;
    if (!audio) return;

    const audioTime = audio.currentTime;

    // ── Crop 구간 경계 감지 ───────────────────────────────────────────────
    //
    // cropEnd에 도달하면:
    //   1. audio.currentTime을 cropStart로 되감기 (구간 루프)
    //   2. Kling 녹화 중이면 자동 종료 → 파일 다운로드 트리거
    //
    // cropEnd가 0인 경우는 아직 초기화 전이므로 체크하지 않는다.
    const cEnd = cropEndRef.current;
    const cStart = cropStartRef.current;
    if (cEnd > 0 && audioTime >= cEnd) {
      // Kling 녹화 중이면 이 프레임에서 자동 종료 (한 번만 호출되도록 isCapturing3D 체크)
      if (isCapturing3DRef.current) {
        onToggle3DCaptureRef.current(); // PoseCanvas3D의 MediaRecorder.stop() → blob 다운로드 트리거
      }
      // 구간 시작점으로 되감기
      audio.currentTime = cStart;
      setDirectTime(cStart);
      rafIdRef.current = requestAnimationFrame(directRafLoop);
      return;
    }

    setDirectTime(audioTime);

    // ── 공유 버퍼 + 경로 분기 ─────────────────────────────────────────────────
    //
    // buf: 컴포넌트 수명 동안 단 33개 객체만 존재 — for 루프로 값만 덮어씀
    // buf.slice(): 새 배열 참조 1개만 생성 → PoseCanvas3D useEffect([landmarks]) 호환
    //
    const buf          = lerpBufRef.current;
    const clips        = autoClipsRef.current;
    const singleFrames = selectedMotionDataRef.current;
    const relTime      = audioTime - cStart; // cropStart 기준 경과 시간
    // 클립 전환 구간: 클립 종료 0.3초 전부터 다음 클립과 선형 보간 (총 0.6초 구간)
    const LERP_HALF    = 0.3;
    let didRender      = false;

    if (clips.length > 0) {
      // ── Auto-Mix 경로 ────────────────────────────────────────────────────
      const idx  = findClipIndex(clips, relTime);
      const clip = clips[idx];
      const offsetA  = relTime - clip.startAudioTime;
      const tA       = clipScaledTimeFromOffset(clip.motionData, offsetA, clip.playbackSpeed);
      const frameA   = findNearestFrame(clip.motionData, tA);

      if (frameA) {
        const srcA    = frameA.landmarks;
        const clipLen = Math.min(srcA.length, buf.length);

        // 다음 클립이 있고 종료까지 LERP_HALF 이내 → 선형 보간
        const distToEnd = clip.endAudioTime - relTime;
        const nextClip  = idx + 1 < clips.length ? clips[idx + 1] : null;
        const isLerping = nextClip !== null && distToEnd < LERP_HALF;

        if (isLerping) {
          // tLerp: 0 (보간 시작) → 1 (완전히 다음 클립)
          const tLerp   = 1 - distToEnd / LERP_HALF;
          // offsetB: 음수 허용 — Math.max(0,...) 으로 클램프 → 다음 클립 첫 프레임부터
          const offsetB = Math.max(0, relTime - nextClip.startAudioTime);
          const tB      = clipScaledTimeFromOffset(nextClip.motionData, offsetB, nextClip.playbackSpeed);
          const frameB  = findNearestFrame(nextClip.motionData, tB);

          if (frameB) {
            const srcB    = frameB.landmarks;
            const lerpLen = Math.min(clipLen, srcB.length);
            for (let i = 0; i < lerpLen; i++) {
              buf[i].x          = srcA[i].x          * (1 - tLerp) + srcB[i].x          * tLerp;
              buf[i].y          = srcA[i].y          * (1 - tLerp) + srcB[i].y          * tLerp;
              buf[i].z          = srcA[i].z          * (1 - tLerp) + srcB[i].z          * tLerp;
              buf[i].visibility = srcA[i].visibility * (1 - tLerp) + srcB[i].visibility * tLerp;
            }
            // srcB가 짧을 경우 나머지는 A 그대로
            for (let i = lerpLen; i < clipLen; i++) {
              buf[i].x = srcA[i].x; buf[i].y = srcA[i].y;
              buf[i].z = srcA[i].z; buf[i].visibility = srcA[i].visibility;
            }
          } else {
            for (let i = 0; i < clipLen; i++) {
              buf[i].x = srcA[i].x; buf[i].y = srcA[i].y;
              buf[i].z = srcA[i].z; buf[i].visibility = srcA[i].visibility;
            }
          }
        } else {
          for (let i = 0; i < clipLen; i++) {
            buf[i].x = srcA[i].x; buf[i].y = srcA[i].y;
            buf[i].z = srcA[i].z; buf[i].visibility = srcA[i].visibility;
          }
        }
        didRender = true;
      }

    } else if (singleFrames.length > 0) {
      // ── Single-clip 경로 ─────────────────────────────────────────────────
      const firstTime      = singleFrames[0].time;
      const motionDuration = singleFrames[singleFrames.length - 1].time - firstTime;
      let scaledTime       = relTime * playbackSpeedRef.current;

      if (isLoopingRef.current && motionDuration > 0) {
        scaledTime = (scaledTime % motionDuration + motionDuration) % motionDuration + firstTime;
      } else {
        scaledTime = scaledTime + firstTime;
      }

      const frame = findNearestFrame(singleFrames, scaledTime);
      if (frame) {
        const src = frame.landmarks;
        const len = Math.min(src.length, buf.length);
        for (let i = 0; i < len; i++) {
          buf[i].x = src[i].x; buf[i].y = src[i].y;
          buf[i].z = src[i].z; buf[i].visibility = src[i].visibility;
        }
        didRender = true;
      }
    }

    if (didRender) {
      // ── 공통: Motion Modifiers 인-플레이스 적용 ──────────────────────────
      // 새 객체 할당 없음 — buf 내 값만 덮어씀
      const effects = timelineEffectsRef.current;
      for (let ei = 0; ei < effects.length; ei++) {
        const eff = effects[ei];
        if (audioTime < eff.startTime || audioTime > eff.endTime) continue;

        if (eff.type === "bounce") {
          const dy = Math.sin(audioTime * 15) * eff.intensity * 0.05;
          for (let i = 0; i < buf.length; i++) { buf[i].y += dy; }

        } else if (eff.type === "wider_arms" && buf.length > 16) {
          const scale = 1 + eff.intensity * 0.4;
          const lsx   = buf[11].x;
          const rsx   = buf[12].x;
          buf[13].x   = lsx + (buf[13].x - lsx) * scale;
          buf[15].x   = lsx + (buf[15].x - lsx) * scale;
          buf[14].x   = rsx + (buf[14].x - rsx) * scale;
          buf[16].x   = rsx + (buf[16].x - rsx) * scale;
        }
      }
      // buf.slice(): 새 배열 레퍼런스 1개 생성 (객체 33개는 재사용) → React 참조 동등성 통과
      onLandmarksUpdateRef.current(buf.slice());
    }

    // 오디오 자연 종료 감지 → 루프 종료
    if (audio.ended) {
      isDirectPlayingRef.current = false;
      setIsDirectPlaying(false);
      return;
    }

    rafIdRef.current = requestAnimationFrame(directRafLoop);
  }, []); // stable — refs만 읽으므로 재생성 불필요

  // ── Direct 모드: Supabase 목록 로드 ─────────────────────────────────────────
  useEffect(() => {
    if (mode === "direct") {
      getMotionSummaries(50)
        .then(setMotionSummaries)
        .catch((err) => console.error("[DanceFlow] 모션 목록 로드 실패:", err));
    }
  }, [mode]);

  // ── Direct 모드: 모션 선택 → Supabase에서 전체 데이터 가져오기 ────────────────
  const handleSelectMotion = useCallback(async (id: string) => {
    setSelectedMotionId(id);
    setIsDirectMotionLoaded(false);
    setIsDirectLoadingMotion(true);
    selectedMotionDataRef.current = [];

    try {
      const row = await getMotionById(id);
      selectedMotionDataRef.current = row.motion_data;
      setDirectMotionName(row.name);
      setDirectFrameCount(row.motion_data.length);
      setIsDirectMotionLoaded(true);
    } catch (err) {
      console.error("[DanceFlow] 모션 로드 실패:", err);
    } finally {
      setIsDirectLoadingMotion(false);
    }
  }, []);

  // ── Direct 모드: 오디오 업로드 ──────────────────────────────────────────────
  const handleDirectAudioUpload = useCallback((file: File) => {
    if (prevDirectAudioUrlRef.current) URL.revokeObjectURL(prevDirectAudioUrlRef.current);
    const url = URL.createObjectURL(file);
    prevDirectAudioUrlRef.current = url;
    setDirectAudioUrl(url);
    setDirectTime(0);
    setDirectDuration(0);
    // 새 오디오 업로드 시 crop 구간 초기화 (cropEnd는 onLoadedMetadata에서 duration으로 세팅)
    setCropStart(0);
    setCropEnd(0);
    // 오디오 교체 시 재생 중이면 중단
    if (isDirectPlayingRef.current) {
      directAudioRef.current?.pause();
      isDirectPlayingRef.current = false;
      setIsDirectPlaying(false);
      cancelAnimationFrame(rafIdRef.current);
    }
  }, []);

  // ── Direct 모드: 재생/일시정지 ──────────────────────────────────────────────
  const handleDirectPlayPause = useCallback(() => {
    const audio = directAudioRef.current;
    if (!audio) return;

    if (isDirectPlayingRef.current) {
      // 일시정지
      audio.pause();
      isDirectPlayingRef.current = false;
      setIsDirectPlaying(false);
      cancelAnimationFrame(rafIdRef.current);
    } else {
      // 재생 시작: 현재 위치가 crop 구간 밖이면 cropStart로 이동
      const cStart = cropStartRef.current;
      const cEnd = cropEndRef.current;
      if (cEnd > 0 && (audio.currentTime < cStart || audio.currentTime >= cEnd)) {
        audio.currentTime = cStart;
        setDirectTime(cStart);
      }
      audio.play().catch(console.error);
      isDirectPlayingRef.current = true;
      setIsDirectPlaying(true);
      rafIdRef.current = requestAnimationFrame(directRafLoop);
    }
  }, [directRafLoop]);

  // ── Direct 모드: 시크 핸들러 ────────────────────────────────────────────────
  const handleDirectSeekStart = useCallback(() => {
    // 시크 중 RAF 일시 정지 (오디오 위치와 슬라이더 값 충돌 방지)
    cancelAnimationFrame(rafIdRef.current);
  }, []);

  const handleDirectSeekChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDirectTime(parseFloat(e.target.value));
  }, []);

  const handleDirectSeekEnd = useCallback(() => {
    setDirectTime((t) => {
      if (directAudioRef.current) directAudioRef.current.currentTime = t;
      return t;
    });
    // 재생 중이었으면 RAF 재시작
    if (isDirectPlayingRef.current) {
      rafIdRef.current = requestAnimationFrame(directRafLoop);
    }
  }, [directRafLoop]);

  // ── Direct 모드: Motion Modifier 관리 콜백 ──────────────────────────────────
  const handleAddEffect = useCallback(() => {
    setTimelineEffects((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        startTime: cropStart,
        endTime: cropEnd > cropStart ? cropEnd : cropStart + 5,
        type: "bounce" as EffectType,
        intensity: 1.0,
      },
    ]);
  }, [cropStart, cropEnd]);

  const handleRemoveEffect = useCallback((id: string) => {
    setTimelineEffects((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const handleUpdateEffect = useCallback(
    (id: string, updates: Partial<Omit<TimelineEffect, "id">>) => {
      setTimelineEffects((prev) =>
        prev.map((e) => (e.id === id ? { ...e, ...updates } : e))
      );
    },
    []
  );

  // ── Auto-Mix: BPM 기반 자동 안무 생성 ──────────────────────────────────────────
  //
  // 설계:
  //  1. Supabase에서 최대 50개 모션 목록 조회
  //  2. Fisher-Yates 셔플 후 3~4개 무작위 선택
  //  3. 클립당 4~8초, 0.9~1.2x 배속 무작위 배분
  //  4. Promise.all로 전체 데이터 병렬 페치
  //  5. setAutoClips → RAF 루프가 다음 프레임부터 자동 반영
  //
  const handleAutoMix = useCallback(async () => {
    setIsAutoMixLoading(true);
    setAutoMixError(null);
    setAutoClips([]);
    try {
      const summaries = await getMotionSummaries(50);
      if (summaries.length === 0) {
        setAutoMixError("저장된 모션이 없습니다.");
        return;
      }

      // 피니쉬 모션을 랜덤 풀에서 제외
      const currentFinishId = finishMotionId;
      const pool = currentFinishId
        ? summaries.filter((s) => s.id !== currentFinishId)
        : summaries;

      // 랜덤 클립 수: 피니쉬 있으면 한 자리 줄임 (총 3~4개 유지)
      const totalCount = Math.random() < 0.5 ? 3 : 4;
      const randomCount = currentFinishId ? totalCount - 1 : totalCount;

      // Fisher-Yates in-place 셔플
      const shuffled = [...pool];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
      }
      const selected = shuffled.slice(0, Math.min(randomCount, shuffled.length));

      // 병렬 페치 (랜덤 클립 + 피니쉬 클립)
      const fetchList = currentFinishId
        ? [...selected, { id: currentFinishId }]
        : selected;
      const rows = await Promise.all(fetchList.map((s) => getMotionById(s.id)));

      // 클립 스케줄 구성
      const clips: AutoClip[] = [];
      let cursor = 0;
      const randomRows = currentFinishId ? rows.slice(0, -1) : rows;
      for (let i = 0; i < randomRows.length; i++) {
        const dur   = 4 + Math.random() * 4;         // 4~8초
        const speed = 0.9 + Math.random() * 0.3;     // 0.9~1.2x
        clips.push({
          motionData:     randomRows[i].motion_data,
          startAudioTime: cursor,
          endAudioTime:   cursor + dur,
          playbackSpeed:  speed,
        });
        cursor += dur;
      }

      // 피니쉬 클립: 3초, 1.0x 속도
      if (currentFinishId) {
        const finishRow = rows[rows.length - 1];
        clips.push({
          motionData:     finishRow.motion_data,
          startAudioTime: cursor,
          endAudioTime:   cursor + 3,
          playbackSpeed:  1.0,
          isFinish:       true,
        });
      }

      setAutoClips(clips);
    } catch (err) {
      setAutoMixError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setIsAutoMixLoading(false);
    }
  }, [finishMotionId]);

  const handleClearAutoMix = useCallback(() => {
    setAutoClips([]);
    setAutoMixError(null);
  }, []);

  // ── 모드 전환 ─────────────────────────────────────────────────────────────────
  const handleModeSwitch = useCallback((newMode: Mode) => {
    if (newMode === mode) return;
    setMode(newMode);
    onModeChange?.(newMode);
    onLandmarksUpdate(null); // 3D 캔버스 클리어

    if (newMode === "extract") {
      // Direct/Toolbox 모드 → Extract 모드: Direct 재생 중단
      if (isDirectPlayingRef.current) {
        directAudioRef.current?.pause();
        isDirectPlayingRef.current = false;
        setIsDirectPlaying(false);
        cancelAnimationFrame(rafIdRef.current);
      }
    } else if (newMode !== "toolbox") {
      // Extract 모드 → Direct 모드: Extract 재생 중단
      setIsPlaying(false);
    } else {
      // Toolbox 모드 전환 시 양쪽 모두 중단
      setIsPlaying(false);
      if (isDirectPlayingRef.current) {
        directAudioRef.current?.pause();
        isDirectPlayingRef.current = false;
        setIsDirectPlaying(false);
        cancelAnimationFrame(rafIdRef.current);
      }
    }
  }, [mode, onLandmarksUpdate, onModeChange]);

  // ── 계산 값 ──────────────────────────────────────────────────────────────────
  const recordedDuration = (() => {
    const frames = isRecording ? motionFramesRef.current : (savedRecording ?? []);
    if (frames.length < 2) return 0;
    return frames[frames.length - 1].time - frames[0].time;
  })();

  const hasMedia = videoUrl || audioUrl;
  const extractProgress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const directProgress = directDuration > 0 ? (directTime / directDuration) * 100 : 0;
  const canDirectPlay = !!directAudioUrl && (isDirectMotionLoaded || autoClips.length > 0);

  // ── 렌더 ──────────────────────────────────────────────────────────────────────
  return (
    <>
    {/* ── 모션 이름 입력 모달 ─────────────────────────────────────────────────── */}
    {showSaveModal && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
        onClick={handleCancelSave}
      >
        <div
          className="w-80 rounded-xl bg-zinc-900 border border-zinc-700 shadow-2xl p-5 flex flex-col gap-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">댄스 이름 입력</h3>
            <p className="text-xs text-zinc-500 mt-0.5">저장할 모션의 이름을 입력하세요</p>
          </div>
          {/* Gemini 자동 분석 버튼 */}
          <button
            onClick={handleGeminiAnalyze}
            disabled={isAnalyzing}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold bg-blue-900/60 border border-blue-700/60 text-blue-300 hover:bg-blue-800/70 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isAnalyzing ? (
              <>
                <svg className="animate-spin h-3.5 w-3.5 text-blue-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Gemini 분석 중…
              </>
            ) : (
              <>🤖 Gemini 자동 분석</>
            )}
          </button>

          {/* 분석 에러 메시지 */}
          {analyzeError && (
            <p className="text-xs text-red-400 text-center -mt-1">❌ {analyzeError}</p>
          )}

          <input
            autoFocus
            type="text"
            value={pendingMotionName}
            onChange={(e) => setPendingMotionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirmSave();
              if (e.key === "Escape") handleCancelSave();
            }}
            placeholder="예: 기본 힙합 바운스"
            className="w-full bg-zinc-800 border border-zinc-700 focus:border-violet-500 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none transition-colors"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCancelSave}
              className="flex-1 py-2 rounded-lg text-xs font-semibold bg-zinc-800 border border-zinc-700 text-zinc-400 hover:bg-zinc-700 transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleConfirmSave}
              disabled={pendingMotionName.trim() === ""}
              className="flex-1 py-2 rounded-lg text-xs font-semibold bg-violet-700 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              저장
            </button>
          </div>
        </div>
      </div>
    )}

    <div className="flex flex-col h-full gap-4 p-4 overflow-y-auto custom-scrollbar">
      {/* ── 앱 타이틀 ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0">
        <h1 className="text-base font-bold text-zinc-100 tracking-tight">
          Dance Flow <span className="text-violet-500">Studio</span>
        </h1>
        <p className="text-xs text-zinc-600 mt-0.5">AI Motion Directing</p>
      </div>

      {/* ── 모드 전환 탭 ──────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex rounded-lg bg-zinc-900 border border-zinc-800 p-0.5 gap-0.5">
        <button
          onClick={() => handleModeSwitch("extract")}
          className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${
            mode === "extract"
              ? "bg-violet-700 text-white shadow-sm"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Extract
        </button>
        <button
          onClick={() => handleModeSwitch("direct")}
          className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${
            mode === "direct"
              ? "bg-violet-700 text-white shadow-sm"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Direct
        </button>
        <button
          onClick={() => handleModeSwitch("toolbox")}
          className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${
            mode === "toolbox"
              ? "bg-violet-700 text-white shadow-sm"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Toolbox
        </button>
      </div>

      <hr className="border-zinc-800 flex-shrink-0" />

      {/* ══════════════════════════════════════════════════════════════════
          EXTRACT 모드 — 영상에서 포즈 추출 + Supabase 저장
      ══════════════════════════════════════════════════════════════════ */}
      {mode === "extract" && (
        <>
          {/* 비디오 플레이어 */}
          <div className="flex-shrink-0">
            <VideoPlayer
              videoUrl={videoUrl}
              isPlaying={isPlaying}
              currentTime={currentTime}
              onDurationChange={setDuration}
              onTimeUpdate={handleTimeUpdate}
              onFileUpload={handleVideoUpload}
              videoRef={videoRef}
              onLandmarksUpdate={handleLandmarksUpdate}
            />
          </div>

          {/* 오디오 업로더 (선택) */}
          <div className="flex-shrink-0">
            <label className="flex items-center gap-2 w-full cursor-pointer group">
              <span className="text-xs text-zinc-600 group-hover:text-zinc-500 transition-colors truncate">
                {audioUrl ? "🎵 오디오 업로드됨" : "🎵 오디오 추가 (선택)"}
              </span>
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => { if (e.target.files?.[0]) handleAudioUpload(e.target.files[0]); }}
              />
              <span className="ml-auto flex-shrink-0 text-xs text-zinc-700 group-hover:text-zinc-500 transition-colors border border-zinc-800 rounded px-1.5 py-0.5">
                {audioUrl ? "변경" : "업로드"}
              </span>
            </label>
            {/* 오디오 ref — AudioPlayer 대신 직접 audio 엘리먼트 사용 */}
            {audioUrl && (
              <audio ref={audioRef} src={audioUrl} className="hidden" />
            )}
          </div>

          {/* ── 재생 컨트롤 ─────────────────────────────────────────────── */}
          <div className="flex-shrink-0 flex flex-col gap-2 pt-2 border-t border-zinc-800">
            <div className="flex items-center justify-between text-xs text-zinc-500 font-mono">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
            <div className="relative h-2">
              <input
                type="range" min={0} max={duration || 0} step={0.05} value={currentTime}
                disabled={!hasMedia}
                onMouseDown={handleSeekStart} onTouchStart={handleSeekStart}
                onChange={handleSeekChange} onMouseUp={handleSeekEnd} onTouchEnd={handleSeekEnd}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed z-10"
                aria-label="Timeline"
              />
              <div className="absolute inset-y-0 left-0 right-0 my-auto h-1 rounded-full bg-zinc-800">
                <div className="h-full rounded-full bg-violet-600 transition-none" style={{ width: `${extractProgress}%` }} />
              </div>
            </div>
            <div className="flex items-center justify-center mt-1">
              <button
                onClick={handlePlayPause} disabled={!hasMedia}
                className="flex items-center justify-center w-10 h-10 rounded-full bg-violet-700 hover:bg-violet-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" d="M6.75 5.25a.75.75 0 01.75-.75H9a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H7.5a.75.75 0 01-.75-.75V5.25zm7 0a.75.75 0 01.75-.75h1.5a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75h-1.5a.75.75 0 01-.75-.75V5.25z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            </div>
            <p className="text-center text-xs text-zinc-700">Space to play / pause</p>
          </div>

          {/* ── 모션 녹화 + Supabase 저장 ──────────────────────────────── */}
          <div className="flex-shrink-0 pt-2 border-t border-zinc-800">
            <RecordingControls
              isRecording={isRecording}
              liveFrameCount={liveFrameCount}
              recordedDuration={recordedDuration}
              hasRecording={!!savedRecording && savedRecording.length > 0}
              saveStatus={saveStatus}
              saveError={saveError}
              onToggleRecording={handleToggleRecording}
              onSave={handleSave}
            />
          </div>

          {/* ── 타임라인 프롬프트 에디터 ────────────────────────────────── */}
          <div className="flex-shrink-0 pt-2 border-t border-zinc-800">
            <TimelineEditor
              duration={duration}
              currentTime={currentTime}
              segments={segments}
              onSegmentsChange={setSegments}
              onExport={handleExport}
              recordedFrames={exportFrameCount}
              isPlaying={isPlaying}
            />
          </div>

          {/* ── Kling Export ─────────────────────────────────────────── */}
          <div className="flex-shrink-0 pt-2 border-t border-zinc-800 flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-violet-400">
              Kling Export
            </h2>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-600 mr-1">BG</span>
              <button
                onClick={() => onChangeCaptureBackground("black")}
                disabled={isCapturing3D}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  captureBackground === "black"
                    ? "bg-zinc-700 border-zinc-500 text-zinc-100"
                    : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600"
                }`}
              >
                <span className="w-2.5 h-2.5 rounded-sm bg-black border border-zinc-600 flex-shrink-0" />
                Black
              </button>
              <button
                onClick={() => onChangeCaptureBackground("green")}
                disabled={isCapturing3D}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  captureBackground === "green"
                    ? "bg-zinc-700 border-zinc-500 text-zinc-100"
                    : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600"
                }`}
              >
                <span className="w-2.5 h-2.5 rounded-sm bg-[#00ff00] flex-shrink-0" />
                Green
              </button>
            </div>
            <button
              onClick={onToggle3DCapture}
              className={`flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-xs font-semibold border transition-all ${
                isCapturing3D
                  ? "bg-rose-900/50 border-rose-700 text-rose-300 hover:bg-rose-800/60"
                  : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:border-zinc-600"
              }`}
            >
              {isCapturing3D ? (
                <>
                  <span className="w-2.5 h-2.5 rounded-sm bg-rose-500 animate-pulse" />
                  ⏹ 종료 &amp; 다운로드
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  🎥 3D 모션 영상 추출 (Kling용)
                </>
              )}
            </button>

            {isCapturing3D && (
              <p className="text-xs text-zinc-600 text-center">
                3D 캔버스를 자유롭게 회전하며 녹화하세요 · 완료 후 Toolbox 탭에서 MP4로 변환
              </p>
            )}
          </div>

          {/* ── 모션 도서관 ────────────────────────────────────────────── */}
          <div className="flex-shrink-0 pt-2 border-t border-zinc-800 pb-4">
            <MotionLibrary refreshKey={saveRefreshKey} />
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          DIRECT 모드 — 저장된 모션 + 오디오 동기화 재생
      ══════════════════════════════════════════════════════════════════ */}
      {mode === "direct" && (
        <>
          {/* ── 모션 선택 드롭다운 ──────────────────────────────────────── */}
          <div className="flex-shrink-0 flex flex-col gap-2">
            <p className="text-xs font-semibold text-zinc-400">모션 선택</p>
            {motionSummaries.length === 0 ? (
              <p className="text-xs text-zinc-600 italic">저장된 모션이 없습니다</p>
            ) : (
              <select
                value={selectedMotionId ?? ""}
                onChange={(e) => { if (e.target.value) handleSelectMotion(e.target.value); }}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:border-violet-500 outline-none cursor-pointer"
              >
                <option value="">-- 모션을 선택하세요 --</option>
                {motionSummaries.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            )}

            {/* 모션 로딩/로드 완료 상태 표시 */}
            {isDirectLoadingMotion && (
              <p className="text-xs text-zinc-500 animate-pulse">로딩 중...</p>
            )}
            {isDirectMotionLoaded && (
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-500 flex-shrink-0" />
                <p className="text-xs text-violet-400 truncate">
                  {directMotionName}
                </p>
                <span className="text-xs text-zinc-600 flex-shrink-0">
                  {directFrameCount} frames
                </span>
              </div>
            )}
          </div>

          <hr className="border-zinc-800 flex-shrink-0" />

          {/* ── 오디오 업로드 ────────────────────────────────────────────── */}
          <div className="flex-shrink-0 flex flex-col gap-2">
            <p className="text-xs font-semibold text-zinc-400">오디오</p>
            <label className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg border border-dashed border-zinc-700 cursor-pointer hover:border-zinc-500 transition-colors group">
              <span className="text-xs text-zinc-500 group-hover:text-zinc-400 transition-colors truncate">
                {directAudioUrl ? "🎵 오디오 업로드됨" : "🎵 오디오 파일을 업로드하세요"}
              </span>
              <span className="ml-2 flex-shrink-0 text-xs text-zinc-600 group-hover:text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5 transition-colors">
                {directAudioUrl ? "변경" : "업로드"}
              </span>
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => { if (e.target.files?.[0]) handleDirectAudioUpload(e.target.files[0]); }}
              />
            </label>

            {/* 히든 오디오 엘리먼트 — directAudioRef를 통해 직접 제어 */}
            {directAudioUrl && (
              <audio
                ref={handleAudioCallbackRef}
                src={directAudioUrl}
                onLoadedMetadata={(e) => {
                  const dur = (e.target as HTMLAudioElement).duration;
                  setDirectDuration(dur);
                  setCropStart(0);
                  setCropEnd(dur); // 전체 길이로 자동 초기화
                }}
                onEnded={() => {
                  isDirectPlayingRef.current = false;
                  setIsDirectPlaying(false);
                }}
                className="hidden"
              />
            )}
          </div>

          {/* ── 오디오 구간 설정 (Crop) ──────────────────────────────────
               오디오가 로드되면 기본값: [0, duration]
               설정한 구간 안에서만 오디오+모션이 루프됨
               Kling 녹화 중이면 cropEnd 도달 시 자동 저장
          ─────────────────────────────────────────────────────────── */}
          {directDuration > 0 && (
            <div className="flex-shrink-0 flex flex-col gap-3 pt-2 border-t border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-400">구간 설정</span>
                <button
                  onClick={() => { setCropStart(0); setCropEnd(directDuration); }}
                  className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors px-1.5 py-0.5 rounded border border-zinc-800 hover:border-zinc-700"
                >
                  전체 초기화
                </button>
              </div>

              {/* 파형 시각화 — crop 구간(보라 핸들) + 현재 위치 + 드래그 편집 가능 */}
              <canvas
                ref={waveformCanvasRef}
                width={600}
                height={48}
                className="w-full rounded-lg"
                style={{ imageRendering: "pixelated", cursor: canvasCursor }}
                onMouseDown={(e) => {
                  const canvas = waveformCanvasRef.current;
                  if (!canvas || directDurationRef.current === 0) return;
                  const rect    = canvas.getBoundingClientRect();
                  const relX    = e.clientX - rect.left;
                  const dur     = directDurationRef.current;
                  const hitSec  = (8 / rect.width) * dur;
                  const rawTime = (relX / rect.width) * dur;
                  const dStart  = Math.abs(rawTime - cropStartRef.current);
                  const dEnd    = Math.abs(rawTime - cropEndRef.current);
                  if (dStart <= hitSec || dEnd <= hitSec) {
                    dragTargetRef.current = dStart <= dEnd ? "start" : "end";
                    setCanvasCursor("ew-resize");
                    e.preventDefault();
                  }
                }}
                onMouseMove={(e) => {
                  const canvas = waveformCanvasRef.current;
                  if (!canvas || directDurationRef.current === 0) return;
                  const rect    = canvas.getBoundingClientRect();
                  const relX    = e.clientX - rect.left;
                  const dur     = directDurationRef.current;
                  const rawTime = Math.max(0, Math.min(dur, (relX / rect.width) * dur));

                  if (dragTargetRef.current === "start") {
                    const v = Math.min(rawTime, cropEndRef.current - 0.1);
                    setCropStart(parseFloat(v.toFixed(1)));
                  } else if (dragTargetRef.current === "end") {
                    const v = Math.max(rawTime, cropStartRef.current + 0.1);
                    setCropEnd(parseFloat(v.toFixed(1)));
                  } else {
                    // hover: 핸들 근처면 커서 변경
                    const hitSec = (8 / rect.width) * dur;
                    const near   = Math.abs(rawTime - cropStartRef.current) <= hitSec
                                || Math.abs(rawTime - cropEndRef.current)   <= hitSec;
                    setCanvasCursor(near ? "ew-resize" : "default");
                  }
                }}
                onMouseUp={() => { dragTargetRef.current = null; }}
                onMouseLeave={() => { dragTargetRef.current = null; setCanvasCursor("default"); }}
                onTouchStart={(e) => {
                  const canvas = waveformCanvasRef.current;
                  if (!canvas || directDurationRef.current === 0) return;
                  const rect    = canvas.getBoundingClientRect();
                  const relX    = e.touches[0].clientX - rect.left;
                  const dur     = directDurationRef.current;
                  const hitSec  = (14 / rect.width) * dur; // 터치는 더 넉넉한 판정
                  const rawTime = (relX / rect.width) * dur;
                  const dStart  = Math.abs(rawTime - cropStartRef.current);
                  const dEnd    = Math.abs(rawTime - cropEndRef.current);
                  if (dStart <= hitSec || dEnd <= hitSec) {
                    dragTargetRef.current = dStart <= dEnd ? "start" : "end";
                    e.preventDefault();
                  }
                }}
                onTouchMove={(e) => {
                  if (!dragTargetRef.current) return;
                  const canvas = waveformCanvasRef.current;
                  if (!canvas || directDurationRef.current === 0) return;
                  const rect    = canvas.getBoundingClientRect();
                  const relX    = e.touches[0].clientX - rect.left;
                  const dur     = directDurationRef.current;
                  const rawTime = Math.max(0, Math.min(dur, (relX / rect.width) * dur));
                  if (dragTargetRef.current === "start") {
                    const v = Math.min(rawTime, cropEndRef.current - 0.1);
                    setCropStart(parseFloat(v.toFixed(1)));
                  } else {
                    const v = Math.max(rawTime, cropStartRef.current + 0.1);
                    setCropEnd(parseFloat(v.toFixed(1)));
                  }
                  e.preventDefault();
                }}
                onTouchEnd={() => { dragTargetRef.current = null; }}
              />

              {/* 시작/종료 시간 입력 — onBlur에서만 검증해 타이핑 중 스냅백 방지 */}
              <div className="flex items-end gap-2">
                <div className="flex-1 flex flex-col gap-1">
                  <span className="text-[10px] text-zinc-600">시작 (초)</span>
                  <input
                    type="number"
                    step={0.1}
                    value={cropStartText}
                    onChange={(e) => setCropStartText(e.target.value)}
                    onBlur={() => {
                      const v = parseFloat(cropStartText);
                      if (!isNaN(v) && v >= 0 && v < cropEnd) {
                        setCropStart(parseFloat(v.toFixed(1)));
                      } else {
                        setCropStartText(cropStart.toFixed(1));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                    className="w-full bg-zinc-800 border border-zinc-700 focus:border-violet-500 rounded-lg px-2 py-1.5 text-xs text-zinc-200 outline-none text-center font-mono"
                  />
                </div>
                <span className="text-zinc-700 text-xs pb-1.5">→</span>
                <div className="flex-1 flex flex-col gap-1">
                  <span className="text-[10px] text-zinc-600">종료 (초)</span>
                  <input
                    type="number"
                    step={0.1}
                    value={cropEndText}
                    onChange={(e) => setCropEndText(e.target.value)}
                    onBlur={() => {
                      const v = parseFloat(cropEndText);
                      if (!isNaN(v) && v > cropStart && v <= directDuration) {
                        setCropEnd(parseFloat(v.toFixed(1)));
                      } else {
                        setCropEndText(cropEnd.toFixed(1));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                    className="w-full bg-zinc-800 border border-zinc-700 focus:border-violet-500 rounded-lg px-2 py-1.5 text-xs text-zinc-200 outline-none text-center font-mono"
                  />
                </div>
              </div>

              {/* 구간 길이 표시 */}
              <p className="text-center text-[10px] text-zinc-600 font-mono">
                구간 길이: <span className="text-zinc-400">{formatTime(cropEnd - cropStart)}</span>
                {isCapturing3D && (
                  <span className="ml-2 text-rose-400">· 구간 종료 시 자동 저장</span>
                )}
              </p>
            </div>
          )}

          {/* ── Auto-Mix: AI 자동 안무 조립 ──────────────────────────────
               Supabase 모션들을 무작위로 3~4개 선택해 4~8초씩 이어붙임.
               클립 전환 구간(±0.3초)은 선형 보간으로 매끄럽게 처리.
          ─────────────────────────────────────────────────────────── */}
          <div className="flex-shrink-0 flex flex-col gap-3 pt-2 border-t border-zinc-800">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-400">✨ Auto-Mix</span>
              {autoClips.length > 0 && (
                <button
                  onClick={handleClearAutoMix}
                  className="text-[10px] text-zinc-600 hover:text-rose-400 transition-colors border border-zinc-800 hover:border-rose-800 rounded px-1.5 py-0.5"
                >
                  초기화
                </button>
              )}
            </div>

            {/* 피니쉬 모션 선택 */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 flex-shrink-0">피니쉬</span>
              <select
                value={finishMotionId ?? ""}
                onChange={(e) => setFinishMotionId(e.target.value || null)}
                className="flex-1 min-w-0 text-[10px] bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 text-zinc-300 focus:outline-none focus:border-violet-600 appearance-none cursor-pointer"
              >
                <option value="">랜덤 (없음)</option>
                {motionSummaries.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={handleAutoMix}
              disabled={isAutoMixLoading}
              className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-xs font-semibold border transition-all bg-violet-900/40 border-violet-700 text-violet-300 hover:bg-violet-800/50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isAutoMixLoading ? (
                <>
                  <span className="w-3 h-3 rounded-full border-2 border-violet-400 border-t-transparent animate-spin flex-shrink-0" />
                  안무 생성 중...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                  </svg>
                  AI 자동 안무 생성
                </>
              )}
            </button>

            {autoMixError && (
              <p className="text-[10px] text-rose-400">{autoMixError}</p>
            )}

            {autoClips.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {autoClips.map((clip, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded border ${
                      clip.isFinish
                        ? "bg-amber-950/40 border-amber-800/60"
                        : "bg-zinc-900 border-zinc-800"
                    }`}
                  >
                    <span className={`text-[10px] font-mono w-4 flex-shrink-0 ${clip.isFinish ? "text-amber-400" : "text-violet-400"}`}>
                      {clip.isFinish ? "🏁" : i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="h-1 rounded-full bg-zinc-700 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${clip.isFinish ? "bg-amber-500" : "bg-violet-600"}`}
                          style={{ width: `${((clip.endAudioTime - clip.startAudioTime) / (autoClips[autoClips.length - 1].endAudioTime || 1)) * 100}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-zinc-500 flex-shrink-0">
                      {(clip.endAudioTime - clip.startAudioTime).toFixed(1)}s
                    </span>
                    <span className="text-[10px] font-mono text-zinc-600 flex-shrink-0">
                      {clip.isFinish ? "FINISH" : `${clip.playbackSpeed.toFixed(2)}x`}
                    </span>
                  </div>
                ))}
                <p className="text-[10px] text-zinc-600 text-center font-mono">
                  총 {autoClips[autoClips.length - 1].endAudioTime.toFixed(1)}초 · {autoClips.length}클립
                </p>
              </div>
            )}
          </div>

          {/* ── 루프 + 배속 설정 ────────────────────────────────────────── */}
          <div className="flex-shrink-0 flex flex-col gap-3 pt-2 border-t border-zinc-800">
            {/* 루프 토글 */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">모션 무한 반복</span>
              <button
                onClick={() => setIsLooping((v) => !v)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border transition-all ${
                  isLooping
                    ? "bg-violet-700/40 border-violet-600 text-violet-300"
                    : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600"
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                {isLooping ? "ON" : "OFF"}
              </button>
            </div>

            {/* 배속 슬라이더 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-400">재생 배속</span>
                <span className="text-xs font-mono font-semibold text-violet-300">
                  {playbackSpeed.toFixed(1)}x
                </span>
              </div>
              <div className="relative h-4 flex items-center">
                <input
                  type="range"
                  min={0.5}
                  max={2.0}
                  step={0.1}
                  value={playbackSpeed}
                  onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                  className="w-full h-1 rounded-full appearance-none cursor-pointer bg-zinc-700 accent-violet-500"
                  aria-label="Playback speed"
                />
              </div>
              <div className="flex justify-between text-[10px] text-zinc-700 font-mono">
                <span>0.5x</span>
                <span>1.0x</span>
                <span>2.0x</span>
              </div>
            </div>
          </div>

          {/* ── Motion Modifiers ─────────────────────────────────────────
               findNearestFrame() 이후, 렌더링 직전에 수학 연산으로 랜드마크 변형.
               원본 motion_data는 절대 훼손되지 않는다 (deep copy 후 변형).
          ─────────────────────────────────────────────────────────── */}
          <div className="flex-shrink-0 flex flex-col gap-3 pt-2 border-t border-zinc-800">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-400">Motion Modifiers</span>
              <button
                onClick={handleAddEffect}
                className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-violet-400 transition-colors border border-zinc-700 hover:border-violet-600 rounded px-1.5 py-0.5"
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                효과 추가
              </button>
            </div>

            {timelineEffects.length === 0 && (
              <p className="text-[10px] text-zinc-700 italic">추가된 효과 없음</p>
            )}

            {timelineEffects.map((eff) => (
              <div key={eff.id} className="flex flex-col gap-2 bg-zinc-900 rounded-lg p-2.5 border border-zinc-800">
                {/* 효과 종류 + 강도 값 + 삭제 */}
                <div className="flex items-center gap-2">
                  <select
                    value={eff.type}
                    onChange={(e) => handleUpdateEffect(eff.id, { type: e.target.value as EffectType })}
                    className="flex-1 bg-zinc-800 border border-zinc-700 focus:border-violet-500 rounded px-2 py-1 text-xs text-zinc-200 outline-none cursor-pointer"
                  >
                    <option value="bounce">🎯 Bounce</option>
                    <option value="wider_arms">💪 Wider Arms</option>
                  </select>
                  <span className="text-xs font-mono text-violet-300 w-8 text-right flex-shrink-0">
                    {eff.intensity.toFixed(1)}
                  </span>
                  <button
                    onClick={() => handleRemoveEffect(eff.id)}
                    className="text-zinc-600 hover:text-rose-400 transition-colors flex-shrink-0"
                    aria-label="효과 삭제"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {/* 강도 슬라이더 */}
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={eff.intensity}
                  onChange={(e) => handleUpdateEffect(eff.id, { intensity: parseFloat(e.target.value) })}
                  className="w-full h-1 rounded-full appearance-none cursor-pointer bg-zinc-700 accent-violet-500"
                />

                {/* 활성화 구간 (초) */}
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    max={parseFloat((eff.endTime - 0.5).toFixed(1))}
                    step={0.5}
                    value={parseFloat(eff.startTime.toFixed(1))}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v >= 0 && v < eff.endTime)
                        handleUpdateEffect(eff.id, { startTime: v });
                    }}
                    className="w-16 bg-zinc-800 border border-zinc-700 focus:border-violet-500 rounded px-1.5 py-1 text-[10px] text-zinc-200 outline-none text-center font-mono"
                  />
                  <span className="text-zinc-700 text-xs">→</span>
                  <input
                    type="number"
                    min={parseFloat((eff.startTime + 0.5).toFixed(1))}
                    max={parseFloat(directDuration.toFixed(1))}
                    step={0.5}
                    value={parseFloat(eff.endTime.toFixed(1))}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v > eff.startTime && v <= directDuration)
                        handleUpdateEffect(eff.id, { endTime: v });
                    }}
                    className="w-16 bg-zinc-800 border border-zinc-700 focus:border-violet-500 rounded px-1.5 py-1 text-[10px] text-zinc-200 outline-none text-center font-mono"
                  />
                  <span className="text-[10px] text-zinc-600 ml-auto">초</span>
                </div>
              </div>
            ))}
          </div>

          {/* ── 재생 컨트롤 ─────────────────────────────────────────────── */}
          <div className="flex-shrink-0 flex flex-col gap-2 pt-2 border-t border-zinc-800">
            <div className="flex items-center justify-between text-xs text-zinc-500 font-mono">
              <span>{formatTime(directTime)}</span>
              <span>{formatTime(directDuration)}</span>
            </div>

            {/* 시크 바 */}
            <div className="relative h-2">
              <input
                type="range"
                min={0}
                max={directDuration || 0}
                step={0.05}
                value={directTime}
                disabled={!directAudioUrl}
                onMouseDown={handleDirectSeekStart}
                onTouchStart={handleDirectSeekStart}
                onChange={handleDirectSeekChange}
                onMouseUp={handleDirectSeekEnd}
                onTouchEnd={handleDirectSeekEnd}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed z-10"
                aria-label="Direct Timeline"
              />
              <div className="absolute inset-y-0 left-0 right-0 my-auto h-1 rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-violet-600 transition-none"
                  style={{ width: `${directProgress}%` }}
                />
              </div>
            </div>

            {/* 재생/일시정지 버튼 */}
            <div className="flex items-center justify-center mt-1">
              <button
                onClick={handleDirectPlayPause}
                disabled={!canDirectPlay}
                className="flex items-center justify-center w-10 h-10 rounded-full bg-violet-700 hover:bg-violet-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
                aria-label={isDirectPlaying ? "Pause" : "Play"}
              >
                {isDirectPlaying ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" d="M6.75 5.25a.75.75 0 01.75-.75H9a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H7.5a.75.75 0 01-.75-.75V5.25zm7 0a.75.75 0 01.75-.75h1.5a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75h-1.5a.75.75 0 01-.75-.75V5.25z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            </div>

            {/* 재생 가이드 메시지 */}
            {!isDirectMotionLoaded && autoClips.length === 0 && (
              <p className="text-center text-xs text-zinc-700">모션을 선택하거나 Auto-Mix를 생성하세요</p>
            )}
            {isDirectMotionLoaded && !directAudioUrl && (
              <p className="text-center text-xs text-zinc-700">오디오를 업로드하면 재생 가능합니다</p>
            )}
            {canDirectPlay && !isDirectPlaying && (
              <p className="text-center text-xs text-zinc-700">Space to play / pause</p>
            )}
          </div>

          {/* ── Kling Export (Direct 모드에서도 사용 가능) ─────────────── */}
          <div className="flex-shrink-0 pt-2 border-t border-zinc-800 flex flex-col gap-2 pb-4">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-violet-400">
              Kling Export
            </h2>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-600 mr-1">BG</span>
              <button
                onClick={() => onChangeCaptureBackground("black")}
                disabled={isCapturing3D}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  captureBackground === "black"
                    ? "bg-zinc-700 border-zinc-500 text-zinc-100"
                    : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600"
                }`}
              >
                <span className="w-2.5 h-2.5 rounded-sm bg-black border border-zinc-600 flex-shrink-0" />
                Black
              </button>
              <button
                onClick={() => onChangeCaptureBackground("green")}
                disabled={isCapturing3D}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  captureBackground === "green"
                    ? "bg-zinc-700 border-zinc-500 text-zinc-100"
                    : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600"
                }`}
              >
                <span className="w-2.5 h-2.5 rounded-sm bg-[#00ff00] flex-shrink-0" />
                Green
              </button>
            </div>
            <button
              onClick={onToggle3DCapture}
              className={`flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-xs font-semibold border transition-all ${
                isCapturing3D
                  ? "bg-rose-900/50 border-rose-700 text-rose-300 hover:bg-rose-800/60"
                  : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:border-zinc-600"
              }`}
            >
              {isCapturing3D ? (
                <>
                  <span className="w-2.5 h-2.5 rounded-sm bg-rose-500 animate-pulse" />
                  ⏹ 종료 &amp; 다운로드
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  🎥 3D 모션 영상 추출 (Kling용)
                </>
              )}
            </button>

            {isCapturing3D && (
              <p className="text-xs text-zinc-600 text-center">
                3D 캔버스를 자유롭게 회전하며 녹화하세요 · 완료 후 Toolbox 탭에서 MP4로 변환
              </p>
            )}
          </div>
        </>
      )}
    </div>
    </>
  );
}
