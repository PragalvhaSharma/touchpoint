import { NextResponse, type NextRequest } from "next/server";
import { getAuth0 } from "./lib/auth0";
import { fromOutside } from "./lib/ticket";

// 1. The tunnel a phone comes in on only reaches the recruiter's inbox (/recruiter and /api/recruiter, which need
//    a recruiter's Auth0 sign-in), Auth0's /auth/* routes and the page's own assets.
//    Everything else (the camera, /talk, the people data APIs) answers 404 from outside the booth laptop and local network.
// 2. Mounts Auth0's routes (/auth/login, /auth/callback, /auth/logout, /auth/profile, ...). With no Auth0 keys
//    it does nothing.
const OPEN = [/^\/recruiter\/?$/, /^\/api\/recruiter\/?$/, /^\/auth\//, /^\/_next\//, /^\/favicon\.ico$/];
const ASSET = /^\/(?!api\/)[\w./-]+\.(svg|png|jpe?g|webp|ico|woff2?)$/;

function allowedFromOutside(req: NextRequest): boolean {
  const { pathname } = req.nextUrl;
  if (OPEN.some((r) => r.test(pathname)) || ASSET.test(pathname)) return true;
  return false;
}

export async function proxy(request: NextRequest) {
  if (fromOutside(request.headers) && !allowedFromOutside(request)) return new NextResponse("Not found", { status: 404 });
  if (!request.nextUrl.pathname.startsWith("/auth/")) return NextResponse.next();
  const auth0 = getAuth0();
  if (!auth0) return NextResponse.next();
  return auth0.middleware(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
