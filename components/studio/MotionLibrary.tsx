"use client";

/**
 * MotionLibrary — 모션 도서관 대시보드
 *
 * - 다중 필터: genre / vibe / tempo / difficulty 클라이언트 사이드 즉시 필터링
 * - 카드 그리드: 이름, 생성일, 속성 뱃지
 * - 원터치 삭제: confirm → Supabase DELETE → 상태 즉시 반영
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { getMotionSummaries, deleteMotion, type MotionSummary } from "@/lib/supabase";

// ── 이름 파싱 ──────────────────────────────────────────────────────────────
// 저장 형식: "genre_vibe_tempo_difficulty"
// 그 외 형식(구형 이름 등)은 tags를 빈 값으로 처리
type MotionTags = { genre: string; vibe: string; tempo: string; difficulty: string };

function parseTags(name: string): MotionTags {
  const p = name.split("_");
  return {
    genre:      p[0] ?? "",
    vibe:       p[1] ?? "",
    tempo:      p[2] ?? "",
    difficulty: p[3] ?? "",
  };
}

// ── 날짜 포맷 ─────────────────────────────────────────────────────────────
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    year: "numeric", month: "short", day: "numeric",
  });
}

// ── 뱃지 색상 ─────────────────────────────────────────────────────────────
function genreBadge()      { return "bg-violet-900/60 text-violet-300 border-violet-700/60"; }
function vibeBadge()       { return "bg-blue-900/60   text-blue-300   border-blue-700/60"; }
function tempoBadge(v: string) {
  if (v === "빠름") return "bg-orange-900/60 text-orange-300 border-orange-700/60";
  if (v === "느림") return "bg-teal-900/60   text-teal-300   border-teal-700/60";
  return "bg-zinc-800 text-zinc-400 border-zinc-700";
}
function difficultyBadge(v: string) {
  if (v === "상") return "bg-red-900/60    text-red-300    border-red-700/60";
  if (v === "하") return "bg-green-900/60  text-green-300  border-green-700/60";
  return "bg-yellow-900/60 text-yellow-300 border-yellow-700/60";
}

// ── 필터 칩 컴포넌트 ────────────────────────────────────────────────────────
function FilterChips({
  label, options, active, onChange,
}: {
  label: string;
  options: string[];
  active: string;
  onChange: (v: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{label}</span>
      <div className="flex flex-wrap gap-1">
        {["전체", ...options].map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt === "전체" ? "" : opt)}
            className={`px-2 py-0.5 rounded-full text-[11px] font-medium border transition-all ${
              (opt === "전체" ? active === "" : active === opt)
                ? "bg-violet-700 border-violet-500 text-white"
                : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 모션 카드 ─────────────────────────────────────────────────────────────
function MotionCard({
  motion, onDelete,
}: {
  motion: MotionSummary;
  onDelete: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const tags = parseTags(motion.name);

  const handleDelete = async () => {
    if (!confirm(`"${motion.name}" 모션을 삭제하시겠습니까?`)) return;
    setDeleting(true);
    try {
      await deleteMotion(motion.id);
      onDelete(motion.id);
    } catch (err) {
      alert("삭제 실패: " + (err instanceof Error ? err.message : String(err)));
      setDeleting(false);
    }
  };

  const hasTags = tags.genre || tags.vibe || tags.tempo || tags.difficulty;

  return (
    <div className="relative bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex flex-col gap-2 hover:border-zinc-700 transition-colors">
      {/* 삭제 버튼 */}
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="absolute top-2.5 right-2.5 text-zinc-600 hover:text-red-400 disabled:opacity-40 transition-colors text-sm leading-none"
        title="삭제"
      >
        {deleting ? "…" : "🗑️"}
      </button>

      {/* 모션 이름 */}
      <p className="text-xs font-semibold text-zinc-100 pr-6 break-all leading-snug">
        {motion.name}
      </p>

      {/* 생성일 */}
      <p className="text-[10px] text-zinc-600">{formatDate(motion.created_at)}</p>

      {/* 속성 뱃지 */}
      {hasTags && (
        <div className="flex flex-wrap gap-1">
          {tags.genre      && <Badge cls={genreBadge()}                label={tags.genre} />}
          {tags.vibe       && <Badge cls={vibeBadge()}                 label={tags.vibe} />}
          {tags.tempo      && <Badge cls={tempoBadge(tags.tempo)}      label={tags.tempo} />}
          {tags.difficulty && <Badge cls={difficultyBadge(tags.difficulty)} label={tags.difficulty} />}
        </div>
      )}
    </div>
  );
}

