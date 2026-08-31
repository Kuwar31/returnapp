import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation } from "react-router";
import { ApiError, api, clearToken, getToken, setToken } from "../lib/api";
import type { AdminSession } from "../lib/types";
import { storeFromPath } from "./store-path";

interface AuthState {
  session: AdminSession | null;
  /** True until the stored token has been checked against /auth/me. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export const useAuth = (): AuthState => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [loading, setLoading] = useState(true);
  const { pathname } = useLocation();

  useEffect(() => {
    if (!getToken("admin")) {
      setLoading(false);
      return;
    }
    let active = true;
    api
      .get<AdminSession>("/auth/me", { auth: "admin" })
      .then((data) => active && setSession(data))
      .catch((error: unknown) => {
        /**
         * Only an actually-rejected token ends the session. Clearing it on any
         * failure meant a server hiccup — or, before /auth/* stopped being
         * store-scoped, merely opening a URL for a store you don't belong to —
         * silently signed the merchant out.
         */
        if (error instanceof ApiError && error.status !== 401) return;
        clearToken("admin");
        if (active) setSession(null);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.post<AdminSession & { token: string }>(
      "/auth/login",
      { email, password },
    );
    setToken("admin", result.token);
    setSession({
      user: result.user,
      merchant: result.merchant,
      stores: result.stores,
    });
  }, []);

  const logout = useCallback(() => {
    clearToken("admin");
    setSession(null);
  }, []);

  /**
   * The active store follows the URL, not the other way round.
   *
   * /auth/me answers "who am I" and returns every store this account can reach;
   * which one is on screen is decided by the address bar, so consumers reading
   * `session.merchant` see the store whose data the page actually loaded. An
   * unknown slug leaves the first store in place — AdminLayout redirects it
   * away rather than rendering someone else's figures under the wrong name.
   */
  const scoped = useMemo(() => {
    if (!session) return null;
    const slug = storeFromPath(pathname);
    const match = session.stores?.find((store) => store.slug === slug);
    return match ? { ...session, merchant: match } : session;
  }, [session, pathname]);

  return (
    <AuthContext.Provider value={{ session: scoped, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
