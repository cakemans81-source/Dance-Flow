// app/page.tsx — Server Component
// 레이아웃 자체는 서버에서 렌더링하고,
// 클라이언트 상태(poseLandmarks 등)는 StudioClient에 위임한다.

import StudioClient from "@/components/studio/StudioClient";

export default function StudioPage() {
  return <StudioClient />;
}
