"use client";

/**
 * PoseCanvas3D — Vanilla Three.js 3D 씬 (React 19 완전 호환)
 *
 * R3F(React Three Fiber)는 내부 reconciler가 React 19 API를 사용하지 못해
 * 런타임 에러가 발생하므로, Three.js를 직접 사용한다.
 *
 * 장점:
 *  - React reconciler 오버헤드 없음 → 더 빠른 렌더링
 *  - 버전 호환성 문제 없음
 *  - geometry 업데이트를 완전히 imperative하게 제어
 *
 * 구조:
 *  1. useEffect로 Three.js 씬 초기화 (최초 1회)
 *  2. ResizeObserver로 캔버스 크기 반응형 유지
 *  3. 두 번째 useEffect로 landmarks 변경 시 geometry만 업데이트
 *  4. RAF 루프는 requestAnimationFrame으로 직접 관리
 */

import { useRef, useEffect, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Landmark3D } from "@/hooks/usePose";

// ── 캡처 배경 타입 ────────────────────────────────────────────────────────────
export type CaptureBackground = "black" | "green";

// ── 상수 ─────────────────────────────────────────────────────────────────────
const NUM_JOINTS = 33;
const SCALE = 2.5; // MediaPipe 미터 단위 → Three.js 씬 유닛 스케일

const POSE_CONNECTIONS: [number, number][] = [
  // 얼굴 (idx 0–8)
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  // 어깨/몸통 어깨선 (idx 9)
  [11, 12],
  // 왼팔 (idx 10–15)
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  // 오른팔 (idx 16–21)
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  // 몸통 측면·골반 (idx 22–24)
  [11, 23], [12, 24], [23, 24],
  // 왼다리 (idx 25–29)
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  // 오른다리 (idx 30–34)
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];
const NUM_CONNECTIONS = POSE_CONNECTIONS.length;

// ── ControlNet OpenPose 표준 컬러 스키마 ──────────────────────────────────────
// 연결선별 RGB [r,g,b] — 순서는 POSE_CONNECTIONS 인덱스와 1:1 대응
// 머리 #FF0000 / 몸통 #FF00FF / 왼팔 #0000FF / 오른팔 #00FF00
// 왼다리 #00FFFF / 오른다리 #FFFF00
const CONNECTION_COLORS_RGB: [number, number, number][] = [
  // 얼굴 0–8
  [1,0,0],[1,0,0],[1,0,0],[1,0,0],
  [1,0,0],[1,0,0],[1,0,0],[1,0,0],[1,0,0],
  // 어깨선 9
  [1,0,1],
  // 왼팔 10–15
  [0,0,1],[0,0,1],[0,0,1],[0,0,1],[0,0,1],[0,0,1],
  // 오른팔 16–21
  [0,1,0],[0,1,0],[0,1,0],[0,1,0],[0,1,0],[0,1,0],
  // 몸통 22–24
  [1,0,1],[1,0,1],[1,0,1],
  // 왼다리 25–29
  [0,1,1],[0,1,1],[0,1,1],[0,1,1],[0,1,1],
  // 오른다리 30–34
  [1,1,0],[1,1,0],[1,1,0],[1,1,0],[1,1,0],
];

// 관절(InstancedMesh) 인덱스별 THREE.Color
const _c = (hex: number) => new THREE.Color(hex);
const JOINT_COLORS_MAP: Record<number, THREE.Color> = {
  // 머리 0–10
  0:_c(0xFF0000),1:_c(0xFF0000),2:_c(0xFF0000),3:_c(0xFF0000),4:_c(0xFF0000),
  5:_c(0xFF0000),6:_c(0xFF0000),7:_c(0xFF0000),8:_c(0xFF0000),9:_c(0xFF0000),10:_c(0xFF0000),
  // 몸통(어깨·골반) 11,12,23,24
  11:_c(0xFF00FF),12:_c(0xFF00FF),23:_c(0xFF00FF),24:_c(0xFF00FF),
  // 왼팔 13,15,17,19,21
  13:_c(0x0000FF),15:_c(0x0000FF),17:_c(0x0000FF),19:_c(0x0000FF),21:_c(0x0000FF),
  // 오른팔 14,16,18,20,22
  14:_c(0x00FF00),16:_c(0x00FF00),18:_c(0x00FF00),20:_c(0x00FF00),22:_c(0x00FF00),
  // 왼다리 25,27,29,31
  25:_c(0x00FFFF),27:_c(0x00FFFF),29:_c(0x00FFFF),31:_c(0x00FFFF),
  // 오른다리 26,28,30,32
  26:_c(0xFFFF00),28:_c(0xFFFF00),30:_c(0xFFFF00),32:_c(0xFFFF00),
};

