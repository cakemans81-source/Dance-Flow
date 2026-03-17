"use client";

/**
 * app/login/page.tsx — 아이디/비밀번호 로그인 (Dummy Domain 방식)
 *
 * 사용자가 입력한 아이디(예: admin)에
 * @dance-app.local을 붙여 admin@dance-app.local 형태로
 * Supabase signInWithPassword에 전달합니다.
 */

import { useState, useTransition } from "react";
import { createClient } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";

const DUMMY_DOMAIN = "@dance-app.local";

// 빌드 타임 env 부재 방지 — 런타임에만 생성
function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim() || !password) return;

    setError(null);

    // Dummy Domain Trick: "admin" → "admin@dance-app.local"
    const email = userId.trim().toLowerCase() + DUMMY_DOMAIN;

    startTransition(async () => {
      const { error: authError } = await getSupabase().auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError("아이디 또는 비밀번호가 올바르지 않습니다.");
        return;
      }

      router.replace("/");
      router.refresh();
    });
  };

  return (
    <div className="h-screen w-screen bg-[#0a0a0a] flex items-center justify-center">
      <div className="w-full max-w-sm px-8 py-10 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl">

        {/* 로고 */}
        <div className="text-center mb-8">
          <div className="text-2xl font-bold text-zinc-100 tracking-tight">
            Dance Flow Studio
          </div>
          <p className="text-xs text-zinc-500 mt-1">내부 관리 도구</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">

          {/* 아이디 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
              아이디
            </label>
            <input
              type="text"
              autoComplete="username"
              autoFocus
              placeholder="아이디를 입력하세요"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={isPending}
              className="bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-violet-500 transition-colors disabled:opacity-50"
            />
          </div>

          {/* 비밀번호 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
              비밀번호
            </label>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="비밀번호를 입력하세요"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isPending}
              className="bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-violet-500 transition-colors disabled:opacity-50"
            />
          </div>

          {/* 에러 메시지 */}
          {error && (
            <p className="text-xs text-red-400 bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {/* 로그인 버튼 */}
          <button
            type="submit"
            disabled={isPending || !userId.trim() || !password}
            className="mt-2 py-2.5 rounded-lg text-sm font-semibold bg-violet-700 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex items-center justify-center gap-2"
          >
            {isPending ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                로그인 중…
              </>
            ) : "로그인"}
          </button>
        </form>
      </div>
    </div>
  );
}
