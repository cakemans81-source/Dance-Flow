"use client";

/**
 * TimelineEditor — 타임라인 구간별 프롬프트 에디터
 *
 * 유저가 '+'로 현재 재생 위치에서 구간을 쪼개고,
 * 각 구간에 모션 스타일 / 디테일 수정 프롬프트를 입력한다.
 * 나중에 AI 백엔드에 전달할 구조화된 디렉팅 데이터를 생성한다.
 */

import { useCallback } from "react";

// ── 타입 정의 (ControlPanel에서 import) ──────────────────────────────────────
export type Segment = {
  id: string;          // 고유 ID (단조증가 카운터)
  startTime: number;   // 구간 시작 (초)
  endTime: number;     // 구간 끝 (초)
  motionStyle: string; // "힙합 바운스" 등
  details: string;     // "어깨를 강하게 튕기기" 등
};

// 구간별 왼쪽 테두리 색상 팔레트
const ACCENT_COLORS = [
  "#7c3aed", // violet
  "#2563eb", // blue
  "#059669", // emerald
  "#d97706", // amber
  "#e11d48", // rose
];

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface TimelineEditorProps {
  duration: number;
  currentTime: number;
  segments: Segment[];
  onSegmentsChange: (segments: Segment[]) => void;
  /** 콘솔 출력 트리거 — 실제 데이터 조합은 ControlPanel이 담당 */
  onExport: () => void;
  /** 녹화된 총 프레임 수 (UI 피드백용) */
  recordedFrames: number;
  isPlaying: boolean;
}

let segIdCounter = 1; // 간단한 고유 ID 생성 (uuid 불필요)

