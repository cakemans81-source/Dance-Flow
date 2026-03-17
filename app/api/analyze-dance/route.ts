/**
 * POST /api/analyze-dance
 *
 * 3×3 그리드 이미지(시각) + 오디오 클립(청각)을 받아
 * Gemini Vision으로 댄스를 시청각 통합 분석한다.
 * 응답: { genre, vibe, difficulty, tempo }
 */
import { GoogleGenAI, Type } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

const MODEL = "gemini-3.1-flash-lite-preview"; // 경량 고속 모델

const SYSTEM_INSTRUCTION =
  "너는 세계 최고의 안무가야. " +
  "첨부된 오디오 파일의 비트와 리듬을 '듣고', " +
  "3×3 그리드로 분할된 5초간의 동작 변화를 '봐서' 춤을 분석해 줘. " +
  "댄서의 옷차림, 동작의 형태, 움직임의 복잡도와 속도를 종합적으로 판단해.";

const USER_PROMPT =
  "이 영상은 5초짜리 춤 클립이야. " +
  "오디오에서 비트와 리듬감을 파악하고, 9개 프레임 그리드에서 동작 흐름을 읽어서 " +
  "장르(예: 힙합, Kpop, 틱톡, 스트릿, 팝핑 등), " +
  "분위기(예: 파워풀, 그루비, 바운스, 웨이브 등), " +
  "동작 복잡도 기반 난이도(상/중/하), " +
  "움직임 속도감 기반 템포(빠름/보통/느림)를 분석해 줘.";

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    genre:      { type: Type.STRING, description: "댄스 장르 (한국어 1~2단어)" },
    vibe:       { type: Type.STRING, description: "분위기/감성 (한국어 1~2단어)" },
    difficulty: { type: Type.STRING, description: "난이도: 상 | 중 | 하" },
    tempo:      { type: Type.STRING, description: "템포: 빠름 | 보통 | 느림" },
  },
  required: ["genre", "vibe", "difficulty", "tempo"],
};

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_API_KEY 환경변수가 설정되지 않았습니다." },
      { status: 500 },
    );
  }

  let gridImage: string;
  let audioData: { data: string; mimeType: string } | null;

  try {
    ({ gridImage, audioData } = await req.json());
  } catch {
    return NextResponse.json({ error: "요청 본문 파싱 실패" }, { status: 400 });
  }

  if (!gridImage) {
    return NextResponse.json({ error: "gridImage가 없습니다." }, { status: 400 });
  }

  const ai = new GoogleGenAI({ apiKey });

  // 시각(그리드 이미지) + 청각(오디오, 없으면 생략) + 텍스트 프롬프트
  const parts: object[] = [
    { inlineData: { mimeType: "image/jpeg", data: gridImage } },
    ...(audioData
      ? [{ inlineData: { mimeType: audioData.mimeType, data: audioData.data } }]
      : []),
    { text: USER_PROMPT },
  ];

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
      contents: [{ role: "user", parts }],
    });

    const raw    = response.text ?? "";
    const parsed = JSON.parse(raw) as { genre: string; vibe: string; difficulty: string; tempo: string };

    if (!parsed.genre || !parsed.vibe || !parsed.difficulty || !parsed.tempo) {
      throw new Error("응답 필드 누락: " + JSON.stringify(parsed));
    }

    return NextResponse.json(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[analyze-dance] Gemini 호출 실패:", msg);
    return NextResponse.json({ error: `Gemini 분석 실패: ${msg}` }, { status: 502 });
  }
}
