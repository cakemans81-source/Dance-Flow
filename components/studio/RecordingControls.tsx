"use client";

/**
 * RecordingControls — 모션 녹화 + Supabase 저장 UI
 *
 * 상태 흐름:
 *  idle → [⏺ 녹화 시작] → recording → [⏹ 녹화 종료] → recorded
 *  recorded → [☁️ 저장] → saving → success / error
 *
 * 모든 무거운 로직(데이터 누적, DB insert)은 부모(ControlPanel)가 담당.
 * 이 컴포넌트는 UI + 상태 표시만 처리한다.
 */

type SaveStatus = "idle" | "saving" | "success" | "error";

interface RecordingControlsProps {
  isRecording: boolean;
  /** 재생 중 실시간으로 증가하는 녹화 프레임 수 */
  liveFrameCount: number;
  /** 녹화된 총 길이 (초) */
  recordedDuration: number;
  /** 저장 가능한 완성 녹화 존재 여부 */
  hasRecording: boolean;
  saveStatus: SaveStatus;
  saveError: string | null;
  onToggleRecording: () => void;
  onSave: () => void;
}

function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "0.0s";
  return `${sec.toFixed(1)}s`;
}

export default function RecordingControls({
  isRecording,
  liveFrameCount,
  recordedDuration,
  hasRecording,
  saveStatus,
  saveError,
  onToggleRecording,
  onSave,
}: RecordingControlsProps) {
  return (
    <div className="flex flex-col gap-2">
      {/* 섹션 헤더 */}
      <h2 className="text-xs font-semibold uppercase tracking-widest text-violet-400">
        Motion Recording
      </h2>

      {/* 버튼 행 */}
      <div className="flex gap-2">
        {/* ⏺/⏹ 녹화 토글 버튼 */}
        <button
          onClick={onToggleRecording}
          className={`flex items-center gap-1.5 flex-1 justify-center py-2 rounded-lg text-xs font-semibold transition-all border ${
            isRecording
              ? "bg-rose-900/50 border-rose-700 text-rose-300 hover:bg-rose-800/60"
              : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:border-zinc-600"
          }`}
        >
          {isRecording ? (
            <>
              {/* 녹화 중: 펄스 애니메이션 */}
              <span className="w-2.5 h-2.5 rounded-sm bg-rose-500 animate-pulse" />
              Stop
            </>
          ) : (
            <>
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
              Record
            </>
          )}
        </button>

        {/* ☁️ Supabase 저장 버튼 */}
        <button
          onClick={onSave}
          disabled={!hasRecording || saveStatus === "saving"}
          className="flex items-center gap-1.5 flex-1 justify-center py-2 rounded-lg text-xs font-semibold transition-all border disabled:opacity-30 disabled:cursor-not-allowed bg-indigo-900/40 border-indigo-800 text-indigo-300 hover:bg-indigo-800/60 hover:border-indigo-600 disabled:hover:bg-indigo-900/40 disabled:hover:border-indigo-800"
        >
          {saveStatus === "saving" ? (
            <>
              {/* 저장 중 스피너 */}
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Saving...
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
              </svg>
              Save to DB
            </>
          )}
        </button>
      </div>

      {/* 상태 인디케이터 */}
      {isRecording && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-rose-950/30 border border-rose-900/50">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse flex-shrink-0" />
          <span className="text-xs font-mono text-rose-400">
            REC {liveFrameCount} frames
          </span>
        </div>
      )}

      {/* 녹화 완료 (저장 대기 중) */}
      {!isRecording && hasRecording && saveStatus === "idle" && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-zinc-800/60 border border-zinc-700">
          <svg className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" fill="none" stroke="currentColor"
            strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-xs text-zinc-400 font-mono">
            {liveFrameCount} frames · {formatDuration(recordedDuration)} ready
          </span>
        </div>
      )}

      {/* 저장 성공 */}
      {saveStatus === "success" && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-emerald-950/30 border border-emerald-900/50">
          <svg className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor"
            strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-xs text-emerald-400">Saved to Supabase!</span>
        </div>
      )}

      {/* 저장 실패 */}
      {saveStatus === "error" && saveError && (
        <div className="flex items-start gap-2 px-2 py-1.5 rounded bg-rose-950/30 border border-rose-900/50">
          <svg className="w-3.5 h-3.5 text-rose-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor"
            strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <span className="text-xs text-rose-400 break-all">{saveError}</span>
        </div>
      )}
    </div>
  );
}
