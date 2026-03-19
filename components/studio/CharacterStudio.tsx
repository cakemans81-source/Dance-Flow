"use client";

/**
 * CharacterStudio.tsx — Dance Flow 3D 댄스 스튜디오
 *
 * 파이프라인:
 *  1. /public/character.glb 자동 로드  (커스텀 GLB 드래그&드롭도 지원)
 *  2. DB pose_data(CompactFrame[]) → Bone Quaternion Retargeting
 *  3. 인라인 Web Worker: 60fps 프레임 보간 + 스무딩 (메인 스레드 보호)
 *  4. 시네마틱 3점 조명 + 블랙 배경 (Kling AI 인식 최적)
 *  5. captureStream(60) × 12 Mbps VP9 WebM 녹화 → 다운로드
 *
 * Retargeting 수학:
 *  ① 모델 로드 후 T-pose: 각 본의 worldDir / worldQuat 캡처
 *  ② 매 프레임: lm 좌표 → 방향 벡터 → fromUnitVectors(restDir, targetDir) = delta
 *  ③ newWorldQ  = delta × restWorldQ  (월드 공간 회전 합성)
 *  ④ localQ     = parentWorldQ⁻¹ × newWorldQ  (로컬 공간 변환)
 *  ⑤ bone.quaternion = localQ
 *
 * 최적화:
 *  - 모듈 레벨 temp 오브젝트로 GC 압력 제거 (매 프레임 객체 생성 없음)
 *  - Web Worker 프레임 데이터는 로드 시 1회만 전송
 *  - 토폴로지 체인 상단 본에만 척추 회전 적용 (중복 과회전 방지)
 */

import { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  getMotionSummaries,
  getPoseDataById,
  type MotionSummary,
  type CompactFrame,
} from "@/lib/supabase";

// ── 모듈 레벨 Temp 오브젝트 — 매 프레임 new 없이 재사용 ──────────────────────
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();

// ── MediaPipe 랜드마크 인덱스 ────────────────────────────────────────────────
const LM = {
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW:    13, R_ELBOW:    14,
  L_WRIST:    15, R_WRIST:    16,
  L_HIP:      23, R_HIP:      24,
  L_KNEE:     25, R_KNEE:     26,
  L_ANKLE:    27, R_ANKLE:    28,
} as const;

// ── Mixamo 표준 본 이름 + 범용 폴백 패턴 ────────────────────────────────────
// mixamorig: prefix 유무 모두 처리, ReadyPlayerMe / VRoid 폴백 포함
const BONE_PATTERNS: Record<string, RegExp[]> = {
  hips:          [/(?:mixamorig[_:]?)?Hips$/i,          /pelvis/i],
  spine:         [/(?:mixamorig[_:]?)?Spine$/i],
  spine1:        [/(?:mixamorig[_:]?)?Spine1$/i,        /spine[_-]1/i],
  spine2:        [/(?:mixamorig[_:]?)?Spine2$/i,        /spine[_-]2/i, /upperchest/i, /chest$/i],
  neck:          [/(?:mixamorig[_:]?)?Neck$/i],
  head:          [/(?:mixamorig[_:]?)?Head$/i],
  leftShoulder:  [/(?:mixamorig[_:]?)?LeftShoulder$/i,  /shoulder.*l\b/i],
  leftArm:       [/(?:mixamorig[_:]?)?LeftArm$/i,       /leftupperarm/i, /^arm[_.]l$/i],
  leftForeArm:   [/(?:mixamorig[_:]?)?LeftForeArm$/i,   /leftlowerarm/i, /forearm.*l/i],
  leftHand:      [/(?:mixamorig[_:]?)?LeftHand$/i,      /^hand[_.]l$/i],
  rightShoulder: [/(?:mixamorig[_:]?)?RightShoulder$/i, /shoulder.*r\b/i],
  rightArm:      [/(?:mixamorig[_:]?)?RightArm$/i,      /rightupperarm/i, /^arm[_.]r$/i],
  rightForeArm:  [/(?:mixamorig[_:]?)?RightForeArm$/i,  /rightlowerarm/i, /forearm.*r/i],
  rightHand:     [/(?:mixamorig[_:]?)?RightHand$/i,     /^hand[_.]r$/i],
  leftUpLeg:     [/(?:mixamorig[_:]?)?LeftUpLeg$/i,     /leftthigh/i,  /upleg.*l/i],
  leftLeg:       [/(?:mixamorig[_:]?)?LeftLeg$/i,       /leftcalf/i,   /lowerleg.*l/i],
  leftFoot:      [/(?:mixamorig[_:]?)?LeftFoot$/i,      /foot.*l\b/i],
  rightUpLeg:    [/(?:mixamorig[_:]?)?RightUpLeg$/i,    /rightthigh/i, /upleg.*r/i],
  rightLeg:      [/(?:mixamorig[_:]?)?RightLeg$/i,      /rightcalf/i,  /lowerleg.*r/i],
  rightFoot:     [/(?:mixamorig[_:]?)?RightFoot$/i,     /foot.*r\b/i],
};

