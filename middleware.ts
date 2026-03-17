/**
 * middleware.ts — 라우트 보호
 *
 * 미로그인 상태 → /login 리다이렉트
 * 로그인 상태 + /login 접근 → / 리다이렉트
 *
 * 제외 경로: _next/static, _next/image, favicon, /api/*
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const response = NextResponse.next({
    request: { headers: request.headers },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // 세션 갱신 (쿠키 자동 업데이트)
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const isLoginPage = request.nextUrl.pathname.startsWith("/login");

  // 미로그인 → /login으로
  if (!session && !isLoginPage) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // 로그인 상태 + /login 재방문 → /로
  if (session && isLoginPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * _next/static, _next/image, favicon.ico, /api/* 제외
     * 나머지 모든 경로에 적용
     */
    "/((?!_next/static|_next/image|favicon\\.ico|api/).*)",
  ],
};
