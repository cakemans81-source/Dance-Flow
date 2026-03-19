"use client";

/**
 * CharacterStudio.tsx — Dance Flow 3D 댄스 스튜디오 (v3)
 *
 * 파이프라인:
 *  1. /public/character.glb 자동 로드  (Mixamo cm 단위 자동 스케일)
 *  2. DB pose_data(CompactFrame[]) 로드  → motion_data 폴백 지원
 *  3. 동기 인라인 보간 + EMA 스무딩 (Worker 제거 — 레이턴시 0)
 *  4. 60fps RAF에서 applyPose → Bone.quaternion 직접 수정
 *  5. SkinnedMesh.skeleton.bones 폴백 포함 강화 본 감지
 *  6. [🎬 3D 안무 영상 추출] 명시 클릭 시에만 captureStream 활성화
 *
 * Retargeting:
 *  restDir = T-pose에서 본→자식 월드 방향 벡터
 *  delta   = fromUnitVectors(restDir, targetDir)  [월드 공간]
 *  newQ    = delta × restWorldQ
 *  localQ  = parentWorldQ⁻¹ × newQ
 */

import { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  getMotionSummaries,
  getPoseDataById,
  getMotionById,
  buildPoseData,
  type MotionSummary,
  type CompactFrame,
} from "@/lib/supabase";

// ── 모듈 레벨 재사용 Temp (매 프레임 new 없음) ────────────────────────────────
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();

// ── MediaPipe Pose world landmark 인덱스 ─────────────────────────────────────
// poseWorldLandmarks: 힙 중심, 미터 단위 3D (y↓ 양수)
const LM = {
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW:    13, R_ELBOW:    14,
  L_WRIST:    15, R_WRIST:    16,
  L_HIP:      23, R_HIP:      24,
  L_KNEE:     25, R_KNEE:     26,
  L_ANKLE:    27, R_ANKLE:    28,
} as const;

// ── Mixamo / ReadyPlayerMe / VRoid 본 이름 패턴 ──────────────────────────────
const BONE_PATTERNS: Record<string, RegExp[]> = {
  hips:          [/(?:mixamorig[_:.])?Hips$/i,          /pelvis/i, /root/i],
  spine:         [/(?:mixamorig[_:.])?Spine$/i],
  spine1:        [/(?:mixamorig[_:.])?Spine1$/i,        /spine[_.]1$/i],
  spine2:        [/(?:mixamorig[_:.])?Spine2$/i,        /spine[_.]2$/i, /upperchest/i, /chest$/i],
  neck:          [/(?:mixamorig[_:.])?Neck$/i],
  head:          [/(?:mixamorig[_:.])?Head$/i],
  leftShoulder:  [/(?:mixamorig[_:.])?LeftShoulder$/i,  /shoulder[_.]l$/i],
  leftArm:       [/(?:mixamorig[_:.])?LeftArm$/i,       /leftupperarm/i, /arm[_.]l$/i],
  leftForeArm:   [/(?:mixamorig[_:.])?LeftForeArm$/i,   /leftlowerarm/i, /forearm[_.]l$/i],
  leftHand:      [/(?:mixamorig[_:.])?LeftHand$/i,      /hand[_.]l$/i],
  rightShoulder: [/(?:mixamorig[_:.])?RightShoulder$/i, /shoulder[_.]r$/i],
  rightArm:      [/(?:mixamorig[_:.])?RightArm$/i,      /rightupperarm/i, /arm[_.]r$/i],
  rightForeArm:  [/(?:mixamorig[_:.])?RightForeArm$/i,  /rightlowerarm/i, /forearm[_.]r$/i],
  rightHand:     [/(?:mixamorig[_:.])?RightHand$/i,     /hand[_.]r$/i],
  leftUpLeg:     [/(?:mixamorig[_:.])?LeftUpLeg$/i,     /leftthigh/i,  /upleg[_.]l$/i],
  leftLeg:       [/(?:mixamorig[_:.])?LeftLeg$/i,       /leftcalf/i,   /leg[_.]l$/i],
  leftFoot:      [/(?:mixamorig[_:.])?LeftFoot$/i,      /foot[_.]l$/i],
  rightUpLeg:    [/(?:mixamorig[_:.])?RightUpLeg$/i,    /rightthigh/i, /upleg[_.]r$/i],
  rightLeg:      [/(?:mixamorig[_:.])?RightLeg$/i,      /rightcalf/i,  /leg[_.]r$/i],
  rightFoot:     [/(?:mixamorig[_:.])?RightFoot$/i,     /foot[_.]r$/i],
};