// ── 좌표 변환 ─────────────────────────────────────────────────────────────────
// MediaPipe world: X 오른쪽+, Y 아래+, Z 카메라 쪽+
// Three.js:        X 오른쪽+, Y 위+,   Z 카메라 쪽+
// → Y 부호만 반전
function lmX(lm: Landmark3D) { return lm.x * SCALE; }
function lmY(lm: Landmark3D) { return -lm.y * SCALE; }
function lmZ(lm: Landmark3D) { return -lm.z * SCALE; }

// ── 씬 오브젝트를 묶는 타입 (useRef로 컴포넌트 생명주기 동안 영속) ─────────
interface SceneRefs {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  lineSegments: THREE.LineSegments;
  instancedMesh: THREE.InstancedMesh;
  tempMatrix: THREE.Matrix4;
  rafId: number;
  resizeObserver: ResizeObserver;
}

interface PoseCanvas3DProps {
  landmarks: Landmark3D[] | null;
  /** true일 때 WebGL 캔버스를 MediaRecorder로 녹화 시작 */
  isCapturing: boolean;
  /** 녹화 시 배경색: Kling AI 인식용 검정 or 크로마키 녹색 */
  captureBackground: CaptureBackground;
  /** 녹화 영상에 오디오를 포함하기 위한 audio 엘리먼트 ref */
  audioRef?: RefObject<HTMLAudioElement | null>;
}

