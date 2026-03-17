/**
 * videoUtils — 브라우저 전용 영상 시청각 추출 유틸리티
 */

// ── 내부 헬퍼 ─────────────────────────────────────────────────────────────────

/** video를 특정 시간으로 seek한 뒤 seeked 이벤트가 발생할 때까지 기다린다. */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError  = () => { cleanup(); reject(new Error(`seek 실패 (t=${time.toFixed(2)})`)); };
    const cleanup  = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error",  onError);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error",  onError,  { once: true });
    video.currentTime = time;
  });
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * 영상의 10%~90% 구간을 9등분해 캡처한 뒤,
 * 3×3 격자 콜라주 단 1장(JPEG base64)으로 합성한다.
 *
 * - 셀 크기는 최대 320×180 으로 캡하여 전송 페이로드를 줄인다.
 * - 9번의 seek 은 순차 실행(이전 seek 완료 후 다음 seek).
 */
export async function extractGridThumbnails(video: HTMLVideoElement): Promise<string> {
  if (!video.duration || video.duration === Infinity) {
    throw new Error("영상 메타데이터가 로드되지 않았습니다.");
  }

  const COLS = 3;
  const ROWS = 3;
  const COUNT = COLS * ROWS; // 9

  // 셀 해상도: 원본 비율 유지, 최대 320×180
  const CELL_W = Math.min(video.videoWidth  || 640, 320);
  const CELL_H = Math.min(video.videoHeight || 360, 180);

  const gridCanvas = document.createElement("canvas");
  gridCanvas.width  = CELL_W * COLS; // 960px
  gridCanvas.height = CELL_H * ROWS; // 540px
  const ctx = gridCanvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context를 생성할 수 없습니다.");

  // 임시 캔버스(셀 1장용)
  const cellCanvas = document.createElement("canvas");
  cellCanvas.width  = CELL_W;
  cellCanvas.height = CELL_H;
  const cellCtx = cellCanvas.getContext("2d");
  if (!cellCtx) throw new Error("Cell canvas context 생성 실패.");

  // 10%~90% 를 COUNT 등분
  const ratios = Array.from({ length: COUNT }, (_, i) =>
    0.1 + (0.8 / (COUNT - 1)) * i,
  );

  const savedTime = video.currentTime;

  for (let i = 0; i < COUNT; i++) {
    await seekTo(video, video.duration * ratios[i]);
    cellCtx.drawImage(video, 0, 0, CELL_W, CELL_H);

    const col = i % COLS;
    const row = Math.floor(i / COLS);
    ctx.drawImage(cellCanvas, col * CELL_W, row * CELL_H);
  }

  // 원래 재생 위치 복구
  video.currentTime = savedTime;

  // data URI 접두사 제거 → 순수 base64 반환
  return gridCanvas.toDataURL("image/jpeg", 0.82).split(",")[1];
}

/** 오디오 inlineData 타입 */
export type AudioData = { data: string; mimeType: string };

/**
 * 영상의 20% 지점부터 최대 3초간 오디오를 캡처해 base64로 반환한다.
 *
 * - captureStream() + MediaRecorder: 재생 중 오디오 트랙을 녹음
 * - 캡처 중 video는 음소거(muted)되어 사용자에게 들리지 않음
 * - 오디오 트랙이 없는 영상(캔버스 녹화본 등)은 null 반환
 */
export async function extractAudio(
  video: HTMLVideoElement,
): Promise<AudioData | null> {
  type CaptureVideo = HTMLVideoElement & {
    captureStream?:    () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };

  const stream = (video as CaptureVideo).captureStream?.()
              ?? (video as CaptureVideo).mozCaptureStream?.();

  if (!stream) return null;

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return null;

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  const audioStream = new MediaStream(audioTracks);
  const recorder    = new MediaRecorder(audioStream, { mimeType });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  // 20% 지점으로 seek → 음소거 재생 → 3초 녹음
  const savedTime  = video.currentTime;
  const savedMuted = video.muted;
  video.muted = true;

  await seekTo(video, video.duration * 0.2);

  return new Promise<AudioData | null>((resolve) => {
    recorder.onstop = async () => {
      // 상태 복구
      video.pause();
      video.muted        = savedMuted;
      video.currentTime  = savedTime;

      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size === 0) { resolve(null); return; }

      const buffer = await blob.arrayBuffer();
      const bytes  = new Uint8Array(buffer);

      // Uint8Array → base64 (청크 처리로 스택 오버플로 방지)
      const CHUNK = 8_192;
      let binary  = "";
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      resolve({ data: btoa(binary), mimeType: "audio/webm" });
    };

    recorder.start();
    video.play()
      .then(() => setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 3_000))
      .catch(() => recorder.stop());
  });
}
