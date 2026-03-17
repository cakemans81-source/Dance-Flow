/**
 * POST /api/analyze-dance
 *
 * 3장의 JPEG 썸네일(base64)을 받아 Gemini Vision으로 댄스 장르/분위기를 분석한다.
 * 응답: { genre: string, vibe: string }
 */
import { GoogleGenAI, Type } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

const MODEL = "gemini-3.1-flash-lite"; // 경량 고속 모델 (단순 JSON 분석 최적)

const SYSTEM_INSTRUCTION =
  "너는 전 세계의 모든 댄스 장르를 꿰뚫고 있는 전문 안무가야. " +
  "주어진 3장의 연속된 사진을 보고 댄서의 옷차림, 동작의 형태를 분석해.";

const USER_PROMPT =
  "이 사진들은 5초짜리 춤 영상의 흐름이야. " +
  "이 춤의 장르(예: 힙합, Kpop, 틱톡, 스트릿, 팝핑 등)와 " +
  "분위기(예: 파워풀, 그루비, 바운스, 웨이브 등)를 분석해 줘.";

// JSON 응답 스키마 — Gemini가 무조건 이 구조로만 응답하도록 강제
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    genre: { type: Type.STRING, description: "댄스 장르 (한국어 1~2단어)" },
    vibe:  { type: Type.STRING, description: "분위기/감성 (한국어 1~2단어)" },
  },
  required: ["genre", "vibe"],
};

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_API_KEY 환경변수가 설정되지 않았습니다." },
      { status: 500 },
    );
  }

  let images: string[];
  try {
    ({ images } = await req.json());
  } catch {
    return NextResponse.json({ error: "요청 본문 파싱 실패" }, { status: 400 });
  }

  if (!Array.isArray(images) || images.length === 0) {
    return NextResponse.json(
      { error: "images 배열이 비어 있습니다." },
      { status: 400 },
    );
  }

  const ai = new GoogleGenAI({ apiKey });

  // 이미지 파트 + 텍스트 프롬프트를 하나의 user 턴으로 구성
  const imageParts = images.map((b64) => ({
    inlineData: { mimeType: "image/jpeg" as const, data: b64 },
  }));

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
      contents: [
        {
          role: "user",
          parts: [...imageParts, { text: USER_PROMPT }],
        },
      ],
    });

    const raw = response.text ?? "";
    const parsed = JSON.parse(raw) as { genre: string; vibe: string };

    if (!parsed.genre || !parsed.vibe) {
      throw new Error("응답에 genre / vibe 필드가 없습니다.");
    }

    return NextResponse.json(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[analyze-dance] Gemini 호출 실패:", msg);
    return NextResponse.json(
      { error: `Gemini 분석 실패: ${msg}` },
      { status: 502 },
    );
  }
}