type BoneKey   = keyof typeof BONE_PATTERNS;
type HumanoidBones = Partial<Record<BoneKey, THREE.Bone>>;
type LMData    = number[][];
type CamPreset = "diagonal" | "front" | "side" | "top";

interface BoneRest {
  worldDir:  THREE.Vector3;
  worldQuat: THREE.Quaternion;
  localQuat: THREE.Quaternion;
}

interface SceneRefs {
  renderer:  THREE.WebGLRenderer;
  scene:     THREE.Scene;
  camera:    THREE.PerspectiveCamera;
  controls:  OrbitControls;
  rafId:     number;
  resizeObs: ResizeObserver;
}

// ── 카메라 프리셋 ──────────────────────────────────────────────────────────────
const CAM: Record<CamPreset, { pos: [number,number,number]; tgt: [number,number,number] }> = {
  diagonal: { pos: [2.5, 1.6, 2.8],  tgt: [0, 0.9, 0] },
  front:    { pos: [0,   1.5, 4.0],  tgt: [0, 0.9, 0] },
  side:     { pos: [4.0, 1.5, 0],    tgt: [0, 0.9, 0] },
  top:      { pos: [0,   6,   0.1],  tgt: [0, 0,   0] },
};

// ══════════════════════════════════════════════════════════════════════════════
// 순수 함수 유틸
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 강화된 본 감지:
 *  1차 — scene graph 순회 (instanceof THREE.Bone)
 *  2차 폴백 — SkinnedMesh.skeleton.bones (일부 GLB 포맷)
 */
function findBones(root: THREE.Object3D): HumanoidBones {
  const result: HumanoidBones = {};
  const boneSet = new Set<THREE.Bone>();

  root.traverse((obj) => {
    if (obj instanceof THREE.Bone) boneSet.add(obj);
    if (obj instanceof THREE.SkinnedMesh) {
      obj.skeleton.bones.forEach((b) => boneSet.add(b));
    }
  });

  for (const bone of boneSet) {
    const name = bone.name.replace(/[\s]/g, "_");
    for (const [key, patterns] of Object.entries(BONE_PATTERNS)) {
      if (!result[key as BoneKey] && patterns.some((p) => p.test(name))) {
        result[key as BoneKey] = bone;
      }
    }
  }
  return result;
}

/** T-pose 월드 방향 & 쿼터니언 캡처 (scene.add + updateMatrixWorld 후 호출) */
function captureRest(bones: HumanoidBones): Map<BoneKey, BoneRest> {
  const map = new Map<BoneKey, BoneRest>();
  for (const [key, bone] of Object.entries(bones) as [BoneKey, THREE.Bone][]) {
    if (!bone) continue;
    const wq = new THREE.Quaternion(); bone.getWorldQuaternion(wq);
    const wp = new THREE.Vector3();   bone.getWorldPosition(wp);
    let dir = new THREE.Vector3(0, 1, 0);
    for (const ch of bone.children) {
      if (ch instanceof THREE.Bone) {
        const cp = new THREE.Vector3(); ch.getWorldPosition(cp);
        dir = cp.clone().sub(wp).normalize(); break;
      }
    }
    map.set(key, { worldDir: dir, worldQuat: wq.clone(), localQuat: bone.quaternion.clone() });
  }
  return map;
}

/**
 * 동기 이진 탐색 프레임 보간 (Worker 제거 — 0 레이턴시)
 * O(log N) search + O(33) lerp ≈ 0.05ms/frame
 */