export default function TimelineEditor({
  duration,
  currentTime,
  segments,
  onSegmentsChange,
  onExport,
  recordedFrames,
  isPlaying,
}: TimelineEditorProps) {

  // ── '+' 버튼: 현재 재생 위치에서 구간 분할 ──────────────────────────────
  // 로직:
  //  1. currentTime이 속한 구간을 찾는다
  //  2. 그 구간을 [start→currentTime] / [currentTime→end] 두 구간으로 쪼갠다
  //  3. 최소 구간 길이(1초)보다 짧으면 분할 거부
  //  4. currentTime이 정확히 경계에 있으면 마지막 구간의 중앙을 분할점으로 사용
  const handleAddSegment = useCallback(() => {
    if (duration <= 0 || segments.length === 0) return;

    // currentTime이 어느 구간 안에 있는지 찾기
    const MIN_SEG = 1; // 초
    let splitAt = currentTime;

    const targetIdx = segments.findIndex(
      (s) => splitAt > s.startTime + 0.01 && splitAt < s.endTime - 0.01
    );

    // currentTime이 경계에 걸쳐있으면 마지막 구간 중앙으로 폴백
    if (targetIdx === -1) {
      const last = segments[segments.length - 1];
      splitAt = (last.startTime + last.endTime) / 2;
      // 그래도 유효하지 않으면 포기
      if (last.endTime - last.startTime < MIN_SEG * 2) return;
    } else {
      const seg = segments[targetIdx];
      if (splitAt - seg.startTime < MIN_SEG || seg.endTime - splitAt < MIN_SEG) return;
    }

    const idx = targetIdx !== -1
      ? targetIdx
      : segments.findIndex((s) => splitAt > s.startTime && splitAt < s.endTime);

    if (idx === -1) return;
    const target = segments[idx];

    const newSegments = [
      ...segments.slice(0, idx),
      { ...target, endTime: splitAt },
      {
        id: String(++segIdCounter),
        startTime: splitAt,
        endTime: target.endTime,
        motionStyle: "",
        details: "",
      },
      ...segments.slice(idx + 1),
    ];
    onSegmentsChange(newSegments);
  }, [currentTime, duration, segments, onSegmentsChange]);

  // ── '×' 버튼: 구간 삭제 → 이전 구간의 endTime을 늘려 공백 없애기 ─────
  const handleRemove = useCallback((id: string) => {
    if (segments.length <= 1) return;
    const idx = segments.findIndex((s) => s.id === id);
    if (idx === -1) return;

    const removed = segments[idx];
    const newSegments = segments.filter((s) => s.id !== id);

    if (idx > 0) {
      // 이전 구간이 삭제된 구간의 끝까지 확장
      newSegments[idx - 1] = {
        ...newSegments[idx - 1],
        endTime: removed.endTime,
      };
    } else {
      // 첫 번째 구간 삭제 → 다음 구간의 startTime을 0으로
      newSegments[0] = { ...newSegments[0], startTime: 0 };
    }
    onSegmentsChange(newSegments);
  }, [segments, onSegmentsChange]);

  // ── 필드 업데이트 ────────────────────────────────────────────────────────
  const handleUpdate = useCallback(
    (id: string, field: "motionStyle" | "details", value: string) => {
      onSegmentsChange(
        segments.map((s) => (s.id === id ? { ...s, [field]: value } : s))
      );
    },
    [segments, onSegmentsChange]
  );

  const hasDuration = duration > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* ── 헤더 ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-violet-400">
            Timeline Prompts
          </h2>
          {/* 녹화 인디케이터 */}
          {isPlaying && recordedFrames > 0 && (
            <span className="flex items-center gap-1 text-xs text-rose-400 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
              {recordedFrames}f
            </span>
          )}
        </div>

        {/* '+' 분할 버튼 */}
        <button
          onClick={handleAddSegment}
          disabled={!hasDuration}
          title="Split at current position"
          className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Split
        </button>
      </div>

      {/* ── 구간 없음 안내 ────────────────────────────────────────────────── */}
      {!hasDuration && (
        <div className="flex items-center justify-center h-16 rounded-lg border border-dashed border-zinc-800">
          <p className="text-xs text-zinc-700">Upload a video to start editing</p>
        </div>
      )}

      {/* ── 구간 카드 목록 ────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        {segments.map((seg, i) => {
          const accentColor = ACCENT_COLORS[i % ACCENT_COLORS.length];
          // 현재 재생 위치가 이 구간 안에 있는지 하이라이트
          const isActive = hasDuration && currentTime >= seg.startTime && currentTime < seg.endTime;

          return (
            <div
              key={seg.id}
              className={`relative rounded-lg border bg-zinc-900 p-3 flex flex-col gap-2 transition-colors ${
                isActive ? "border-zinc-600" : "border-zinc-800"
              }`}
              // 왼쪽 컬러 테두리로 구간 구분
              style={{ borderLeftColor: accentColor, borderLeftWidth: 3 }}
            >
              {/* 구간 헤더: 시간 범위 + 삭제 버튼 */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {/* 현재 구간 활성 표시 */}
                  {isActive && (
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse"
                      style={{ backgroundColor: accentColor }} />
                  )}
                  <span className="text-xs font-mono text-zinc-400">
                    {formatTime(seg.startTime)}
                    <span className="text-zinc-700 mx-1">→</span>
                    {formatTime(seg.endTime)}
                  </span>
                  <span className="text-xs text-zinc-700">
                    ({formatTime(seg.endTime - seg.startTime)})
                  </span>
                </div>

                {segments.length > 1 && (
                  <button
                    onClick={() => handleRemove(seg.id)}
                    className="text-zinc-700 hover:text-rose-400 transition-colors p-0.5"
                    title="Remove segment"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* 입력 필드 */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-600 w-10 flex-shrink-0">Style</span>
                  <input
                    type="text"
                    value={seg.motionStyle}
                    onChange={(e) => handleUpdate(seg.id, "motionStyle", e.target.value)}
                    placeholder="e.g. 힙합 바운스"
                    className="flex-1 bg-zinc-800 border border-zinc-700 focus:border-violet-600 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 outline-none transition-colors"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-600 w-10 flex-shrink-0">Detail</span>
                  <input
                    type="text"
                    value={seg.details}
                    onChange={(e) => handleUpdate(seg.id, "details", e.target.value)}
                    placeholder="e.g. 어깨를 강하게 튕기기"
                    className="flex-1 bg-zinc-800 border border-zinc-700 focus:border-violet-600 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 outline-none transition-colors"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 데이터 내보내기 버튼 ────────────────────────────────────────────
          랜드마크 녹화 데이터 + 타임라인 프롬프트를 JSON으로 콘솔 출력
          이후 AI 백엔드 POST 요청으로 교체 예정
      ─────────────────────────────────────────────────────────────────── */}
      {hasDuration && (
        <button
          onClick={onExport}
          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-violet-900/40 hover:bg-violet-800/60 border border-violet-800 hover:border-violet-600 text-violet-300 hover:text-violet-100 text-xs font-semibold transition-all"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          Export Motion + Prompts JSON
          {recordedFrames > 0 && (
            <span className="text-violet-500 font-normal">({recordedFrames} frames)</span>
          )}
        </button>
      )}
    </div>
  );
}