function Badge({ cls, label }: { cls: string; label: string }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${cls}`}>
      {label}
    </span>
  );
}

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────
export default function MotionLibrary({ refreshKey }: { refreshKey: number }) {
  const [motions,  setMotions]  = useState<MotionSummary[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  // 활성 필터 (빈 문자열 = 전체)
  const [fGenre,  setFGenre]  = useState("");
  const [fVibe,   setFVibe]   = useState("");
  const [fTempo,  setFTempo]  = useState("");
  const [fDiff,   setFDiff]   = useState("");

  // ── 데이터 로드 ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMotionSummaries(100)
      .then((data) => { if (!cancelled) setMotions(data); })
      .catch((e)   => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(()  => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // ── 고유 필터 옵션 (로드된 데이터에서 동적 추출) ────────────────────────
  const filterOptions = useMemo(() => {
    const unique = (arr: string[]) => [...new Set(arr.filter(Boolean))].sort();
    const tags = motions.map((m) => parseTags(m.name));
    return {
      genre: unique(tags.map((t) => t.genre)),
      vibe:  unique(tags.map((t) => t.vibe)),
      tempo: unique(tags.map((t) => t.tempo)),
      diff:  unique(tags.map((t) => t.difficulty)),
    };
  }, [motions]);

  // ── 클라이언트 사이드 필터링 ────────────────────────────────────────────
  const filtered = useMemo(() => {
    return motions.filter((m) => {
      const t = parseTags(m.name);
      return (
        (!fGenre || t.genre      === fGenre) &&
        (!fVibe  || t.vibe       === fVibe)  &&
        (!fTempo || t.tempo      === fTempo) &&
        (!fDiff  || t.difficulty === fDiff)
      );
    });
  }, [motions, fGenre, fVibe, fTempo, fDiff]);

  // ── 삭제 후 상태 즉시 반영 ─────────────────────────────────────────────
  const handleDelete = useCallback((id: string) => {
    setMotions((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // ── 필터 초기화 ─────────────────────────────────────────────────────────
  const hasFilter = fGenre || fVibe || fTempo || fDiff;
  const clearFilters = () => { setFGenre(""); setFVibe(""); setFTempo(""); setFDiff(""); };

  // ── 렌더 ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-violet-400">
          Motion Library
        </h2>
        {hasFilter && (
          <button
            onClick={clearFilters}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            필터 초기화 ✕
          </button>
        )}
      </div>

      {/* 필터 영역 */}
      {!loading && motions.length > 0 && (
        <div className="flex flex-col gap-2 p-2.5 bg-zinc-900/60 rounded-lg border border-zinc-800">
          <FilterChips label="장르"  options={filterOptions.genre} active={fGenre} onChange={setFGenre} />
          <FilterChips label="분위기" options={filterOptions.vibe}  active={fVibe}  onChange={setFVibe} />
          <FilterChips label="템포"  options={filterOptions.tempo} active={fTempo} onChange={setFTempo} />
          <FilterChips label="난이도" options={filterOptions.diff}  active={fDiff}  onChange={setFDiff} />
        </div>
      )}

      {/* 결과 */}
      {loading ? (
        <p className="text-xs text-zinc-600 text-center py-4">불러오는 중…</p>
      ) : error ? (
        <p className="text-xs text-red-400 text-center py-2">❌ {error}</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-zinc-600 text-center py-4">
          {hasFilter ? "해당 조건의 모션이 없습니다." : "저장된 모션이 없습니다."}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] text-zinc-600 text-right">{filtered.length}개</p>
          {filtered.map((m) => (
            <MotionCard key={m.id} motion={m} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
