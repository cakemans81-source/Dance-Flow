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

import { useState, useCallback, useRef } from "react";
import ControlPanel from "./ControlPanel";
import PreviewCanvas from "./PreviewCanvas";
import VideoConverter from "./VideoConverter";
import MotionMixer from "./MotionMixer";
import type { Landmark3D } from "@/hooks/usePose";
import type { CaptureBackground } from "./PoseCanvas3D";

type Mode = "extract" | "direct" | "toolbox";
type ToolboxTab = "converter" | "mixer";

export default function StudioClient() {
  // 두 패널이 공유하는 실시간 포즈 데이터
  const [poseLandmarks, setPoseLandmarks] = useState<Landmark3D[] | null>(null);

  // Kling 녹화 시 오디오 트랙을 포함하기 위해 ControlPanel의 audio 엘리먼트를 참조
  const directAudioRef = useRef<HTMLAudioElement | null>(null);
  const handleDirectAudioRef = useCallback((el: HTMLAudioElement | null) => {
    directAudioRef.current = el;
  }, []);

  // ── 저장 성공 토스트 ──────────────────────────────────────────────────────
  // toastKey: 같은 이름으로 연속 저장해도 매번 새 애니메이션을 트리거하기 위해 사용
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastKey, setToastKey] = useState(0);

  const handleSaveSuccess = useCallback((name: string) => {
    setToastMessage(`✅ "${name}" DB 저장 완료!`);
    setToastKey((k) => k + 1);
    // 3.2초 후 토스트 제거 (CSS 애니메이션 3s + 여유 0.2s)
    setTimeout(() => setToastMessage(null), 3200);
  }, []);

  // ── 3D 캔버스 녹화 상태 (Kling AI 레퍼런스 영상 추출) ──────────────────────
  const [isCapturing3D, setIsCapturing3D] = useState(false);
  const [captureBackground, setCaptureBackground] = useState<CaptureBackground>("black");

  const handleToggle3DCapture = useCallback(() => {
    setIsCapturing3D((prev) => !prev);
  }, []);

  // ── 활성 모드 (우측 패널 전환용) ─────────────────────────────────────────
  const [activeMode, setActiveMode] = useState<Mode>("extract");
  const [toolboxTab, setToolboxTab] = useState<ToolboxTab>("converter");

  return (
    <main className="flex flex-col lg:flex-row h-screen w-screen overflow-hidden bg-[#0a0a0a]">
      {/* 좌측: 컨트롤 패널 */}
      <aside className="w-full lg:w-[360px] flex-shrink-0 h-[50vh] lg:h-full border-b lg:border-b-0 lg:border-r border-zinc-800 bg-[#111111] overflow-hidden">
        <ControlPanel
          onLandmarksUpdate={setPoseLandmarks}
          onSaveSuccess={handleSaveSuccess}
          isCapturing3D={isCapturing3D}
          captureBackground={captureBackground}
          onToggle3DCapture={handleToggle3DCapture}
          onChangeCaptureBackground={setCaptureBackground}
          onDirectAudioRef={handleDirectAudioRef}
          onModeChange={setActiveMode}
        />
      </aside>

      {/* 우측: Toolbox 탭이면 변환기/믹서, 나머지는 3D 프리뷰 캔버스 */}
      <section className="flex-1 min-w-0 h-[50vh] lg:h-full relative flex flex-col">
        {activeMode === "toolbox" ? (
          <div className="flex flex-col h-full">
            {/* 서브탭 */}
            <div className="flex-shrink-0 flex gap-0.5 p-1.5 bg-zinc-950 border-b border-zinc-800">
              {(["converter", "mixer"] as ToolboxTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setToolboxTab(tab)}
                  className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${
                    toolboxTab === tab
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {tab === "converter" ? "WebM→MP4 변환기" : "🎭 모션 믹서"}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-hidden">
              {toolboxTab === "converter" ? <VideoConverter /> : <MotionMixer />}
            </div>
          </div>
        ) : (
          <PreviewCanvas
            landmarks={poseLandmarks}
            isCapturing={isCapturing3D}
            captureBackground={captureBackground}
            audioRef={directAudioRef}
          />
        )}
      </section>

      {/* ── 전체화면 토스트 알림 ──────────────────────────────────────────── */}
      {toastMessage && (
        <div
          key={toastKey}
          className="animate-toast pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl bg-emerald-950/90 border border-emerald-700 shadow-lg backdrop-blur-sm"
        >
          <span className="text-sm font-semibold text-emerald-300">{toastMessage}</span>
        </div>
      )}
    </main>
  );
}