type BoneKey   = keyof typeof BONE_PATTERNS;
type HumanoidBones = Partial<Record<BoneKey, THREE.Bone>>;
type LMData    = number[][];
type CamPreset = "diagonal" | "front" | "side" | "top";

interface BoneRest {
  worldDir:  THREE.Vector3;     // T-pose에서 본→첫번째 자식 방향 (월드)
  worldQuat: THREE.Quaternion;  // T-pose 월드 쿼터니언
  localQuat: THREE.Quaternion;  // T-pose 로컬 쿼터니언 (리셋용)
}

interface SceneRefs {
  renderer:  THREE.WebGLRenderer;
  scene:     THREE.Scene;
  camera:    THREE.PerspectiveCamera;
  controls:  OrbitControls;
  rafId:     number;
  resizeObs: ResizeObserver;
}

// ── 인라인 Web Worker (Blob URL) ──────────────────────────────────────────────
// 프레임 보간 + 지수 스무딩을 메인 스레드 밖에서 수행
const WORKER_SRC = `
let frames = [];
let prev = null;
const SMOOTH = 0.45; // 0 = 스무딩 없음, 1 = 완전 동결

function interp(ts) {
  if (!frames.length) return [];
  const t = Math.max(frames[0].t, Math.min(frames[frames.length-1].t, ts));
  let lo = 0, hi = frames.length - 1;
  while (lo < hi - 1) { const m=(lo+hi)>>1; if(frames[m].t<=t) lo=m; else hi=m; }
  const A=frames[lo], B=frames[hi];
  const a = B.t>A.t ? Math.max(0,Math.min(1,(t-A.t)/(B.t-A.t))) : 0;
  return A.lm.map((la,i)=>{
    const lb=B.lm[i]??la;
    return [la[0]+(lb[0]-la[0])*a, la[1]+(lb[1]-la[1])*a, la[2]+(lb[2]-la[2])*a, la[3]+(lb[3]-la[3])*a];
  });
}

self.onmessage = function(e) {
  if (e.data.type==='init') { frames=e.data.frames; prev=null; return; }
  let lms = interp(e.data.ts);
  if (prev && prev.length===lms.length)
    lms = lms.map((l,i)=>l.map((v,j)=>prev[i][j]+(v-prev[i][j])*(1-SMOOTH)));
  prev = lms;
  self.postMessage({ lms });
};
`;

// ── 카메라 프리셋 ──────────────────────────────────────────────────────────────
const CAM: Record<CamPreset, { pos: [number,number,number]; tgt: [number,number,number] }> = {
  diagonal: { pos: [2.5, 1.6, 2.8],  tgt: [0, 0.9, 0] },
  front:    { pos: [0,   1.5, 4.0],  tgt: [0, 0.9, 0] },
  side:     { pos: [4.0, 1.5, 0],    tgt: [0, 0.9, 0] },
  top:      { pos: [0,   6,   0.1],  tgt: [0, 0,   0] },
};

// ═════════════════════════════════════════════════════════════════════════════
// 순수 함수 유틸
// ═════════════════════════════════════════════════════════════════════════════

function findBones(root: THREE.Object3D): HumanoidBones {
  const result: HumanoidBones = {};
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Bone)) return;
    const name = obj.name.replace(/\s+/g, "_");
    for (const [key, patterns] of Object.entries(BONE_PATTERNS)) {
      if (!result[key as BoneKey] && patterns.some((p) => p.test(name))) {
        result[key as BoneKey] = obj;
      }
    }
  });
  return result;
}

