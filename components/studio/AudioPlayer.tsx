"use client";

import { useRef, useEffect, useCallback, useState } from "react";

interface AudioPlayerProps {
  /** 업로드된 오디오 파일의 Object URL */
  audioUrl: string | null;
  /** 외부 통합 재생 상태 */
  isPlaying: boolean;
  /** 현재 재생 시간 (타임라인 seek 동기화용) */
  currentTime: number;
  /** 파일 업로드 핸들러 */
  onFileUpload: (file: File) => void;
  /** audio 엘리먼트를 부모가 직접 제어할 수 있도록 ref 전달 */
  audioRef: React.RefObject<HTMLAudioElement | null>;
}

export default function AudioPlayer({
  audioUrl,
  isPlaying,
  currentTime,
  onFileUpload,
  audioRef,
}: AudioPlayerProps) {
  // 볼륨 슬라이더 로컬 상태 (0~1)
  const [volume, setVolume] = useState(0.8);
  // 음소거 토글
  const [isMuted, setIsMuted] = useState(false);
  // 오디오 파일명 표시용
  const [fileName, setFileName] = useState<string | null>(null);

  // ── 외부 isPlaying 상태 → audio 엘리먼트 동기화 ─────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;

    if (isPlaying) {
      audio.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[AudioPlayer] play() failed:", err);
        }
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, audioUrl, audioRef]);

  // ── 외부 seek → audio 동기화 (비디오와 동일 로직) ────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Math.abs(audio.currentTime - currentTime) > 0.5) {
      audio.currentTime = currentTime;
    }
  }, [currentTime, audioRef]);

  // ── 볼륨 변경 ─────────────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = isMuted ? 0 : volume;
  }, [volume, isMuted, audioRef]);

  // ── 파일 업로드 처리 ─────────────────────────────────────────────────
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && file.type.startsWith("audio/")) {
        setFileName(file.name);
        onFileUpload(file);
      }
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
      if (file && file.type.startsWith("audio/")) {
        setFileName(file.name);
        onFileUpload(file);
      }
    },
    [onFileUpload]
  );

  return (
    <div className="flex flex-col gap-2">
      {/* 섹션 헤더 */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-violet-400">
          Background Music
        </h2>
        {audioUrl && (
          <label className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            Change
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </label>
        )}
      </div>

      {/* audio 태그: 화면에 보이지 않고 ref로만 제어 */}
      <audio ref={audioRef} src={audioUrl ?? undefined} preload="metadata" />

      {audioUrl ? (
        /* 오디오 로드된 상태: 파형 시각화 대신 파일명 + 볼륨 컨트롤 표시 */
        <div className="flex flex-col gap-3 rounded-lg bg-zinc-900 border border-zinc-800 p-3">
          {/* 파일명 + 재생 상태 인디케이터 */}
          <div className="flex items-center gap-2 overflow-hidden">
            {/* 재생 중일 때 펄스 애니메이션 */}
            <span
              className={`flex-shrink-0 w-2 h-2 rounded-full ${
                isPlaying ? "bg-violet-500 animate-pulse" : "bg-zinc-600"
              }`}
            />
            <span className="text-xs text-zinc-400 truncate">
              {fileName ?? "audio file"}
            </span>
          </div>

          {/* 볼륨 컨트롤 */}
          <div className="flex items-center gap-2">
            {/* 음소거 버튼 */}
            <button
              onClick={() => setIsMuted((prev) => !prev)}
              className="flex-shrink-0 text-zinc-400 hover:text-zinc-200 transition-colors"
              aria-label={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted || volume === 0 ? (
                /* 음소거 아이콘 */
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                </svg>
              ) : (
                /* 볼륨 아이콘 */
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                </svg>
              )}
            </button>

            {/* 볼륨 슬라이더 */}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setVolume(val);
                if (val > 0) setIsMuted(false);
              }}
              className="flex-1 h-1 accent-violet-500 cursor-pointer"
              aria-label="Volume"
            />

            <span className="text-xs text-zinc-600 w-7 text-right">
              {isMuted ? "0" : Math.round(volume * 100)}
            </span>
          </div>
        </div>
      ) : (
        /* 오디오 없는 상태: 드롭존 */
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className="flex items-center justify-center rounded-lg bg-zinc-900 border border-dashed border-zinc-700 h-16 cursor-pointer group hover:border-violet-700 transition-colors"
        >
          <label className="flex items-center gap-2 cursor-pointer">
            <svg
              className="w-5 h-5 text-zinc-600 group-hover:text-violet-500 transition-colors"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
            </svg>
            <span className="text-sm text-zinc-500 group-hover:text-zinc-300 transition-colors">
              Drop music or click to upload
            </span>
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </label>
        </div>
      )}
    </div>
  );
}
