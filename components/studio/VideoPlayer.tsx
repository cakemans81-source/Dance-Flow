"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { usePose, type Landmark3D } from "@/hooks/usePose";

interface VideoPlayerProps {
  videoUrl: string | null;
  isPlaying: boolean;
  currentTime: number;
  onDurationChange: (duration: number) => void;
  onTimeUpdate: (time: number) => void;
  onFileUpload: (file: File) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** 추출된 3D 랜드마크를 부모(ControlPanel)로 전달 */
  onLandmarksUpdate: (landmarks: Landmark3D[] | null) => void;
}

export default function VideoPlayer({
  videoUrl,
  isPlaying,
  currentTime,
  onDurationChange,
  onTimeUpdate,
  onFileUpload,
  videoRef,
  onLandmarksUpdate,
}: VideoPlayerProps) {
  // 비디오 메타데이터 로드 완료 여부 → usePose 초기화 트리거
  const [isVideoLoaded, setIsVideoLoaded] = useState(false);

  // 비디오 URL이 바뀌면 로드 상태 초기화
  useEffect(() => {
    setIsVideoLoaded(false);
  }, [videoUrl]);

  // ── MediaPipe Pose 훅 ────────────────────────────────────────────────────
  // canvasRef: 오버레이 캔버스 — 비디오 위에 absolute로 올라간다
  const { canvasRef } = usePose({
    videoRef,
    isVideoLoaded,
    isPlaying,
    onLandmarks: onLandmarksUpdate,
  });

  // ── 외부 재생 상태 → video 엘리먼트 동기화 ──────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl) return;
    if (isPlaying) {
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[VideoPlayer] play() failed:", err);
        }
      });
    } else {
      video.pause();
    }
  }, [isPlaying, videoUrl, videoRef]);

  // ── 외부 seek → video 동기화 ─────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (Math.abs(video.currentTime - currentTime) > 0.5) {
      video.currentTime = currentTime;
    }
  }, [currentTime, videoRef]);

  // ── 파일 업로드 ───────────────────────────────────────────────────────────
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && file.type.startsWith("video/")) onFileUpload(file);
      e.target.value = "";
    },
    [onFileUpload]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith("video/")) onFileUpload(file);
    },
    [onFileUpload]
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-violet-400">
          Reference Video
        </h2>
        {videoUrl && (
          <label className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            Change
            <input type="file" accept="video/*" className="hidden" onChange={handleFileChange} />
          </label>
        )}
      </div>

      {/* ── 비디오 컨테이너: video + 오버레이 캔버스 ────────────────────────
          relative 포지션으로 자식 absolute 요소들의 기준점이 된다.
          캔버스는 inset-0으로 비디오 컨테이너를 완전히 덮는다.
          pointer-events-none으로 비디오 클릭 이벤트가 통과하게 한다.
      ──────────────────────────────────────────────────────────────────── */}
      <div
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className="relative w-full aspect-video rounded-lg overflow-hidden bg-zinc-900 border border-zinc-800"
      >
        {videoUrl ? (
          <>
            <video
              ref={videoRef}
              src={videoUrl}
              className="w-full h-full object-contain"
              onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => {
                onDurationChange(e.currentTarget.duration);
                setIsVideoLoaded(true); // Pose 초기화 트리거
              }}
              onEnded={() => {
                if (videoRef.current) onTimeUpdate(videoRef.current.duration);
              }}
              playsInline
            />

            {/* 스켈레톤 오버레이 캔버스
                - absolute inset-0: 비디오와 동일한 영역을 덮음
                - pointer-events-none: 비디오 인터랙션 방해 안 함
                - usePose 훅이 이 ref를 받아 직접 드로잉 */}
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />

            {/* MediaPipe 로딩 인디케이터 */}
            {videoUrl && !isVideoLoaded && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <span className="text-xs text-zinc-400">Loading video...</span>
              </div>
            )}
          </>
        ) : (
          <label className="flex flex-col items-center justify-center w-full h-full cursor-pointer group">
            <svg
              className="w-10 h-10 text-zinc-600 group-hover:text-violet-500 transition-colors mb-2"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
              />
            </svg>
            <span className="text-sm text-zinc-500 group-hover:text-zinc-300 transition-colors">
              Drop video or click to upload
            </span>
            <span className="text-xs text-zinc-700 mt-1">.mp4, .mov, .webm</span>
            <input type="file" accept="video/*" className="hidden" onChange={handleFileChange} />
          </label>
        )}
      </div>
    </div>
  );
}