export default function PoseCanvas3D({ landmarks, isCapturing, captureBackground, audioRef }: PoseCanvas3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // sceneRef: React state가 아닌 mutable ref로 Three.js 씬을 보관
  // → 업데이트 시 리렌더 없이 직접 접근
  const sceneRef = useRef<SceneRefs | null>(null);

  // ── MediaRecorder 관련 refs ───────────────────────────────────────────────
  // React state 대신 ref 사용 → 녹화 중 리렌더 없음
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  // captureBackground를 effect 내에서 stale closure 없이 참조하기 위한 ref
  const captureBackgroundRef = useRef<CaptureBackground>(captureBackground);
  useEffect(() => { captureBackgroundRef.current = captureBackground; }, [captureBackground]);


  // ── Three.js 씬 초기화 (마운트 시 1회) ──────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // ── Renderer ─────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x080810, 1);

    // ── Scene & Camera ───────────────────────────────────────────────────
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      50,
      canvas.clientWidth / canvas.clientHeight,
      0.01,
      100
    );
    camera.position.set(0, 0.8, 4.5);

    // ── OrbitControls ────────────────────────────────────────────────────
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 1;
    controls.maxDistance = 20;
    controls.maxPolarAngle = Math.PI * 0.9;
    controls.target.set(0, 0, 0);

    // ── 조명 (MeshBasicMaterial 관절은 조명 무관, 씬 분위기용만 유지) ──────
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    // ── 바닥 그리드 ───────────────────────────────────────────────────────
    // GridHelper: (크기, 분할수, 중심색, 격자색)
    const grid = new THREE.GridHelper(10, 20, 0x2d2b55, 0x1a1a2e);
    grid.position.y = -1.3;
    scene.add(grid);

    // ── 뼈대 LineSegments (vertexColors — 부위별 OpenPose 색상) ──────────
    const lineGeo = new THREE.BufferGeometry();
    const linePositions = new Float32Array(NUM_CONNECTIONS * 2 * 3);
    const linePosAttr = new THREE.BufferAttribute(linePositions, 3);
    linePosAttr.setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute("position", linePosAttr);

    // 색상 버퍼: 연결선마다 start·end 정점 2개 × RGB 3채널 (정적 — 한 번만 설정)
    const lineColorData = new Float32Array(NUM_CONNECTIONS * 2 * 3);
    for (let i = 0; i < NUM_CONNECTIONS; i++) {
      const [r, g, b] = CONNECTION_COLORS_RGB[i];
      lineColorData[i * 6]     = r; lineColorData[i * 6 + 1] = g; lineColorData[i * 6 + 2] = b;
      lineColorData[i * 6 + 3] = r; lineColorData[i * 6 + 4] = g; lineColorData[i * 6 + 5] = b;
    }
    lineGeo.setAttribute("color", new THREE.BufferAttribute(lineColorData, 3));

    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
    const lineSegments = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(lineSegments);

    // ── 관절 InstancedMesh (MeshBasicMaterial — 조명 무관, 순수 OpenPose 색) ─
    const sphereGeo = new THREE.SphereGeometry(0.035, 10, 7);
    const jointMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const instancedMesh = new THREE.InstancedMesh(sphereGeo, jointMat, NUM_JOINTS);
    const tempMatrix = new THREE.Matrix4();
    const defaultJointColor = new THREE.Color(0x888888);

    // 모든 관절 초기화: 위치는 씬 밖, 색상은 OpenPose 기준으로 고정
    for (let i = 0; i < NUM_JOINTS; i++) {
      tempMatrix.makeTranslation(0, -999, 0);
      instancedMesh.setMatrixAt(i, tempMatrix);
      instancedMesh.setColorAt(i, JOINT_COLORS_MAP[i] ?? defaultJointColor);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;
    instancedMesh.instanceColor!.needsUpdate = true;
    scene.add(instancedMesh);

    // ── 반응형 리사이즈 ───────────────────────────────────────────────────
    // ResizeObserver: window resize 이벤트보다 정확하게 요소 크기 변화를 감지
    const resizeObserver = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false); // false: CSS 크기는 변경하지 않음
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(canvas);

    // 초기 크기 설정
    const initW = canvas.clientWidth || 800;
    const initH = canvas.clientHeight || 600;
    renderer.setSize(initW, initH, false);
    camera.aspect = initW / initH;
    camera.updateProjectionMatrix();

    // ── RAF 애니메이션 루프 ───────────────────────────────────────────────
    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.update(); // enableDamping을 위해 매 프레임 호출 필요
      renderer.render(scene, camera);
    };
    animate();

    sceneRef.current = {
      renderer,
      scene,
      camera,
      controls,
      lineSegments,
      instancedMesh,
      tempMatrix,
      rafId,
      resizeObserver,
    };

    // ── 언마운트 정리 ─────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      controls.dispose();
      lineGeo.dispose();
      lineMat.dispose();
      sphereGeo.dispose();
      jointMat.dispose();
      instancedMesh.dispose();
      renderer.dispose();
      // 언마운트 시 녹화 중이었으면 강제 종료
      if (mediaRecorderRef.current?.state !== "inactive") {
        mediaRecorderRef.current?.stop();
      }
      sceneRef.current = null;
    };
  }, []); // 마운트 시 1회만 실행

  // ── 3D 캔버스 녹화 (Kling AI 레퍼런스 영상 추출) ─────────────────────────
  // isCapturing: true → 녹화 시작, false → 녹화 종료 + 자동 다운로드
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return; // Three.js 씬 초기화 전이면 무시

    if (isCapturing) {
      // ── STEP 1: 배경색을 캡처 전용으로 교체 ──────────────────────────────
      // Kling AI가 뼈대를 명확히 인식할 수 있도록 단색 배경으로 교체
      const bgHex = captureBackgroundRef.current === "green"
        ? 0x00ff00  // 크로마키 녹색
        : 0x000000; // 완전한 검정
      s.renderer.setClearColor(bgHex, 1);

      // ── STEP 2: WebGL 캔버스에서 MediaStream 생성 ──────────────────────
      // renderer.domElement = Three.js가 그리는 실제 <canvas> 요소
      // captureStream(60) → 최대 60fps로 스트림 캡처
      const stream = s.renderer.domElement.captureStream(60);

      // ── STEP 2.5: 오디오 트랙 추가 ────────────────────────────────────
      // Chrome: captureStream() / Firefox: mozCaptureStream()
      // 타입 정의 없는 실험적 API → any 캐스팅
      const audioEl = audioRef?.current;
      if (audioEl) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const el = audioEl as any;
          const captureFn: (() => MediaStream) | undefined =
            el.captureStream?.bind(el) ?? el.mozCaptureStream?.bind(el);
          if (captureFn) {
            const audioStream = captureFn();
            audioStream.getAudioTracks().forEach((track: MediaStreamTrack) => stream.addTrack(track));
          }
        } catch (err) {
          // Safari 등 미지원 브라우저는 오디오 없이 영상만 녹화
          console.warn("[DanceFlow] Audio captureStream not supported:", err);
        }
      }

      // ── STEP 3: MediaRecorder 설정 ────────────────────────────────────
      // vp9+opus(영상+오디오) → vp8+opus → video/webm(브라우저 자동 선택) 순으로 폴백
      // 중간에 vp9-only(오디오 코덱 없음)로 폴백하면 오디오가 누락되므로 제외
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
          ? "video/webm;codecs=vp8,opus"
          : "video/webm";

      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType });

      // 데이터 청크 누적 (timeslice 없으면 stop() 시 한 번에 전달)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };

      // ── STEP 4: 녹화 종료 → WebM 다운로드 ──────────────────────────────
      recorder.onstop = () => {
        const webmBlob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        recordedChunksRef.current = [];

        // 배경색 원복
        if (sceneRef.current) {
          sceneRef.current.renderer.setClearColor(0x080810, 1);
        }

        // WebM 직접 다운로드 (MP4 변환은 Toolbox 탭에서 별도 수행)
        const url = URL.createObjectURL(webmBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "kling_motion_reference.webm";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;

    } else {
      // ── 녹화 중단 → onstop 핸들러가 다운로드 + 배경 원복 처리 ───────────
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
    }
  }, [isCapturing]); // captureBackground는 captureBackgroundRef로 참조

  // ── landmarks 변경 → geometry 업데이트 ──────────────────────────────────
  // React 리렌더 없이 Three.js 오브젝트를 직접 수정 → 60fps 유지
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;

    if (!landmarks) {
      // 랜드마크 없으면 모든 관절을 씬 밖으로 숨김
      for (let i = 0; i < NUM_JOINTS; i++) {
        s.tempMatrix.makeTranslation(0, -999, 0);
        s.instancedMesh.setMatrixAt(i, s.tempMatrix);
      }
      s.instancedMesh.instanceMatrix.needsUpdate = true;

      // 뼈대 선도 원점으로 수렴
      const posAttr = s.lineSegments.geometry.getAttribute("position") as THREE.BufferAttribute;
      (posAttr.array as Float32Array).fill(0);
      posAttr.needsUpdate = true;
      return;
    }

    // ── 뼈대 선분 좌표 업데이트 ─────────────────────────────────────────
    const posAttr = s.lineSegments.geometry.getAttribute(
      "position"
    ) as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    let idx = 0;

    for (const [i, j] of POSE_CONNECTIONS) {
      const a = landmarks[i];
      const b = landmarks[j];
      arr[idx++] = a ? lmX(a) : 0;
      arr[idx++] = a ? lmY(a) : 0;
      arr[idx++] = a ? lmZ(a) : 0;
      arr[idx++] = b ? lmX(b) : 0;
      arr[idx++] = b ? lmY(b) : 0;
      arr[idx++] = b ? lmZ(b) : 0;
    }
    posAttr.needsUpdate = true;
    // frustum culling을 위해 바운딩 구 재계산
    s.lineSegments.geometry.computeBoundingSphere();

    // ── 관절 구체 위치 업데이트 ──────────────────────────────────────────
    for (let i = 0; i < NUM_JOINTS; i++) {
      const lm = landmarks[i];
      if (lm && (lm.visibility ?? 1) > 0.2) {
        s.tempMatrix.makeTranslation(lmX(lm), lmY(lm), lmZ(lm));
      } else {
        s.tempMatrix.makeTranslation(0, -999, 0); // 비가시 관절 숨김
      }
      s.instancedMesh.setMatrixAt(i, s.tempMatrix);
    }
    s.instancedMesh.instanceMatrix.needsUpdate = true;
  }, [landmarks]);

  return (
    <canvas
      ref={canvasRef}
      // display: block으로 인라인 기본 하단 여백 제거
      className="block w-full h-full"
    />
  );
}
