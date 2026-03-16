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
 * WebM Blob → MP4(H.264 + AAC) Blob 변환
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

    // -map 0:v:0        → 첫 번째 비디오 스트림만 선택
    // -map 0:a:0?       → 오디오가 있으면 포함, 없어도 에러 없음 (? = optional)
    // -y                → 출력 파일 덮어쓰기 허용
    const exitCode = await ff.exec([
      "-y",
      "-i",        "in.webm",
      "-map",      "0:v:0",
      "-map",      "0:a:0?",
      "-c:v",      "libx264",
      "-preset",   "ultrafast",
      "-pix_fmt",  "yuv420p",
      "-c:a",      "aac",
      "-movflags", "+faststart",
      "out.mp4",
    ]);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg 인코딩 실패 (exit code ${exitCode})`);
    }

    const data = await ff.readFile("out.mp4");

    // SharedArrayBuffer 기반 Uint8Array → 일반 ArrayBuffer로 복사 (Blob 생성 가능)
    const raw = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
    const bytes = new Uint8Array(new ArrayBuffer(raw.byteLength));
    bytes.set(raw);

    if (bytes.byteLength === 0) {
      throw new Error("변환된 파일이 비어 있습니다. 입력 파일을 확인하세요.");
    }

    return new Blob([bytes.buffer], { type: "video/mp4" });
  } finally {
    if (onProgress) ff.off("progress", progressHandler);
    ff.deleteFile("in.webm").catch(() => {});
    ff.deleteFile("out.mp4").catch(() => {});
  }
}
