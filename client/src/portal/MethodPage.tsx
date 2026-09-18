import { redirect } from "react-router";
import type { Route } from "./+types/MethodPage";

/**
 * The return method used to be a step of its own between the items and the
 * review. It's asked on the review now, as Loop asks it, so this address only
 * exists for old links and sessions that still point here.
 */
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  throw redirect(`/r/${params.slug}/review`);
}

export default function MethodPage() {
  return null;
}