/** T-pose 상태에서 각 본의 월드 방향/쿼터니언을 스냅샷으로 저장 */
function captureRest(bones: HumanoidBones): Map<BoneKey, BoneRest> {
  const map = new Map<BoneKey, BoneRest>();
  for (const [key, bone] of Object.entries(bones) as [BoneKey, THREE.Bone][]) {
    if (!bone) continue;
    const wq = new THREE.Quaternion();
    bone.getWorldQuaternion(wq);
    const wp = new THREE.Vector3();
    bone.getWorldPosition(wp);
    let dir = new THREE.Vector3(0, 1, 0);
    for (const ch of bone.children) {
      if (ch instanceof THREE.Bone) {
        const cp = new THREE.Vector3();
        ch.getWorldPosition(cp);
        dir = cp.clone().sub(wp).normalize();
        break;
      }
    }
    map.set(key, { worldDir: dir, worldQuat: wq.clone(), localQuat: bone.quaternion.clone() });
  }
  return map;
}

/** MediaPipe lm → THREE.Vector3 (Y축 반전: MP는 Y아래, THREE는 Y위) */
function lmv(lm: LMData, i: number): THREE.Vector3 {
  const l = lm[i];
  if (!l) return new THREE.Vector3();
  return new THREE.Vector3(l[0], -l[1], -l[2]);
}

/**
 * 단일 본 Retargeting (모듈 레벨 temp 오브젝트 재사용)
 *
 * 수학:
 *   delta    = fromUnitVectors(restDir, targetDir)
 *   newWorldQ = delta × restWorldQ
 *   localQ   = parentWorldQ⁻¹ × newWorldQ
 */
function retargetBone(bone: THREE.Bone, rest: BoneRest, targetDir: THREE.Vector3): void {
  _va.copy(targetDir).normalize();
  if (_va.lengthSq() < 1e-6) { bone.quaternion.copy(rest.localQuat); return; }

  _vb.copy(rest.worldDir).normalize();
  // delta = fromUnitVectors(restDir, targetDir)
  _qa.setFromUnitVectors(_vb, _va);
  // newWorldQ = delta × restWorldQ
  _qb.copy(rest.worldQuat);
  _qa.multiply(_qb); // _qa = delta × restWorldQ

  // localQ = parentWorldQ⁻¹ × newWorldQ
  _qc.identity();
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qc);
    _qc.invert();
  }
  _qc.multiply(_qa); // _qc = invParent × newWorldQ

  bone.quaternion.copy(_qc);
  bone.updateMatrix();
}

/**
 * 전체 포즈 적용
 * - 척추: 체인 최상단 본 하나에만 적용 (중복 과회전 방지)
 * - 팔·다리: 부모→자식 순서 보장 (leftArm 먼저, leftForeArm 다음)
 */
function applyPose(lm: LMData, bones: HumanoidBones, rest: Map<BoneKey, BoneRest>): void {
  const ls = lmv(lm, LM.L_SHOULDER), rs = lmv(lm, LM.R_SHOULDER);
  const le = lmv(lm, LM.L_ELBOW),   re = lmv(lm, LM.R_ELBOW);
  const lw = lmv(lm, LM.L_WRIST),   rw = lmv(lm, LM.R_WRIST);
  const lh = lmv(lm, LM.L_HIP),     rh = lmv(lm, LM.R_HIP);
  const lk = lmv(lm, LM.L_KNEE),    rk = lmv(lm, LM.R_KNEE);
  const la = lmv(lm, LM.L_ANKLE),   ra = lmv(lm, LM.R_ANKLE);

  // 척추 방향: 힙 중점 → 어깨 중점
  const hipC      = new THREE.Vector3().addVectors(lh, rh).multiplyScalar(0.5);
  const shoulderC = new THREE.Vector3().addVectors(ls, rs).multiplyScalar(0.5);
  const spineDir  = new THREE.Vector3().subVectors(shoulderC, hipC);

  // 척추 체인 최상단 본만 회전 (spine2 > spine1 > spine 우선순위)
  const topSpineKey = (["spine2", "spine1", "spine"] as BoneKey[]).find((k) => bones[k]);
  if (topSpineKey) {
    const r = rest.get(topSpineKey);
    if (r) retargetBone(bones[topSpineKey]!, r, spineDir);
  }

  // 팔·다리 (부모→자식 순서)
  const apply = (key: BoneKey, dir: THREE.Vector3) => {
    const b = bones[key], r = rest.get(key);
    if (b && r) retargetBone(b, r, dir);
  };
  apply("leftArm",      new THREE.Vector3().subVectors(le, ls));
  apply("leftForeArm",  new THREE.Vector3().subVectors(lw, le));
  apply("rightArm",     new THREE.Vector3().subVectors(re, rs));
  apply("rightForeArm", new THREE.Vector3().subVectors(rw, re));
  apply("leftUpLeg",    new THREE.Vector3().subVectors(lk, lh));
  apply("leftLeg",      new THREE.Vector3().subVectors(la, lk));
  apply("rightUpLeg",   new THREE.Vector3().subVectors(rk, rh));
  apply("rightLeg",     new THREE.Vector3().subVectors(ra, rk));
}

