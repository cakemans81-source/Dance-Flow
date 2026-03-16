/**
 * convertWebmToMp4 — 브라우저 전용 WebM → MP4(H.264) 변환
 *
 * @ffmpeg/ffmpeg v0.12 + @ffmpeg/core 0.12.6 단일스레드 빌드 사용.
 * SharedArrayBuffer 불필요 → 모든 환경에서 안정적으로 동작.
 * CDN: unpkg.com umd 경로 (ESM 아님 — WASM 경로 차이 있음)
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

// ── 싱글턴 ──────────────────────────────────────────────────────────────────
let _ffmpeg: FFmpeg | null = null;
let _loadPromise: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (_ffmpeg) return _ffmpeg;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const ff = new FFmpeg();
    // @ffmpeg/core v0.12.6 — 단일스레드 빌드 (SharedArrayBuffer 불필요)
    // umd 경로: 브라우저 직접 로드용 번들
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
 * WebM Blob을 받아 MP4(H.264 + AAC) Blob으로 변환한다.
 * - libx264 ultrafast 프리셋 → 빠른 인코딩
 * - yuv420p → 최대 호환성
 * - movflags +faststart → 스트리밍 최적화
 * @param onProgress 진행률 콜백 (0.0 ~ 1.0)
 */
export async function convertWebmToMp4(
  webmBlob: Blob,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const ff = await getFFmpeg();

  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.min(1, Math.max(0, progress)));
  };
  if (onProgress) ff.on("progress", progressHandler);

  try {
  await ff.writeFile("in.webm", await fetchFile(webmBlob));
  await ff.exec([
    "-i",         "in.webm",
    "-c:v",       "libx264",
    "-preset",    "ultrafast",
    "-pix_fmt",   "yuv420p",
    "-c:a",       "aac",
    "-movflags",  "+faststart",
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
