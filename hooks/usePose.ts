"use client";

/**
 * usePose — MediaPipe Pose 연동 커스텀 훅
 *
 * 역할:
 *  1. @mediapipe/pose를 동적 import (SSR 방지, 최초 비디오 로드 시 1회 초기화)
 *  2. isPlaying이 true일 때 RAF 루프로 매 프레임 pose.send() 호출
 *  3. 결과를 오버레이 캔버스에 직접 드로잉 (영상 위 뼈대 시각화)
 *  4. 3D 월드 랜드마크(Landmark3D[])를 onLandmarks 콜백으로 부모에 전달
 *
 * 설계 원칙:
 *  - pose.send()는 Promise이므로, 이전 호출이 끝나기 전에 다음 호출을 막는
 *    isProcessingRef 플래그로 백프레셔를 제어한다.
 *  - onLandmarks 콜백은 stale closure를 방지하기 위해 ref로 래핑한다.
 *  - 오버레이 캔버스 좌표는 object-contain 레터박스를 계산해 보정한다.
 */

import { useRef, useEffect } from "react";

// 부모(PreviewCanvas 등)로 전달되는 3D 랜드마크 타입
// poseWorldLandmarks: 힙 중심, 미터 단위 3D 공간 좌표
export type Landmark3D = {
  x: number;
  y: number;
  z: number;
  visibility: number;
};

// POSE_CONNECTIONS 타입 (동적 import 후 capturedref에 저장)
type PoseConnections = ReadonlyArray<readonly [number, number]>;

interface UsePoseOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** 비디오 메타데이터가 로드됐을 때 true → Pose 초기화 트리거 */
  isVideoLoaded: boolean;
  isPlaying: boolean;
  onLandmarks: (landmarks: Landmark3D[] | null) => void;
}

// ── 헬퍼: object-contain 레터박스 보정 ─────────────────────────────────────
// 비디오는 CSS object-contain으로 컨테이너 안에 비율을 유지하며 맞춰진다.
// MediaPipe 랜드마크는 비디오의 0~1 정규화 좌표계이므로,
// 실제 렌더링된 비디오 영역(offsetX, offsetY, renderedW, renderedH)으로 변환해야
// 오버레이 캔버스와 정확히 일치한다.
function getContainBounds(
  containerW: number,
  containerH: number,
  videoW: number,
  videoH: number
) {
  const scale = Math.min(containerW / videoW, containerH / videoH);
  const renderedW = videoW * scale;
  const renderedH = videoH * scale;
  return {
    offsetX: (containerW - renderedW) / 2,
    offsetY: (containerH - renderedH) / 2,
    renderedW,
    renderedH,
  };
}

