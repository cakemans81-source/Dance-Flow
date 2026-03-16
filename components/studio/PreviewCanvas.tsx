"use client";

/**
 * PreviewCanvas — 3D 씬 래퍼
 *
 * PoseCanvas3D를 dynamic import(ssr: false)로 불러온다.
 * Three.js는 window / WebGLRenderingContext에 의존하므로
 * Next.js SSR 환경에서 실행되면 안 된다.
 * "use client" 디렉티브만으로는 불충분 —
 * Next.js는 Client Component도 서버에서 초기 HTML을 생성할 수 있기 때문이다.
 */

import dynamic from "next/dynamic";
import type { Landmark3D } from "@/hooks/usePose";

// ssr: false → 브라우저에서만 로드, 서버 빌드에서 완전히 제외
const PoseCanvas3D = dynamic(() => import("./PoseCanvas3D"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-[#080810] flex items-center justify-center">
      <span className="text-xs text-zinc-700 font-mono animate-pulse">
        Loading 3D engine...
      </span>
    </div>
  ),
});

interface PreviewCanvasProps {
  landmarks: Landmark3D[] | null;
}

export default function PreviewCanvas({ landmarks }: PreviewCanvasProps) {
  return (
    <div className="relative w-full h-full">
      {/* 3D 캔버스 — 전체 영역 차지 */}
      <PoseCanvas3D landmarks={landmarks} />

      {/* 상태 오버레이 (캔버스 위에 absolute로 표시) */}
      <div className="absolute top-3 left-3 pointer-events-none select-none">
        {landmarks ? (
          /* 트래킹 중 */
          <div className="flex items-center gap-2 bg-black/50 backdrop-blur-sm rounded px-2 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
            <span className="text-xs text-violet-300 font-mono">
              LIVE · {landmarks.length} pts
            </span>
          </div>
        ) : (
          /* 대기 중 */
          <div className="flex items-center gap-2 bg-black/40 backdrop-blur-sm rounded px-2 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
            <span className="text-xs text-zinc-600 font-mono">
              Waiting for pose data
            </span>
          </div>
        )}
      </div>

      {/* 조작 힌트 */}
      <div className="absolute bottom-3 right-3 pointer-events-none select-none">
        <p className="text-xs text-zinc-800 font-mono">
          Drag · Scroll · Right-click
        </p>
      </div>
    </div>
  );
}
