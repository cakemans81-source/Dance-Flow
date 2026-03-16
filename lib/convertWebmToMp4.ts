/**
 * convertWebmToMp4 — 브라우저 전용 WebM → MP4(H.264) 변환
 *
 * @ffmpeg/ffmpeg v0.12 + @ffmpeg/core 0.12.6 단일스레드 빌드.
 * 정적 import 대신 동적 import() 사용 →
 *   Next.js/Turbopack이 빌드 타임에 @ffmpeg 내부를 분석하지 않아
 *   "Cannot find module as expression is too dynamic" 오류 방지.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ffmpeg: any = null;
let _loadPromise: Promise<unknown> | null = null;

async function getFFmpeg() {
  if (_ffmpeg) return _ffmpeg;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    // 동적 import → 브라우저 런타임에만 로드, 번들러 정적 분석 대상 제외
    const { FFmpeg }    = await import("@ffmpeg/ffmpeg");
    const { toBlobURL } = await import("@ffmpeg/util");

    const ff = new FFmpeg();

    // ── 상세 로그 (F12 콘솔에서 FFmpeg 내부 동작 추적용) ──────────────────
    ff.on("log", ({ message }: { message: string }) => {
      console.log("[FFmpeg]", message);
    });

    // @ffmpeg/core v0.12.6 단일스레드 — SharedArrayBuffer 불필요
    const base = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
    await ff.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`,   "text/javascript"),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
    });

    _ffmpeg = ff;
    return ff;
  })().finally(() => { _loadPromise = null; });

  return _loadPromise;
}

/**
 * WebM Blob → MP4(H.264, 오디오 없음) Blob 변환
 *
 * MediaRecorder 캔버스 녹화본은 보통 아래 문제를 가짐:
 *   - 가변 프레임레이트(VFR) → libx264가 거부
 *   - yuv420p 이외의 픽셀 포맷
 *   - 오디오 스트림 없음 → aac 인코더 에러
 * → `-r 30`(고정 FPS), `-pix_fmt yuv420p`, `-an`(오디오 제거)으로 해결.
 *
 * @param onProgress 진행률 콜백 (0.0 ~ 1.0)
 */
export async function convertWebmToMp4(
  webmBlob: Blob,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const { fetchFile } = await import("@ffmpeg/util");
  const ff = await getFFmpeg();

  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.min(1, Math.max(0, progress)));
  };
  if (onProgress) ff.on("progress", progressHandler);

  try {
    await ff.writeFile("in.webm", await fetchFile(webmBlob));

    console.log("[FFmpeg] exec 시작 — in.webm 크기:", webmBlob.size, "bytes");

    const exitCode = await ff.exec([
      "-y",                  // 출력 파일 덮어쓰기 허용
      "-i",       "in.webm",
      "-c:v",     "libx264",
      "-preset",  "ultrafast",
      "-r",       "30",      // VFR → CFR 30fps 강제 (libx264 VFR 거부 방지)
      "-pix_fmt", "yuv420p", // 표준 픽셀 포맷 강제 (호환성)
      "-an",                 // 오디오 트랙 없음 (캔버스 녹화본 — 뼈대 영상 전용)
      "out.mp4",
    ]);

    console.log("[FFmpeg] exec 종료 — exit code:", exitCode);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg 인코딩 실패 (exit code ${exitCode}) — F12 콘솔의 [FFmpeg] 로그를 확인하세요.`);
    }

    const data = await ff.readFile("out.mp4");

    // SharedArrayBuffer 기반 Uint8Array → 일반 ArrayBuffer로 복사 (Blob 생성 가능)
    const raw   = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
    const bytes = new Uint8Array(new ArrayBuffer(raw.byteLength));
    bytes.set(raw);

    if (bytes.byteLength === 0) {
      throw new Error("변환된 파일이 비어 있습니다. 입력 파일을 확인하세요.");
    }

    console.log("[FFmpeg] 변환 완료 — out.mp4 크기:", bytes.byteLength, "bytes");
    return new Blob([bytes.buffer], { type: "video/mp4" });
  } finally {
    if (onProgress) ff.off("progress", progressHandler);
    ff.deleteFile("in.webm").catch(() => {});
    ff.deleteFile("out.mp4").catch(() => {});
  }
}
