"use client";

import { useState, useCallback, useRef } from "react";
import { convertWebmToMp4 } from "@/lib/convertWebmToMp4";

type ConvertStatus = "idle" | "loading" | "converting" | "done" | "error";

export default function VideoConverter() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ConvertStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const acceptFile = useCallback((f: File) => {
    if (!f.name.endsWith(".webm") && f.type !== "video/webm") {
      setErrorMsg("WebM 파일(.webm)만 업로드할 수 있습니다.");
      return;
    }
    setFile(f);
    setStatus("idle");
    setProgress(0);
    setErrorMsg(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) acceptFile(f);
  }, [acceptFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
  }, [acceptFile]);

  const handleConvert = useCallback(async () => {
    if (!file) return;
    setStatus("loading");
    setProgress(0);
    setErrorMsg(null);
    try {
      setStatus("converting");
      const mp4Blob = await convertWebmToMp4(file, (ratio) => {
        setProgress(Math.round(ratio * 100));
      });
      // 자동 다운로드
      const url = URL.createObjectURL(mp4Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name.replace(/\.webm$/i, ".mp4");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus("done");
    } catch (err) {
      console.error("[VideoConverter] 변환 실패:", err);
      // FFmpeg는 string을 throw하기도 함 → String() 으로 안전하게 변환
      const msg = err instanceof Error
        ? (err.message || err.toString())
        : String(err);
      setErrorMsg(msg);
      setStatus("error");
    }
  }, [file]);

  const handleReset = useCallback(() => {
    setFile(null);
    setStatus("idle");
    setProgress(0);
    setErrorMsg(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const isConverting = status === "loading" || status === "converting";

  return (
    <div className="flex flex-col items-center justify-center w-full h-full gap-6 p-8 bg-[#080810]">
      {/* 헤더 */}
      <div className="text-center">
        <h2 className="text-lg font-bold text-zinc-100 tracking-tight">
          WebM → MP4 변환기
        </h2>
        <p className="text-xs text-zinc-500 mt-1">
          녹화된 .webm 파일을 Kling AI에 업로드 가능한 .mp4로 변환
        </p>
      </div>

      {/* 드래그 드롭 영역 */}
      <div
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onClick={() => !isConverting && inputRef.current?.click()}
        className={`
          w-full max-w-sm h-40 rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors select-none
          ${isDragOver
            ? "border-violet-500 bg-violet-950/30"
            : "border-zinc-700 bg-zinc-900/50 hover:border-zinc-500 hover:bg-zinc-900"
          }
          ${isConverting ? "pointer-events-none opacity-50" : ""}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".webm,video/webm"
          className="hidden"
          onChange={handleFileInput}
        />
        {file ? (
          <>
            <span className="text-2xl">🎬</span>
            <span className="text-sm font-medium text-zinc-200 text-center px-4 truncate w-full text-center">
              {file.name}
            </span>
            <span className="text-xs text-zinc-500">
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </span>
          </>
        ) : (
          <>
            <span className="text-2xl">📁</span>
            <span className="text-sm text-zinc-400">
              .webm 파일을 여기에 드래그하거나 클릭
            </span>
          </>
        )}
      </div>

      {/* 진행률 바 */}
      {isConverting && (
        <div className="w-full max-w-sm">
          <div className="flex justify-between text-xs text-zinc-500 mb-1">
            <span>
              {status === "loading"
                ? "FFmpeg 로딩 중... (최초 1회, ~10MB)"
                : "변환 중... (브라우저를 닫지 마세요)"}
            </span>
            {status === "converting" && <span>{progress}%</span>}
          </div>
          <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                status === "loading" ? "bg-zinc-600 animate-pulse w-full" : "bg-violet-600"
              }`}
              style={status === "converting" ? { width: `${progress}%` } : undefined}
            />
          </div>
        </div>
      )}

      {/* 상태 메시지 */}
      {status === "done" && (
        <p className="text-sm text-emerald-400 font-semibold">
          ✅ 변환 완료! MP4 파일이 다운로드되었습니다.
        </p>
      )}
      {status === "error" && errorMsg && (
        <p className="text-sm text-rose-400 text-center max-w-sm">
          ❌ {errorMsg}
        </p>
      )}
      {errorMsg && status === "idle" && (
        <p className="text-sm text-rose-400">{errorMsg}</p>
      )}

      {/* 버튼 */}
      <div className="flex gap-3">
        {file && !isConverting && status !== "done" && (
          <button
            onClick={handleConvert}
            className="px-5 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors"
          >
            🎬 MP4로 변환 시작
          </button>
        )}
        {(file || status === "done" || status === "error") && !isConverting && (
          <button
            onClick={handleReset}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-sm font-medium border border-zinc-700 transition-colors"
          >
            초기화
          </button>
        )}
      </div>
    </div>
  );
}