function interpLms(frames: CompactFrame[], ts: number): LMData {
  if (!frames.length) return [];
  const t = Math.max(frames[0].t, Math.min(frames[frames.length - 1].t, ts));
  let lo = 0, hi = frames.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (frames[m].t <= t) lo = m; else hi = m; }
  const A = frames[lo], B = frames[hi];
  const a = B.t > A.t ? Math.max(0, Math.min(1, (t - A.t) / (B.t - A.t))) : 0;
  return A.lm.map((la, i) => {
    const lb = B.lm[i] ?? la;
    return [la[0]+(lb[0]-la[0])*a, la[1]+(lb[1]-la[1])*a,
            la[2]+(lb[2]-la[2])*a, la[3]+(lb[3]-la[3])*a];
  });
}

/**
 * MP world lm → Three.js 벡터
 * MP world: x=우(캐릭터 기준), y=아래, z=카메라쪽 양수
 * THREE:     x=우,              y=위,   z=카메라쪽 양수
 * → y만 반전
 */
function lmv(lm: LMData, i: number): THREE.Vector3 {
  const l = lm[i];
  if (!l) return new THREE.Vector3();
  return new THREE.Vector3(l[0], -l[1], l[2]); // y 반전만 (z는 동일 방향)
}

/**
 * 단일 본 Retargeting — 모듈 레벨 temp 재사용으로 GC 0
 *
 *  delta    = fromUnitVectors(restDir, targetDir)
 *  newWorldQ = delta × restWorldQ
 *  localQ   = parentWorldQ⁻¹ × newWorldQ
 */
function retargetBone(bone: THREE.Bone, rest: BoneRest, targetDir: THREE.Vector3): void {
  _va.copy(targetDir).normalize();
  if (_va.lengthSq() < 1e-6) { bone.quaternion.copy(rest.localQuat); return; }
  _vb.copy(rest.worldDir).normalize();
  if (_vb.lengthSq() < 1e-6) { bone.quaternion.copy(rest.localQuat); return; }

  _qa.setFromUnitVectors(_vb, _va);        // delta
  _qb.copy(rest.worldQuat);
  _qa.multiply(_qb);                        // _qa = delta × restWorldQ

  _qc.identity();
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qc);
    _qc.invert();
  }
  _qc.multiply(_qa);                        // localQ = invParent × newWorldQ
  bone.quaternion.copy(_qc).normalize();    // normalize — fp 오차 누적 방지
  bone.scale.setScalar(1);                  // LBS 스트레칭 원천 차단
  bone.updateMatrix();
}

// ── 해부학적 관절 각도 상수 (LBS Candy-Wrapper 아티팩트 원천 차단) ─────────────
// rest pose 기준 최대 회전 — 이 범위 초과 시 rest 방향으로 SLERP 클램프
const JOINT_LIMITS: Record<string, number> = {
  shoulder: 155, // 어깨: 높은 자유도지만 역방향 꺾임 방지
  elbow:    135, // 팔꿈치: 힌지 관절 — 과신전 절대 불가
  hip:      145, // 고관절
  knee:     140, // 무릎: 힌지
  spine:    60,  // 척추: 과도한 비틀림 방지
};

/**
 * 관절 각도 클램프 — rest pose 기준 angular distance를 maxDeg 이내로 제한
 *
 * 원리:
 *   현재 localQ와 restLocalQ 사이의 각도(halfAngle)가 maxDeg/2 초과 시
 *   SLERP(rest, current, limit/halfAngle) 로 당겨 줌
 *
 * 주의: _qa, _qb 를 재사용 — retargetBone 완료 후에만 호출할 것
 */
