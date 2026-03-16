import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,

  // ── SharedArrayBuffer 활성화 (FFmpeg.wasm 멀티스레딩 필수) ────────────────
  // COOP: same-origin   → 브라우저 탭 격리, SharedArrayBuffer 허용
  // COEP: credentialless → cross-origin 리소스(MediaPipe CDN 등)를
  //                        자격증명 없이 로드 허용 → 기존 기능 유지
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy",   value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
