"use client";

/**
 * StudioClient — 좌우 패널의 공유 상태 허브
 *
 * page.tsx를 Server Component로 유지하면서,
 * poseLandmarks 같은 실시간 클라이언트 상태를 두 패널이 공유하려면
 * 이 래퍼 컴포넌트에 상태를 올려야 한다.
 *
 * 데이터 흐름:
 *   VideoPlayer → usePose → onLandmarks →
 *   ControlPanel(onLandmarksUpdate) →
 *   StudioClient(poseLandmarks state) →
 *   PreviewCanvas(landmarks prop)
 */

import { useState } from "react";
import ControlPanel from "./ControlPanel";
import PreviewCanvas from "./PreviewCanvas";
import type { Landmark3D } from "@/hooks/usePose";

export default function StudioClient() {
  // 두 패널이 공유하는 실시간 포즈 데이터
  const [poseLandmarks, setPoseLandmarks] = useState<Landmark3D[] | null>(null);

  return (
    <main className="flex flex-col lg:flex-row h-screen w-screen overflow-hidden bg-[#0a0a0a]">
      {/* 좌측: 컨트롤 패널 */}
      <aside className="w-full lg:w-[360px] flex-shrink-0 h-[50vh] lg:h-full border-b lg:border-b-0 lg:border-r border-zinc-800 bg-[#111111] overflow-hidden">
        <ControlPanel onLandmarksUpdate={setPoseLandmarks} />
      </aside>

      {/* 우측: 3D 프리뷰 캔버스 */}
      <section className="flex-1 min-w-0 h-[50vh] lg:h-full relative">
        <PreviewCanvas landmarks={poseLandmarks} />
      </section>
    </main>
  );
}