function clampFromRest(bone: THREE.Bone, rest: BoneRest, maxDeg: number): void {
  const HALF_MAX = (maxDeg * Math.PI) / 360; // half-angle threshold (rad)
  _qa.copy(bone.quaternion).normalize();
  _qb.copy(rest.localQuat).normalize();
  // 최단 호 보장 (부호 통일)
  if (_qa.dot(_qb) < 0) { _qa.x = -_qa.x; _qa.y = -_qa.y; _qa.z = -_qa.z; _qa.w = -_qa.w; }
  const dot = Math.min(1.0, Math.max(-1.0, _qa.dot(_qb)));
  const halfAngle = Math.acos(dot); // 현재 회전 반각
  if (halfAngle > HALF_MAX && halfAngle > 1e-6) {
    // _qb = slerp(rest, current, HALF_MAX/halfAngle) — 한계 각도로 당김
    _qb.slerp(_qa, HALF_MAX / halfAngle);
    bone.quaternion.copy(_qb).normalize();
    bone.scale.setScalar(1); // 클램프 후에도 스케일 보장
    bone.updateMatrix();
  }
}

/** 전체 포즈 적용 — 부모→자식 순서, 관절 각도 클램프 포함 */
function applyPose(lm: LMData, bones: HumanoidBones, rest: Map<BoneKey, BoneRest>): void {
  if (!lm.length) return;

  const ls = lmv(lm, LM.L_SHOULDER), rs = lmv(lm, LM.R_SHOULDER);
  const le = lmv(lm, LM.L_ELBOW),   re = lmv(lm, LM.R_ELBOW);
  const lw = lmv(lm, LM.L_WRIST),   rw = lmv(lm, LM.R_WRIST);
  const lh = lmv(lm, LM.L_HIP),     rh = lmv(lm, LM.R_HIP);
  const lk = lmv(lm, LM.L_KNEE),    rk = lmv(lm, LM.R_KNEE);
  const la = lmv(lm, LM.L_ANKLE),   ra = lmv(lm, LM.R_ANKLE);

  const hipC      = new THREE.Vector3().addVectors(lh, rh).multiplyScalar(0.5);
  const shoulderC = new THREE.Vector3().addVectors(ls, rs).multiplyScalar(0.5);
  const spineDir  = new THREE.Vector3().subVectors(shoulderC, hipC);

  // 척추: 최상단 본 하나에만 + 과비틀림 제한
  const topSpine = (["spine2", "spine1", "spine"] as BoneKey[]).find((k) => bones[k]);
  if (topSpine) {
    const r = rest.get(topSpine);
    if (r) { retargetBone(bones[topSpine]!, r, spineDir); clampFromRest(bones[topSpine]!, r, JOINT_LIMITS.spine); }
  }

  // 팔·다리 — retarget 직후 clamp (부모→자식 순서 필수)
  const apC = (key: BoneKey, dir: THREE.Vector3, limitDeg: number) => {
    const b = bones[key], r = rest.get(key);
    if (!b || !r) return;
    retargetBone(b, r, dir);
    clampFromRest(b, r, limitDeg);
  };

  // ── 팔 (어깨 → 전완 순서) ──────────────────────────────────────────────────
  apC("leftArm",      new THREE.Vector3().subVectors(le, ls), JOINT_LIMITS.shoulder);
  apC("leftForeArm",  new THREE.Vector3().subVectors(lw, le), JOINT_LIMITS.elbow);
  apC("rightArm",     new THREE.Vector3().subVectors(re, rs), JOINT_LIMITS.shoulder);
  apC("rightForeArm", new THREE.Vector3().subVectors(rw, re), JOINT_LIMITS.elbow);

  // ── 다리 (고관절 → 발목 순서) ────────────────────────────────────────────
  apC("leftUpLeg",  new THREE.Vector3().subVectors(lk, lh), JOINT_LIMITS.hip);
  apC("leftLeg",    new THREE.Vector3().subVectors(la, lk), JOINT_LIMITS.knee);
  apC("rightUpLeg", new THREE.Vector3().subVectors(rk, rh), JOINT_LIMITS.hip);
  apC("rightLeg",   new THREE.Vector3().subVectors(ra, rk), JOINT_LIMITS.knee);
}

/** T-pose 리셋 — 쿼터니언 + 스케일 완전 복원 */
function resetTpose(bones: HumanoidBones, rest: Map<BoneKey, BoneRest>): void {
  for (const [key, r] of rest) {
    const b = bones[key as BoneKey];
    if (b) { b.quaternion.copy(r.localQuat); b.scale.setScalar(1); b.updateMatrix(); }
  }
}

