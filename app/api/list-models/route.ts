/**
 * GET /api/list-models
 * GOOGLE_API_KEY로 사용 가능한 Gemini 모델 목록을 반환한다.
 * 개발/디버깅용 — 정확한 모델 ID 확인에 사용.
 */
import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GOOGLE_API_KEY 미설정" }, { status: 500 });
  }

  const ai = new GoogleGenAI({ apiKey });

  // ai.models.list()는 Pager 객체를 반환 — page() 또는 직접 fetch
  const pager = await ai.models.list();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const models = (pager as any).page ?? pager ?? [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = Array.from(models).map((m: any) => ({
    name:        m.name,
    displayName: m.displayName,
    description: m.description,
  })).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  return NextResponse.json({ count: result.length, models: result });
}
