import { Navigate } from "react-router";
import { Loading } from "../components/Feedback";
import { useAuth } from "./AuthContext";
import { storePath } from "./store-path";

/**
 * /admin with no store named. Sends you to one.
 *
 * Kept as its own route rather than folded into the layout because the store
 * has to be chosen before any store-scoped request goes out — every admin call
 * reads the slug off the URL, so landing here and redirecting is what makes
 * bare /admin, an old bookmark, or a sign-in work at all.
 */
export default function AdminIndex() {
  const { session, loading } = useAuth();

  if (loading) return <Loading />;
  if (!session) return <Navigate to="/admin/login" replace />;

  const first = session.stores?.[0]?.slug ?? session.merchant.slug;
  return <Navigate to={storePath(first)} replace />;
}
