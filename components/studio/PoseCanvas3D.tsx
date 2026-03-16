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

import { useRef, useEffect } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Landmark3D } from "@/hooks/usePose";

// ── 상수 ─────────────────────────────────────────────────────────────────────
const NUM_JOINTS = 33;
const SCALE = 2.5; // MediaPipe 미터 단위 → Three.js 씬 유닛 스케일

const POSE_CONNECTIONS: [number, number][] = [
  // 얼굴
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  // 어깨
  [11, 12],
  // 왼팔
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  // 오른팔
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  // 몸통
  [11, 23], [12, 24], [23, 24],
  // 왼다리
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  // 오른다리
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];
const NUM_CONNECTIONS = POSE_CONNECTIONS.length;

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
}

export default function PoseCanvas3D({ landmarks }: PoseCanvas3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // sceneRef: React state가 아닌 mutable ref로 Three.js 씬을 보관
  // → 업데이트 시 리렌더 없이 직접 접근
  const sceneRef = useRef<SceneRefs | null>(null);

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

    // ── 조명 ─────────────────────────────────────────────────────────────
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(3, 6, 4);
    scene.add(dirLight);

    // 보라색 림 라이트 (뒤에서)
    const rimLight = new THREE.PointLight(0x7c3aed, 1.2, 20);
    rimLight.position.set(-2, 2, -3);
    scene.add(rimLight);

    // 바운스 라이트 (아래에서)
    const bounceLight = new THREE.PointLight(0xa78bfa, 0.4, 10);
    bounceLight.position.set(0, -2, 2);
    scene.add(bounceLight);

    // ── 바닥 그리드 ───────────────────────────────────────────────────────
    // GridHelper: (크기, 분할수, 중심색, 격자색)
    const grid = new THREE.GridHelper(10, 20, 0x2d2b55, 0x1a1a2e);
    grid.position.y = -1.3;
    scene.add(grid);

    // ── 뼈대 LineSegments ────────────────────────────────────────────────
    // DynamicDrawUsage: GPU에 "이 버퍼는 자주 변경된다" 힌트 → DYNAMIC_DRAW
    const lineGeo = new THREE.BufferGeometry();
    const linePositions = new Float32Array(NUM_CONNECTIONS * 2 * 3);
    const linePosAttr = new THREE.BufferAttribute(linePositions, 3);
    linePosAttr.setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute("position", linePosAttr);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x7c3aed,
      transparent: true,
      opacity: 0.9,
    });
    const lineSegments = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(lineSegments);

    // ── 관절 InstancedMesh ───────────────────────────────────────────────
    // 33개 구체를 InstancedMesh 단일 드로우콜로 렌더링
    const sphereGeo = new THREE.SphereGeometry(0.03, 10, 7);
    const jointMat = new THREE.MeshStandardMaterial({
      color: 0xa78bfa,
      emissive: 0x5b21b6,
      emissiveIntensity: 0.6,
      roughness: 0.2,
      metalness: 0.15,
    });
    const instancedMesh = new THREE.InstancedMesh(sphereGeo, jointMat, NUM_JOINTS);
    const tempMatrix = new THREE.Matrix4();
    // 초기화: 모든 관절을 씬 밖으로 숨김
    for (let i = 0; i < NUM_JOINTS; i++) {
      tempMatrix.makeTranslation(0, -999, 0);
      instancedMesh.setMatrixAt(i, tempMatrix);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;
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
      renderer.dispose();
      sceneRef.current = null;
    };
  }, []); // 마운트 시 1회만 실행

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
