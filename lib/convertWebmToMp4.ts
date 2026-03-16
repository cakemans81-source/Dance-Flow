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
    await ff.exec([
      "-i",        "in.webm",
      "-c:v",      "libx264",
      "-preset",   "ultrafast",
      "-pix_fmt",  "yuv420p",
      "-c:a",      "aac",
      "-movflags", "+faststart",
      "out.mp4",
    ]);

    const data = await ff.readFile("out.mp4");

    // Uint8Array<ArrayBufferLike> → plain Uint8Array (SharedArrayBuffer 타입 에러 우회)
    const bytes = data instanceof Uint8Array
      ? Uint8Array.from(data)
      : new TextEncoder().encode(data as string);

    return new Blob([bytes], { type: "video/mp4" });
  } finally {
    if (onProgress) ff.off("progress", progressHandler);
    ff.deleteFile("in.webm").catch(() => {});
    ff.deleteFile("out.mp4").catch(() => {});
  }
}
