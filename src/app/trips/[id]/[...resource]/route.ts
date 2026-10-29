import { handleTripHttp } from "@/server/http/trips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
type Context = { params: Promise<{ id: string; resource: string[] }> };
async function handle(request: Request, context: Context) {
  const { id, resource } = await context.params; return handleTripHttp(request, id, resource);
}
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
