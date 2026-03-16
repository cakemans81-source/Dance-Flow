"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import VideoPlayer from "./VideoPlayer";
import AudioPlayer from "./AudioPlayer";
import TimelineEditor, { type Segment } from "./TimelineEditor";
import RecordingControls from "./RecordingControls";
import { saveMotion, type MotionFrame } from "@/lib/supabase";
import type { Landmark3D } from "@/hooks/usePose";

type SaveStatus = "idle" | "saving" | "success" | "error";

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface ControlPanelProps {
  onLandmarksUpdate: (landmarks: Landmark3D[] | null) => void;
}

export default function ControlPanel({ onLandmarksUpdate }: ControlPanelProps) {
  // ── 미디어 상태 ────────────────────────────────────────────────────────────
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // ── 타임라인 프롬프트 구간 ─────────────────────────────────────────────────
  const [segments, setSegments] = useState<Segment[]>([]);

  // ── 명시적 모션 녹화 상태 ─────────────────────────────────────────────────
  // isRecording: 유저가 ⏺ 버튼으로 켜고 끄는 명시적 녹화 토글
  // motionFramesRef: 실제 데이터 버퍼. useState 대신 ref 사용 → 매 프레임 저장해도 리렌더 없음
  // savedRecording: 녹화 종료 후 저장 버튼을 활성화하기 위한 확정 데이터
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);                       // 콜백 stale closure 방지
  const motionFramesRef = useRef<MotionFrame[]>([]);          // 성능 핵심: ref로 누적
  const recordLastTimeRef = useRef<number>(-1);               // 10fps 스로틀용
  const [savedRecording, setSavedRecording] = useState<MotionFrame[] | null>(null);
  const [liveFrameCount, setLiveFrameCount] = useState(0);   // 1초마다 갱신

  // isRecording state → ref 동기화 (콜백 내부에서 최신값 참조)
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);

  // 1초마다 liveFrameCount를 ref.length로 동기화 (setInterval이 listRef를 직접 관찰)
  useEffect(() => {
    const id = setInterval(() => {
      if (isRecordingRef.current) {
        setLiveFrameCount(motionFramesRef.current.length);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Supabase 저장 상태 ────────────────────────────────────────────────────
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── 기존 Export 기능 (TimelineEditor용) ─────────────────────────────────
  // 재생 중 자동 누적되는 export 레코드 (TimelineEditor의 전체 구간용)
  const exportFramesRef = useRef<MotionFrame[]>([]);
  const exportLastTimeRef = useRef<number>(-1);
  const [exportFrameCount, setExportFrameCount] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setExportFrameCount(exportFramesRef.current.length), 1000);
    return () => clearInterval(id);
  }, []);

  // ── isPlaying ref (콜백 stale closure 방지) ──────────────────────────────
  const isPlayingRef = useRef(false);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const isSeeking = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const prevVideoUrlRef = useRef<string | null>(null);
  const prevAudioUrlRef = useRef<string | null>(null);

  // ── Object URL 생명주기 ────────────────────────────────────────────────────
  const handleVideoUpload = useCallback((file: File) => {
    if (prevVideoUrlRef.current) URL.revokeObjectURL(prevVideoUrlRef.current);
    const url = URL.createObjectURL(file);
    prevVideoUrlRef.current = url;
    setVideoUrl(url);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    // 새 영상 업로드 시 모든 버퍼 초기화
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
    };
  }, []);

  // ── duration → 구간 초기화 ────────────────────────────────────────────────
  useEffect(() => {
    if (duration > 0) {
      setSegments([{ id: "1", startTime: 0, endTime: duration, motionStyle: "", details: "" }]);
    } else {
      setSegments([]);
    }
  }, [duration]);

  // ── 랜드마크 업데이트 인터셉터 ─────────────────────────────────────────────
  // MediaPipe → 여기서 두 버퍼에 동시 기록 → 3D 캔버스로 전달
  //
  // 두 버퍼:
  //  1. motionFramesRef  : ⏺ 버튼으로 명시 녹화 중일 때만 누적 (Supabase 저장용)
  //  2. exportFramesRef  : 재생 중 항상 누적 (TimelineEditor Export용)
  //
  // 스로틀: 각 버퍼 독립적으로 0.1초(10fps) 제한
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

    // Export 버퍼 (항상 누적)
    if (vTime - exportLastTimeRef.current >= 0.1) {
      exportFramesRef.current.push(frame);
      exportLastTimeRef.current = vTime;
    }

    // 명시 녹화 버퍼 (⏺ 버튼 ON일 때만)
    if (isRecordingRef.current && vTime - recordLastTimeRef.current >= 0.1) {
      motionFramesRef.current.push(frame);
      recordLastTimeRef.current = vTime;
    }
  }, [onLandmarksUpdate]);

  // ── ⏺ 녹화 토글 ────────────────────────────────────────────────────────────
  const handleToggleRecording = useCallback(() => {
    if (isRecordingRef.current) {
      // 녹화 종료: 현재 버퍼를 savedRecording으로 확정
      const recorded = [...motionFramesRef.current];
      setSavedRecording(recorded.length > 0 ? recorded : null);
      setLiveFrameCount(recorded.length);
      setIsRecording(false);
      setSaveStatus("idle");
      setSaveError(null);
    } else {
      // 녹화 시작: 버퍼 초기화
      motionFramesRef.current = [];
      recordLastTimeRef.current = -1;
      setLiveFrameCount(0);
      setSavedRecording(null);
      setSaveStatus("idle");
      setSaveError(null);
      setIsRecording(true);
    }
  }, []);

  // ── ☁️ Supabase 저장 ────────────────────────────────────────────────────────
  // window.prompt()로 댄스 이름을 받은 뒤 motions 테이블에 insert
  const handleSave = useCallback(async () => {
    if (!savedRecording || savedRecording.length === 0) return;

    // 댄스 이름 입력 (prompt → 추후 모달로 교체 가능)
    const motionName = window.prompt(
      "댄스 이름을 입력하세요\n(예: 기본 힙합 바운스)",
      ""
    );
    if (motionName === null) return; // 취소
    if (motionName.trim() === "") {
      alert("이름을 입력해 주세요.");
      return;
    }

    setSaveStatus("saving");
    setSaveError(null);

    try {
      const { id } = await saveMotion(motionName.trim(), savedRecording);
      console.log(`[DanceFlow] 모션 저장 완료 → id: ${id}, name: "${motionName.trim()}", frames: ${savedRecording.length}`);
      setSaveStatus("success");
      // 3초 후 성공 메시지 자동 초기화
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "알 수 없는 오류";
      console.error("[DanceFlow] Supabase 저장 실패:", msg);
      setSaveError(msg);
      setSaveStatus("error");
    }
  }, [savedRecording]);

  // ── TimelineEditor Export ─────────────────────────────────────────────────
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

  // ── 재생 제어 ─────────────────────────────────────────────────────────────
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
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        handlePlayPause();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlePlayPause]);

  // ── 녹화된 길이 계산 ──────────────────────────────────────────────────────
  const recordedDuration = (() => {
    const frames = isRecording ? motionFramesRef.current : (savedRecording ?? []);
    if (frames.length < 2) return 0;
    return frames[frames.length - 1].time - frames[0].time;
  })();

  const hasMedia = videoUrl || audioUrl;
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex flex-col h-full gap-4 p-4 overflow-y-auto custom-scrollbar">
      {/* 앱 타이틀 */}
      <div className="flex-shrink-0">
        <h1 className="text-base font-bold text-zinc-100 tracking-tight">
          Dance Flow <span className="text-violet-500">Studio</span>
        </h1>
        <p className="text-xs text-zinc-600 mt-0.5">AI Motion Directing</p>
      </div>

      <hr className="border-zinc-800 flex-shrink-0" />

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

      {/* 오디오 플레이어 */}
      <div className="flex-shrink-0">
        <AudioPlayer
          audioUrl={audioUrl}
          isPlaying={isPlaying}
          currentTime={currentTime}
          onFileUpload={handleAudioUpload}
          audioRef={audioRef}
        />
      </div>

      {/* ── 재생 컨트롤 ──────────────────────────────────────────────────── */}
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
            <div className="h-full rounded-full bg-violet-600 transition-none" style={{ width: `${progress}%` }} />
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

      {/* ── 모션 녹화 + Supabase 저장 ───────────────────────────────────── */}
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

      {/* ── 타임라인 프롬프트 에디터 ────────────────────────────────────── */}
      <div className="flex-shrink-0 pt-2 border-t border-zinc-800 pb-4">
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
    </div>
  );
}
