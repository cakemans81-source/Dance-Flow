"use client";

/**
 * RecentMotions — Supabase motions 테이블 최근 3개 디버그 패널
 *
 * refreshKey가 바뀔 때마다 재조회한다.
 * (저장 성공 시 ControlPanel이 refreshKey를 증가시켜 트리거)
 */

import { useEffect, useState } from "react";
import { getRecentMotions, type MotionSummary } from "@/lib/supabase";

interface RecentMotionsProps {
  refreshKey: number;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function RecentMotions({ refreshKey }: RecentMotionsProps) {
  const [motions, setMotions] = useState<MotionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getRecentMotions(3)
      .then(setMotions)
      .catch((e) => setError(e instanceof Error ? e.message : "불러오기 실패"))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  return (
    <div className="flex flex-col gap-2">
      {/* 섹션 헤더 */}
      <h2 className="text-xs font-semibold uppercase tracking-widest text-violet-400">
        Recent Saves
      </h2>

      {/* 로딩 */}
      {loading && (
        <div className="flex items-center gap-2 py-1">
          <svg className="w-3 h-3 animate-spin text-zinc-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-xs text-zinc-600">Loading...</span>
        </div>
      )}

      {/* 에러 */}
      {!loading && error && (
        <p className="text-xs text-rose-500 break-all">{error}</p>
      )}

      {/* 빈 목록 */}
      {!loading && !error && motions.length === 0 && (
        <p className="text-xs text-zinc-700 italic">저장된 모션 없음</p>
      )}

      {/* 목록 */}
      {!loading && !error && motions.length > 0 && (
        <div className="flex flex-col gap-1">
          {motions.map((m, i) => (
            <div
              key={m.id}
              className="flex items-center justify-between px-2 py-1.5 rounded bg-zinc-900 border border-zinc-800"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-zinc-600 font-mono w-3 flex-shrink-0">{i + 1}</span>
                <span className="text-xs text-zinc-300 truncate">{m.name}</span>
              </div>
              <span className="text-xs text-zinc-600 font-mono flex-shrink-0 ml-2">
                {formatDate(m.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
