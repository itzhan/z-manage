import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // API routes handle their own auth via X-API-Key header
  if (pathname.startsWith('/api/')) return NextResponse.next();

  // Allow login page through
  if (pathname === '/login') return NextResponse.next();

  // Allow static assets and Next.js internals
  if (pathname.startsWith('/_next/') || pathname.startsWith('/favicon')) return NextResponse.next();

  // Check for auth cookie
  const apiKey = req.cookies.get('z-api-key');
  if (!apiKey) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