/** 시네마틱 3점 조명 세팅 */
function setupLighting(scene: THREE.Scene): void {
  scene.children.filter((c) => c.userData.__light).forEach((c) => scene.remove(c));

  // 키라이트: 따뜻한 주광 (우상단)
  const key = new THREE.DirectionalLight(0xfff4e0, 3.2);
  key.position.set(3, 5, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far  = 20;
  key.userData.__light = true;

  // 필라이트: 차가운 보조광 (좌하단)
  const fill = new THREE.DirectionalLight(0xc8d8ff, 1.0);
  fill.position.set(-4, 2, -2);
  fill.userData.__light = true;

  // 림라이트: 실루엣 분리 (후면)
  const rim = new THREE.DirectionalLight(0xffffff, 1.8);
  rim.position.set(0, 3.5, -6);
  rim.userData.__light = true;

  // 환경광: 약한 헤미스피어
  const amb = new THREE.HemisphereLight(0x334466, 0x110a00, 0.5);
  amb.userData.__light = true;

  scene.add(key, fill, rim, amb);
}

// ═════════════════════════════════════════════════════════════════════════════
// 컴포넌트
// ═════════════════════════════════════════════════════════════════════════════
export default function CharacterStudio() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef  = useRef<SceneRefs | null>(null);
  const modelRef  = useRef<THREE.Object3D | null>(null);
  const bonesRef  = useRef<HumanoidBones>({});
  const restRef   = useRef<Map<BoneKey, BoneRest>>(new Map());
  const workerRef = useRef<Worker | null>(null);

  // 재생
  const framesRef   = useRef<CompactFrame[]>([]);
  const durationRef = useRef<number>(0);
  const startRef    = useRef<number>(0);
  const playingRef  = useRef<boolean>(false);

  // 녹화
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);

  // ── UI 상태 ──────────────────────────────────────────────────────────────
  const [modelName,   setModelName]   = useState<string | null>(null);
  const [boneCount,   setBoneCount]   = useState(0);
  const [motions,     setMotions]     = useState<MotionSummary[]>([]);
  const [selectedId,  setSelectedId]  = useState("");
  const [poseLoaded,  setPoseLoaded]  = useState(false);
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordUrl,   setRecordUrl]   = useState<string | null>(null);
  const [camPreset,   setCamPreset]   = useState<CamPreset>("diagonal");
  const [status,      setStatus]      = useState("기본 캐릭터를 로드 중…");
  const [dbLoading,   setDbLoading]   = useState(true);

  // ── DB 모션 목록 ──────────────────────────────────────────────────────────
  useEffect(() => {
    getMotionSummaries(50)
      .then((list) => { setMotions(list); if (list[0]) setSelectedId(list[0].id); })
      .catch(() => {})
      .finally(() => setDbLoading(false));
  }, []);

  // ── 인라인 Worker ─────────────────────────────────────────────────────────
  useEffect(() => {
    const blob = new Blob([WORKER_SRC], { type: "application/javascript" });
    const url  = URL.createObjectURL(blob);
    const w    = new Worker(url);
    w.onmessage = (e) => {
      if (!playingRef.current) return;
      applyPose(e.data.lms as LMData, bonesRef.current, restRef.current);
    };
    workerRef.current = w;
    URL.revokeObjectURL(url);
    return () => w.terminate();
  }, []);

  // ── Three.js 씬 초기화 ────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setClearColor(0x000000, 1);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000); // 기본: 블랙 (Kling AI 최적)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.set(...CAM.diagonal.pos);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping  = true;
    controls.dampingFactor  = 0.05;
    controls.minDistance    = 0.5;
    controls.maxDistance    = 25;
    controls.target.set(...CAM.diagonal.tgt);
    controls.update();

    setupLighting(scene);

    // 바닥 (블랙 배경에서는 숨겨도 되지만 참조용으로 유지)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = "floor";
    scene.add(floor);

    // ResizeObserver
    const resizeObs = new ResizeObserver(() => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resizeObs.observe(canvas);
    renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false);
    camera.aspect = (canvas.clientWidth || 800) / (canvas.clientHeight || 600);
    camera.updateProjectionMatrix();

    // RAF 루프
    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.update();
      if (playingRef.current && framesRef.current.length > 0) {
        const elapsed = (performance.now() - startRef.current) / 1000;
        const t0 = framesRef.current[0].t;
        const loopT = durationRef.current > 0 ? elapsed % durationRef.current : 0;
        workerRef.current?.postMessage({ type: "query", ts: t0 + loopT });
      }
      renderer.render(scene, camera);
    };
    animate();

    sceneRef.current = { renderer, scene, camera, controls, rafId, resizeObs };

    // 기본 캐릭터 자동 로드
    loadGlbUrl("/character.glb");

    return () => {
      cancelAnimationFrame(rafId);
      resizeObs.disconnect();
      controls.dispose();
      renderer.dispose();
      sceneRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 카메라 프리셋 동기화 ──────────────────────────────────────────────────
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.camera.position.set(...CAM[camPreset].pos);
    s.controls.target.set(...CAM[camPreset].tgt);
    s.controls.update();
  }, [camPreset]);

  // ── GLB 로드 (URL 버전: /public 경로 또는 Object URL) ─────────────────────
  const loadGlbUrl = useCallback((url: string, displayName?: string) => {
    const s = sceneRef.current;
    if (!s) return;

    setStatus("3D 모델 로드 중…");
    playingRef.current = false;
    setIsPlaying(false);

    if (modelRef.current) {
      s.scene.remove(modelRef.current);
      // 모델 메모리 해제
      modelRef.current.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
        }
      });
      modelRef.current = null;
    }

    new GLTFLoader().load(
      url,
      (gltf) => {
        const isObjectUrl = url.startsWith("blob:");
        if (isObjectUrl) URL.revokeObjectURL(url);

        const model = gltf.scene;
        const box   = new THREE.Box3().setFromObject(model);
        const size  = box.getSize(new THREE.Vector3());
        const min   = box.min;

        // 발 → y=0 정렬, X/Z 중심 정렬
        model.position.set(
          -(min.x + size.x / 2),
          -min.y,
          -(min.z + size.z / 2)
        );

        model.traverse((obj) => {
          if (obj instanceof THREE.Mesh) { obj.castShadow = true; obj.receiveShadow = true; }
        });

        s.scene.add(model);
        model.updateMatrixWorld(true); // T-pose 캡처 전 월드 행렬 강제 갱신

        const bones  = findBones(model);
        const bCount = Object.values(bones).filter(Boolean).length;
        bonesRef.current = bones;
        restRef.current  = captureRest(bones);
        modelRef.current = model;
        setBoneCount(bCount);

        // 모델 높이에 맞게 카메라 거리 보정
        const scale = size.y > 0 ? size.y / 1.75 : 1;
        const p = CAM[camPreset];
        s.camera.position.set(p.pos[0]*scale, p.pos[1]*scale, p.pos[2]*scale);
        s.controls.target.set(0, size.y * 0.5, 0);
        s.controls.update();

        const name = displayName ?? url.split("/").pop() ?? "character.glb";
        setModelName(name);
        setStatus(
          bCount > 0
            ? `✅ ${name} 로드 완료 · ${bCount}개 본 매핑됨`
            : `⚠️ ${name} 로드됨 — 본을 찾지 못함 (Armature 포함 여부 확인)`
        );
      },
      undefined,
      (err) => {
        setStatus(`모델 로드 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    );
  }, [camPreset]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 드래그&드롭 / 파일 선택 (커스텀 GLB 오버라이드) ──────────────────────
  const handleFileDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (ext !== "glb" && ext !== "gltf") { setStatus("GLB / GLTF 파일만 지원됩니다."); return; }
      loadGlbUrl(URL.createObjectURL(file), file.name);
    },
    [loadGlbUrl]
  );
  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) loadGlbUrl(URL.createObjectURL(file), file.name);
    },
    [loadGlbUrl]
  );

  // ── 포즈 데이터 로드 ──────────────────────────────────────────────────────
  const handleLoadPose = useCallback(async () => {
    if (!selectedId) return;
    setStatus("포즈 데이터 로드 중…");
    try {
      const pd = await getPoseDataById(selectedId);
      if (!pd?.frames.length) { setStatus("❌ pose_data 없음 — Extract 모드에서 저장 필요"); return; }
      framesRef.current   = pd.frames;
      durationRef.current = pd.meta.duration;
      workerRef.current?.postMessage({ type: "init", frames: pd.frames });
      setPoseLoaded(true);
      setStatus(`✅ ${pd.meta.frameCount}프레임 / ${pd.meta.duration.toFixed(1)}s 로드 완료`);
    } catch (e) {
      setStatus(`포즈 로드 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [selectedId]);

  // ── 재생 / 정지 ──────────────────────────────────────────────────────────
  const handlePlay = useCallback(() => {
    if (!modelRef.current) { setStatus("모델 로드 중입니다."); return; }
    if (!framesRef.current.length) { setStatus("먼저 안무 데이터를 로드하세요."); return; }
    startRef.current   = performance.now();
    playingRef.current = true;
    setIsPlaying(true);
    setStatus("▶ 재생 중…");
  }, []);

  const handleStop = useCallback(() => {
    playingRef.current = false;
    setIsPlaying(false);
    setStatus("■ 정지");
    for (const [key, rest] of restRef.current) {
      const b = bonesRef.current[key as BoneKey];
      if (b) { b.quaternion.copy(rest.localQuat); b.updateMatrix(); }
    }
  }, []);

  // ── 3D 안무 영상 추출 ─────────────────────────────────────────────────────
  const handleStartRecord = useCallback(() => {
    const s = sceneRef.current;
    if (!s) return;
    if (!modelRef.current || !framesRef.current.length) {
      setStatus("모델과 안무 데이터가 모두 필요합니다."); return;
    }
    if (recordUrl) { URL.revokeObjectURL(recordUrl); setRecordUrl(null); }

    // 재생 시작 (아직 재생 중이 아닌 경우)
    if (!playingRef.current) {
      startRef.current   = performance.now();
      playingRef.current = true;
      setIsPlaying(true);
    }

    const stream   = s.renderer.domElement.captureStream(60);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";

    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
    recorderRef.current = rec;
    chunksRef.current   = [];

    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: "video/webm" });
      setRecordUrl(URL.createObjectURL(blob));
      setIsRecording(false);
      setStatus("✅ 영상 추출 완료 — 다운로드 후 Kling AI에 업로드하세요.");
    };

    rec.start(100);
    setIsRecording(true);
    setStatus("🔴 녹화 중… 12 Mbps · VP9 · 60fps");
  }, [recordUrl]);

  const handleStopRecord = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const handleDownload = useCallback(() => {
    if (!recordUrl) return;
    const a = document.createElement("a");
    a.href = recordUrl; a.download = `dance_flow_3d_${Date.now()}.webm`; a.click();
  }, [recordUrl]);

  // ── 언마운트 클린업 ───────────────────────────────────────────────────────
  useEffect(() => () => {
    if (recordUrl) URL.revokeObjectURL(recordUrl);
  }, [recordUrl]);

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden bg-[#0a0a0a]">

      {/* ── 좌측 패널 ── */}
      <div className="w-[272px] flex-shrink-0 flex flex-col gap-3 p-4 border-r border-zinc-800 overflow-y-auto">

        <div>
          <h2 className="text-sm font-bold text-zinc-100">🎭 3D 댄스 스튜디오</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">Retargeting → Kling AI 레퍼런스 영상</p>
        </div>

        {/* 상태 표시 */}
        <div className="text-[11px] leading-relaxed bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-400 min-h-[2.8rem]">
          {status}
          {boneCount > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-400 text-[10px] font-semibold">
              {boneCount} bones
            </span>
          )}
        </div>

        {/* ── 1. 3D 모델 ── */}
        <Sec label="3D 모델 (커스텀 교체)">
          <div
            onDrop={handleFileDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => document.getElementById("cs-file-input")?.click()}
            className="border-2 border-dashed border-zinc-700 hover:border-violet-500 rounded-xl p-3 text-center cursor-pointer transition-colors"
          >
            <p className="text-[11px] text-zinc-500">
              드래그&드롭 또는 클릭<br />
              <span className="text-[10px] text-zinc-600">Mixamo · ReadyPlayerMe · VRoid GLB</span>
            </p>
            {modelName && modelName !== "character.glb" && (
              <p className="text-[10px] text-emerald-400 mt-1 truncate">↑ {modelName}</p>
            )}
          </div>
          <input id="cs-file-input" type="file" accept=".glb,.gltf" className="hidden" onChange={handleFileInput} />
          <button
            onClick={() => loadGlbUrl("/character.glb", "character.glb")}
            className="w-full py-1.5 rounded-lg text-[11px] font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            🔄 기본 캐릭터 재로드
          </button>
        </Sec>

        {/* ── 2. 안무 데이터 ── */}
        <Sec label="안무 데이터 (DB)">
          {dbLoading
            ? <p className="text-[11px] text-zinc-500 animate-pulse">로드 중…</p>
            : motions.length === 0
              ? <p className="text-[11px] text-amber-400">저장된 모션 없음</p>
              : (
                <>
                  <select
                    value={selectedId}
                    onChange={(e) => { setSelectedId(e.target.value); setPoseLoaded(false); }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500"
                  >
                    {motions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <button
                    onClick={handleLoadPose}
                    disabled={!selectedId}
                    className="w-full py-1.5 rounded-lg text-xs font-semibold bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white transition-colors"
                  >
                    📥 포즈 데이터 로드{poseLoaded ? " ✓" : ""}
                  </button>
                </>
              )
          }
        </Sec>

        {/* ── 3. 카메라 앵글 ── */}
        <Sec label="카메라 앵글">
          <div className="grid grid-cols-2 gap-1">
            {(["diagonal", "front", "side", "top"] as CamPreset[]).map((p) => (
              <button key={p} onClick={() => setCamPreset(p)}
                className={`py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                  camPreset === p ? "bg-violet-700 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}>
                {{ diagonal:"45°", front:"정면", side:"측면", top:"탑뷰" }[p]}
              </button>
            ))}
          </div>
        </Sec>

        {/* ── 4. 재생 ── */}
        <Sec label="재생">
          {!isPlaying
            ? <button onClick={handlePlay} disabled={!poseLoaded}
                className="w-full py-2 rounded-lg text-xs font-semibold bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white transition-colors">
                ▶ 재생
              </button>
            : <button onClick={handleStop}
                className="w-full py-2 rounded-lg text-xs font-semibold bg-zinc-700 hover:bg-zinc-600 text-white transition-colors">
                ■ 정지 · T-pose 리셋
              </button>
          }
        </Sec>

        {/* ── 5. 영상 추출 ── */}
        <div className="mt-auto pt-3 border-t border-zinc-800 flex flex-col gap-2">
          <p className="text-[10px] text-zinc-500 leading-relaxed">
            <span className="text-zinc-400 font-semibold">Kling AI 모션 컨트롤 입력용</span><br />
            블랙 배경 · 12 Mbps VP9 · 60fps WebM
          </p>
          {!isRecording
            ? <button onClick={handleStartRecord} disabled={!poseLoaded}
                className="w-full py-2.5 rounded-lg text-sm font-bold bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white transition-colors">
                🎬 3D 안무 영상 추출
              </button>
            : <button onClick={handleStopRecord}
                className="w-full py-2.5 rounded-lg text-sm font-bold bg-red-900 hover:bg-red-800 text-white animate-pulse transition-colors">
                ⏹ 녹화 중단
              </button>
          }
          {recordUrl && (
            <button onClick={handleDownload}
              className="w-full py-2 rounded-lg text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 text-white transition-colors">
              ⬇ WebM 다운로드
            </button>
          )}
        </div>
      </div>

      {/* ── 우측: Three.js 캔버스 ── */}
      <div className="flex-1 relative overflow-hidden bg-black">
        <canvas ref={canvasRef} className="block w-full h-full" />

        {isPlaying && (
          <div className="absolute top-3 right-3 flex items-center gap-1.5 pointer-events-none">
            <span className="w-2 h-2 rounded-full bg-violet-500 animate-pulse" />
            <span className="text-[11px] text-violet-400 font-semibold select-none">LIVE</span>
          </div>
        )}
        {isRecording && (
          <div className="absolute top-3 left-3 flex items-center gap-1.5 pointer-events-none">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-[11px] text-red-400 font-semibold select-none">REC · 12 Mbps</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Sec({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{label}</span>
      {children}
    </div>
  );
}
