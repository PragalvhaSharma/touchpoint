import { NextResponse, type NextRequest } from "next/server";
import { getAuth0 } from "./lib/auth0";
import { fromOutside, validTicket } from "./lib/ticket";

// 1. The tunnel a visitor's phone comes in on only reaches the confirm flow: /confirm, Auth0's /auth/* routes,
//    POST /api/confirm, the page's own assets, and the face photo of the person its QR ticket names. Everything
//    else (the camera, /talk, the people data APIs) answers 404 from outside the booth laptop and local network.
// 2. Mounts Auth0's routes (/auth/login, /auth/callback, /auth/logout, /auth/profile, ...). With no Auth0 keys
//    it does nothing.
const OPEN = [/^\/confirm\/?$/, /^\/auth\//, /^\/_next\//, /^\/favicon\.ico$/];
const ASSET = /^\/(?!api\/)[\w./-]+\.(svg|png|jpe?g|webp|ico|woff2?)$/;

function allowedFromOutside(req: NextRequest): boolean {
  const { pathname, searchParams } = req.nextUrl;
  if (OPEN.some((r) => r.test(pathname)) || ASSET.test(pathname)) return true;
  if (pathname === "/api/confirm" || pathname === "/api/confirm/") return req.method === "POST";
  if (pathname === "/api/greeter/face") return validTicket(searchParams.get("id") ?? "", searchParams.get("t"));
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
