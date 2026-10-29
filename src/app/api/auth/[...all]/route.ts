import { handleAuthentication } from "@/server/http/authentication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export { handleAuthentication as GET, handleAuthentication as POST, handleAuthentication as PUT, handleAuthentication as PATCH, handleAuthentication as DELETE, handleAuthentication as HEAD, handleAuthentication as OPTIONS };
