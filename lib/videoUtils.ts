/**
 * videoUtils — 브라우저 전용 영상 유틸리티
 */

/**
 * video 엘리먼트의 특정 시간 지점으로 seek 후 canvas 스냅샷을 반환.
 * 반환값은 data URI 접두사 없는 순수 base64 JPEG 문자열.
 */
function captureFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  time: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // "data:image/jpeg;base64," 접두사 제거 → 순수 base64만 반환
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    const onError = (e: Event) => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error(`seek 실패 (time=${time}): ${(e as ErrorEvent).message ?? e.type}`));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = time;
  });
}

/**
 * 영상의 10% / 50% / 90% 지점에서 JPEG 썸네일을 추출한다.
 *
 * @param video  대상 HTMLVideoElement (readyState >= HAVE_METADATA 필요)
 * @param count  추출할 프레임 수 (기본 3)
 * @returns      순수 base64 JPEG 문자열 배열
 */
export async function extractThumbnails(
  video: HTMLVideoElement,
  count = 3,
): Promise<string[]> {
  if (!video.duration || video.duration === Infinity) {
    throw new Error("영상 메타데이터가 로드되지 않았습니다.");
  }

  // 캔버스를 한 번만 생성해 재사용
  const canvas = document.createElement("canvas");
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 360;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context를 생성할 수 없습니다.");

  // 균등 분할 지점: count=3 → [0.1, 0.5, 0.9]
  const ratios = Array.from({ length: count }, (_, i) =>
    0.1 + (0.8 / (count - 1)) * i,
  );

  const base64Frames: string[] = [];
  for (const ratio of ratios) {
    const t = video.duration * ratio;
    base64Frames.push(await captureFrame(video, canvas, ctx, t));
  }

  return base64Frames;
}