// ── 헬퍼: 스켈레톤 드로잉 ──────────────────────────────────────────────────
function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: { x: number; y: number; visibility?: number }[],
  connections: PoseConnections,
  canvasW: number,
  canvasH: number,
  videoW: number,
  videoH: number
) {
  if (canvasW === 0 || canvasH === 0 || videoW === 0 || videoH === 0) return;

  const { offsetX, offsetY, renderedW, renderedH } = getContainBounds(
    canvasW,
    canvasH,
    videoW,
    videoH
  );

  // 정규화 좌표 → 캔버스 픽셀 변환
  const toX = (nx: number) => nx * renderedW + offsetX;
  const toY = (ny: number) => ny * renderedH + offsetY;

  // 1) 뼈대 선 (connections)
  ctx.lineWidth = 2;
  for (const [i, j] of connections) {
    const a = landmarks[i];
    const b = landmarks[j];
    if (!a || !b) continue;
    const alpha = Math.min(a.visibility ?? 1, b.visibility ?? 1);
    if (alpha < 0.3) continue; // 가시성 낮은 관절은 스킵

    ctx.strokeStyle = `rgba(124, 58, 237, ${(alpha * 0.85).toFixed(2)})`;
    ctx.beginPath();
    ctx.moveTo(toX(a.x), toY(a.y));
    ctx.lineTo(toX(b.x), toY(b.y));
    ctx.stroke();
  }

  // 2) 관절 점 (landmarks)
  for (const lm of landmarks) {
    const alpha = lm.visibility ?? 1;
    if (alpha < 0.3) continue;

    // 외곽 원 (보라색)
    ctx.fillStyle = `rgba(167, 139, 250, ${alpha.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(toX(lm.x), toY(lm.y), 4, 0, Math.PI * 2);
    ctx.fill();

    // 중심 하이라이트 (흰색)
    ctx.fillStyle = `rgba(255, 255, 255, ${(alpha * 0.9).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(toX(lm.x), toY(lm.y), 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── 메인 훅 ────────────────────────────────────────────────────────────────
export function usePose({
  videoRef,
  isVideoLoaded,
  isPlaying,
  onLandmarks,
}: UsePoseOptions) {
  // 이 훅이 생성하고 VideoPlayer에 전달하는 오버레이 캔버스 ref
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // MediaPipe Pose 인스턴스 — re-render와 무관하게 영속
  const poseRef = useRef<any>(null);
  // 동적 import로 가져온 POSE_CONNECTIONS 저장
  const connectionsRef = useRef<PoseConnections>([]);
  // RAF ID
  const rafRef = useRef<number>(0);
  // pose.send() 중복 호출 방지 플래그 (백프레셔 제어)
  const isProcessingRef = useRef(false);
  // 초기화 완료 여부
  const isInitializedRef = useRef(false);

  // onLandmarks stale closure 방지: 최신 콜백을 ref에 동기화
  const onLandmarksRef = useRef(onLandmarks);
  useEffect(() => {
    onLandmarksRef.current = onLandmarks;
  }, [onLandmarks]);

  // ── MediaPipe Pose 초기화 ────────────────────────────────────────────────
  // isVideoLoaded가 처음 true가 되는 시점에 딱 1번만 실행.
  // 동적 import를 사용해 WASM 파일이 서버 빌드에 포함되지 않도록 한다.
  useEffect(() => {
    if (!isVideoLoaded || isInitializedRef.current) return;

    let cancelled = false;

    (async () => {
      try {
        // @mediapipe/pose는 브라우저 전용이므로 런타임에 동적 import
        const { Pose, POSE_CONNECTIONS } = await import("@mediapipe/pose");
        if (cancelled) return;

        connectionsRef.current = POSE_CONNECTIONS;

        const pose = new Pose({
          // locateFile: WASM / 모델 파일을 jsDelivr CDN에서 로드
          // 로컬에 두려면 node_modules/@mediapipe/pose를 public/으로 복사 후 경로 변경
          locateFile: (file: string) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`,
        });

        pose.setOptions({
          modelComplexity: 1,       // 0=lite, 1=full, 2=heavy
          smoothLandmarks: true,    // 프레임 간 흔들림 감소
          enableSegmentation: false,
          smoothSegmentation: false,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        pose.onResults((results: any) => {
          // send() 완료 → 처리 플래그 해제
          isProcessingRef.current = false;

          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;

          // 캔버스 초기화
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          if (!results.poseLandmarks) {
            onLandmarksRef.current(null);
            return;
          }

          const video = videoRef.current;
          drawSkeleton(
            ctx,
            results.poseLandmarks,
            connectionsRef.current,
            canvas.width,
            canvas.height,
            video?.videoWidth ?? canvas.width,
            video?.videoHeight ?? canvas.height
          );

          // poseWorldLandmarks: 힙 중심 기준 미터 단위 3D 좌표 (3D 씬에 적합)
          // 없으면 정규화 좌표(poseLandmarks)로 폴백
          const raw = results.poseWorldLandmarks ?? results.poseLandmarks;
          const landmarks3D: Landmark3D[] = raw.map((lm: any) => ({
            x: lm.x,
            y: lm.y,
            z: lm.z,
            visibility: lm.visibility ?? 1,
          }));
          onLandmarksRef.current(landmarks3D);
        });

        poseRef.current = pose;
        isInitializedRef.current = true;
        console.log("[usePose] MediaPipe Pose initialized");
      } catch (err) {
        console.error("[usePose] Failed to initialize MediaPipe:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isVideoLoaded]); // videoRef는 ref이므로 의존성 불필요

  // ── RAF 루프: 재생 중일 때만 프레임 전송 ──────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(rafRef.current);
      // 일시정지 시 오버레이 클리어
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let active = true;

    const tick = async () => {
      if (!active) return;

      const video = videoRef.current;
      const pose = poseRef.current;
      const canvas = canvasRef.current;

      if (
        video &&
        pose &&
        canvas &&
        isInitializedRef.current &&
        !isProcessingRef.current && // 이전 프레임 처리 완료 확인
        !video.paused &&
        !video.ended &&
        video.readyState >= 2 // HAVE_CURRENT_DATA 이상
      ) {
        // 캔버스 버퍼 크기를 CSS 렌더 크기에 맞게 동기화
        // (CSS 크기 != attribute 크기이면 드로잉이 늘어나 보임)
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        if (cssW > 0 && cssH > 0) {
          if (canvas.width !== cssW) canvas.width = cssW;
          if (canvas.height !== cssH) canvas.height = cssH;
        }

        isProcessingRef.current = true;
        try {
          await pose.send({ image: video });
        } catch (err) {
          // send 중 영상이 리셋되거나 seek되면 에러가 발생할 수 있음
          isProcessingRef.current = false;
          if ((err as Error).name !== "AbortError") {
            console.warn("[usePose] pose.send error:", err);
          }
        }
      }

      if (active) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying]); // videoRef는 ref이므로 의존성 불필요

  // ── 언마운트 정리 ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      poseRef.current?.close?.();
      isInitializedRef.current = false;
    };
  }, []);

  return { canvasRef };
}