/** 시네마틱 3점 조명 */
function setupLighting(scene: THREE.Scene): void {
  scene.children.filter((c) => c.userData.__light).forEach((c) => scene.remove(c));
  const key = new THREE.DirectionalLight(0xfff4e0, 3.2);
  key.position.set(3, 5, 4); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.camera.near = 0.1; key.shadow.camera.far = 20;
  key.userData.__light = true;
  const fill = new THREE.DirectionalLight(0xc8d8ff, 1.0);
  fill.position.set(-4, 2, -2); fill.userData.__light = true;
  const rim = new THREE.DirectionalLight(0xffffff, 1.8);
  rim.position.set(0, 3.5, -6); rim.userData.__light = true;
  const amb = new THREE.HemisphereLight(0x334466, 0x110a00, 0.5);
  amb.userData.__light = true;
  scene.add(key, fill, rim, amb);
}

// ══════════════════════════════════════════════════════════════════════════════
// 컴포넌트
// ══════════════════════════════════════════════════════════════════════════════
export default function CharacterStudio() {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const sceneRef   = useRef<SceneRefs | null>(null);
  const modelRef   = useRef<THREE.Object3D | null>(null);
  const bonesRef   = useRef<HumanoidBones>({});
  const restRef    = useRef<Map<BoneKey, BoneRest>>(new Map());
  const prevLmsRef = useRef<LMData | null>(null);   // EMA 스무딩용

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
  const [boneInfo,    setBoneInfo]    = useState<{ count: number; names: string[] }>({ count: 0, names: [] });
  const [motions,     setMotions]     = useState<MotionSummary[]>([]);
  const [selectedId,  setSelectedId]  = useState("");
  const [poseLoaded,  setPoseLoaded]  = useState(false);
  const [poseInfo,    setPoseInfo]    = useState<string>("");
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordUrl,   setRecordUrl]   = useState<string | null>(null);
  const [camPreset,   setCamPreset]   = useState<CamPreset>("diagonal");
  const [status,      setStatus]      = useState("기본 캐릭터 로드 중…");
  const [dbLoading,   setDbLoading]   = useState(true);

  // ── DB 모션 목록 ──────────────────────────────────────────────────────────
  useEffect(() => {
    getMotionSummaries(50)
      .then((list) => { setMotions(list); if (list[0]) setSelectedId(list[0].id); })
      .catch(() => setStatus("DB 연결 실패"))
      .finally(() => setDbLoading(false));
  }, []);

  // ── Three.js 씬 초기화 (마운트 1회) ───────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
    camera.position.set(...CAM.diagonal.pos);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.05;
    controls.minDistance = 0.2; controls.maxDistance = 100;
    controls.target.set(...CAM.diagonal.tgt); controls.update();

    setupLighting(scene);

    // 바닥
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.name = "floor";
    scene.add(floor);

    // ResizeObserver
    const resizeObs = new ResizeObserver(() => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    });
    resizeObs.observe(canvas);
    renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false);
    camera.aspect = (canvas.clientWidth || 800) / (canvas.clientHeight || 600);
    camera.updateProjectionMatrix();

    // RAF 루프 — 동기 보간 (Worker 불필요)
    const SMOOTH = 0.35; // EMA 계수: 0=무스무딩, 1=동결
    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.update();

      if (playingRef.current && framesRef.current.length > 0) {
        const elapsed  = (performance.now() - startRef.current) / 1000;
        const dur      = durationRef.current;
        const t0       = framesRef.current[0].t;
        const loopT    = dur > 0 ? elapsed % dur : 0;
        const raw      = interpLms(framesRef.current, t0 + loopT);

        // EMA 스무딩
        const prev = prevLmsRef.current;
        const lms = (prev && prev.length === raw.length)
          ? raw.map((l, i) => l.map((v, j) => prev[i][j] + (v - prev[i][j]) * (1 - SMOOTH)))
          : raw;
        prevLmsRef.current = lms;

        applyPose(lms, bonesRef.current, restRef.current);
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
    const s = sceneRef.current; if (!s) return;
    s.camera.position.set(...CAM[camPreset].pos);
    s.controls.target.set(...CAM[camPreset].tgt);
    s.controls.update();
  }, [camPreset]);

  // ── GLB 로드 ─────────────────────────────────────────────────────────────
  const loadGlbUrl = useCallback((url: string, displayName?: string) => {
    const s = sceneRef.current; if (!s) return;
    setStatus("3D 모델 로드 중…");
    playingRef.current = false; setIsPlaying(false); prevLmsRef.current = null;

    // 이전 모델 메모리 해제
    if (modelRef.current) {
      s.scene.remove(modelRef.current);
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
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        const model = gltf.scene;

        // ── 단위 자동 감지 (Mixamo = cm → 0.01 스케일) ─────────────────────
        const rawBox  = new THREE.Box3().setFromObject(model);
        const rawH    = rawBox.max.y - rawBox.min.y;
        const autoScale = rawH > 10 ? 0.01 : rawH < 0.5 ? 2.0 : 1.0;
        model.scale.setScalar(autoScale);

        // ── 스케일 후 바운딩 박스 재계산 ────────────────────────────────────
        model.updateMatrixWorld(true);
        const box  = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const min  = box.min;

        // ── 발바닥 y=0 접지 + X/Z 센터링 ───────────────────────────────────
        model.position.set(-(min.x + size.x / 2), -min.y, -(min.z + size.z / 2));

        model.traverse((obj) => {
          if (obj instanceof THREE.Mesh) { obj.castShadow = true; obj.receiveShadow = true; }
        });

        s.scene.add(model);
        model.updateMatrixWorld(true); // ← T-pose 캡처 전 필수

        // ── 본 감지 ─────────────────────────────────────────────────────────
        const bones  = findBones(model);
        const bKeys  = Object.entries(bones).filter(([, v]) => v).map(([k]) => k);
        bonesRef.current = bones;
        restRef.current  = captureRest(bones);
        modelRef.current = model;
        setBoneInfo({ count: bKeys.length, names: bKeys });

        // ── 카메라: FOV 45° 기준 전신 꽉 차게 ──────────────────────────────
        const fovRad   = (45 * Math.PI) / 180;
        const camDist  = ((size.y / 2) / Math.tan(fovRad / 2)) * 1.3;
        const torsoY   = size.y * 0.52;
        const p = CAM[camPreset];
        const baseLen  = Math.sqrt(p.pos[0]**2 + p.pos[1]**2 + p.pos[2]**2) || 1;
        const ratio    = camDist / baseLen;
        s.camera.position.set(p.pos[0]*ratio, torsoY + p.pos[1]*ratio*0.3, p.pos[2]*ratio);
        s.controls.target.set(0, torsoY, 0);
        s.controls.minDistance = camDist * 0.1;
        s.controls.maxDistance = camDist * 8;
        s.controls.update();

        const name = displayName ?? url.split("/").pop() ?? "model.glb";
        setModelName(name);
        setStatus(
          bKeys.length > 0
            ? `✅ ${name} — ${bKeys.length}개 본 감지됨 (scale ×${autoScale})`
            : `⚠️ ${name} 로드됨 — 본 없음 (Armature 미포함 가능성)`
        );
      },
      undefined,
      (err) => setStatus(`로드 실패: ${err instanceof Error ? err.message : String(err)}`)
    );
  }, [camPreset]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFileDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0]; if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "glb" && ext !== "gltf") { setStatus("GLB / GLTF 파일만 지원됩니다."); return; }
    loadGlbUrl(URL.createObjectURL(file), file.name);
  }, [loadGlbUrl]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (file) loadGlbUrl(URL.createObjectURL(file), file.name);
  }, [loadGlbUrl]);

  // ── 포즈 데이터 로드 (pose_data → motion_data 폴백) ──────────────────────
  const handleLoadPose = useCallback(async () => {
    if (!selectedId) return;
    setStatus("포즈 데이터 로드 중…"); setPoseLoaded(false); prevLmsRef.current = null;
    try {
      let frames: CompactFrame[] = [];
      let duration = 0;
      let source = "";

      // 1차: pose_data 컬럼 시도
      const pd = await getPoseDataById(selectedId);
      if (pd?.frames.length) {
        frames = pd.frames; duration = pd.meta.duration;
        source = `pose_data — ${pd.meta.frameCount}프레임`;
      } else {
        // 2차 폴백: motion_data → CompactFrame 변환
        const row = await getMotionById(selectedId);
        if (row.motion_data?.length) {
          const conv = buildPoseData(row.motion_data);
          frames = conv.frames; duration = conv.meta.duration;
          source = `motion_data(폴백) — ${conv.meta.frameCount}프레임`;
        }
      }

      if (!frames.length) {
        setStatus("❌ 포즈 데이터 없음 — Extract 모드에서 녹화 후 저장하세요."); return;
      }

      framesRef.current   = frames;
      durationRef.current = duration;
      setPoseLoaded(true);
      setPoseInfo(`${source} / ${duration.toFixed(1)}s`);
      setStatus(`✅ 포즈 로드 완료 — ▶ 재생을 눌러 춤을 시작하세요.`);
    } catch (e) {
      setStatus(`포즈 로드 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [selectedId]);

  // ── 재생 ─────────────────────────────────────────────────────────────────
  const handlePlay = useCallback(() => {
    if (!modelRef.current) { setStatus("모델 로드 대기 중입니다."); return; }
    if (!framesRef.current.length) { setStatus("먼저 포즈 데이터를 로드하세요."); return; }
    prevLmsRef.current = null;
    startRef.current   = performance.now();
    playingRef.current = true;
    setIsPlaying(true);
    setStatus("▶ 재생 중… (루프)");
  }, []);

  // ── 정지 → T-pose 리셋 ────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    playingRef.current = false;
    setIsPlaying(false);
    prevLmsRef.current = null;
    resetTpose(bonesRef.current, restRef.current);
    setStatus("■ 정지 — T-pose 복원");
  }, []);

  // ── 녹화 (명시 클릭 시에만 captureStream 활성화) ─────────────────────────
  const handleStartRecord = useCallback(() => {
    const s = sceneRef.current; if (!s) return;
    if (!modelRef.current || !framesRef.current.length) {
      setStatus("모델과 포즈 데이터가 모두 필요합니다."); return;
    }
    if (recordUrl) { URL.revokeObjectURL(recordUrl); setRecordUrl(null); }

    // 재생 시작 (정지 상태라면)
    if (!playingRef.current) {
      prevLmsRef.current = null;
      startRef.current   = performance.now();
      playingRef.current = true;
      setIsPlaying(true);
    }

    // ← 사용자가 명시적으로 클릭한 이후에만 captureStream 실행
    const stream   = s.renderer.domElement.captureStream(60);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9" : "video/webm";
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
    recorderRef.current = rec; chunksRef.current = [];

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

  useEffect(() => () => { if (recordUrl) URL.revokeObjectURL(recordUrl); }, [recordUrl]);

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden bg-[#0a0a0a]">

      {/* ── 좌측 패널 ── */}
      <div className="w-[272px] flex-shrink-0 flex flex-col gap-3 p-4 border-r border-zinc-800 overflow-y-auto">

        <div>
          <h2 className="text-sm font-bold text-zinc-100">🎭 3D 댄스 스튜디오</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">Retargeting → Kling AI 레퍼런스 영상</p>
        </div>

        {/* 상태 */}
        <div className="text-[11px] leading-relaxed bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-400 min-h-[2.8rem]">
          {status}
        </div>

        {/* 본 정보 */}
        {boneInfo.count > 0 && (
          <div className="bg-emerald-950/30 border border-emerald-900/50 rounded-lg px-3 py-2">
            <p className="text-[10px] font-semibold text-emerald-400 mb-1">
              감지된 본 {boneInfo.count}개
            </p>
            <div className="flex flex-wrap gap-1">
              {boneInfo.names.map((n) => (
                <span key={n} className="text-[9px] bg-emerald-900/40 text-emerald-300 px-1.5 py-0.5 rounded">
                  {n}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── 1. 3D 모델 ── */}
        <Sec label="3D 모델">
          <div
            onDrop={handleFileDrop} onDragOver={(e) => e.preventDefault()}
            onClick={() => document.getElementById("cs-file-input")?.click()}
            className="border-2 border-dashed border-zinc-700 hover:border-violet-500 rounded-xl p-3 text-center cursor-pointer transition-colors"
          >
            {modelName
              ? <p className="text-[11px] text-emerald-400 truncate">✅ {modelName}</p>
              : <p className="text-[11px] text-zinc-500">드래그&드롭 또는 클릭<br /><span className="text-[10px] text-zinc-600">Mixamo · ReadyPlayerMe GLB</span></p>
            }
          </div>
          <input id="cs-file-input" type="file" accept=".glb,.gltf" className="hidden" onChange={handleFileInput} />
          <button onClick={() => loadGlbUrl("/character.glb", "character.glb")}
            className="w-full py-1.5 rounded-lg text-[11px] font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors">
            🔄 기본 캐릭터 재로드
          </button>
        </Sec>

        {/* ── 2. 안무 선택 ── */}
        <Sec label="안무 데이터 (DB)">
          {dbLoading
            ? <p className="text-[11px] text-zinc-500 animate-pulse">로드 중…</p>
            : motions.length === 0
              ? <p className="text-[11px] text-amber-400">저장된 모션 없음</p>
              : (
                <>
                  <select value={selectedId}
                    onChange={(e) => { setSelectedId(e.target.value); setPoseLoaded(false); setPoseInfo(""); }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500"
                  >
                    {motions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <button onClick={handleLoadPose} disabled={!selectedId}
                    className="w-full py-1.5 rounded-lg text-xs font-semibold bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white transition-colors">
                    📥 포즈 데이터 로드
                  </button>
                  {poseInfo && (
                    <p className="text-[10px] text-violet-400 leading-relaxed">{poseInfo}</p>
                  )}
                </>
              )
          }
        </Sec>

        {/* ── 3. 카메라 ── */}
        <Sec label="카메라">
          <div className="grid grid-cols-2 gap-1">
            {(["diagonal","front","side","top"] as CamPreset[]).map((p) => (
              <button key={p} onClick={() => setCamPreset(p)}
                className={`py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                  camPreset===p ? "bg-violet-700 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}>
                {{ diagonal:"45°", front:"정면", side:"측면", top:"탑뷰" }[p]}
              </button>
            ))}
          </div>
        </Sec>

        {/* ── 4. 재생 ── */}
        <Sec label="재생 제어">
          {!isPlaying
            ? <button onClick={handlePlay} disabled={!poseLoaded}
                className="w-full py-2 rounded-lg text-sm font-bold bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white transition-colors">
                ▶ 재생 (루프)
              </button>
            : <button onClick={handleStop}
                className="w-full py-2 rounded-lg text-sm font-bold bg-zinc-700 hover:bg-zinc-600 text-white transition-colors">
                ■ 정지 · T-pose 복원
              </button>
          }
        </Sec>

        {/* ── 5. 영상 추출 ── */}
        <div className="mt-auto pt-3 border-t border-zinc-800 flex flex-col gap-2">
          <div className="text-[10px] text-zinc-500 leading-relaxed">
            <span className="text-zinc-400 font-semibold">Kling AI 모션 컨트롤 입력용</span><br />
            블랙 배경 · 12 Mbps · VP9 · 60fps<br />
            <span className="text-amber-500">⚠ 아래 버튼 클릭 시에만 녹화 시작</span>
          </div>
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

        {!modelName && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
            <span className="text-5xl opacity-10">🎭</span>
            <p className="text-sm text-zinc-700">캐릭터 로드 중…</p>
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
