/**
 * convertWebmToMp4 — 브라우저 전용 WebM → MP4(H.264) 변환
 *
 * @ffmpeg/ffmpeg v0.12+ 멀티스레드 빌드를 사용.
 * SharedArrayBuffer는 next.config.ts의 COEP/COOP 헤더로 활성화된다.
 *
 * FFmpeg 인스턴스는 모듈 스코프 싱글턴으로 관리:
 *  - 첫 호출 시 CDN에서 core-mt WASM 로드 (~8MB, 이후 캐싱)
 *  - 동시 호출이 오더라도 하나의 Promise로 수렴 (중복 로드 방지)
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
    // @ffmpeg/core-mt v0.12.6 — 멀티스레드 빌드
    // dist/esm/ 경로: ES 모듈 + SharedArrayBuffer worker 포함
    const base = "https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm";
    await ff.load({
      coreURL:   await toBlobURL(`${base}/ffmpeg-core.js`,        "text/javascript"),
      wasmURL:   await toBlobURL(`${base}/ffmpeg-core.wasm`,      "application/wasm"),
      workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`, "text/javascript"),
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
