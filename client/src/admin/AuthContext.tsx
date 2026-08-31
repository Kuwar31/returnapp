import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api, clearToken, getToken, setToken } from "../lib/api";
import type { AdminSession } from "../lib/types";

interface AuthState {
  session: AdminSession | null;
  /** Moves the session to another of this account's stores. */
  switchStore: (merchantId: string) => Promise<void>;
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

  useEffect(() => {
    if (!getToken("admin")) {
      setLoading(false);
      return;
    }
    let active = true;
    api
      .get<AdminSession>("/auth/me", { auth: "admin" })
      .then((data) => active && setSession(data))
      .catch(() => {
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

  /**
   * Swaps the session token for one issued against another store.
   *
   * A full reload afterwards on purpose: every loaded page holds data for the
   * store that was active when it fetched, and patching that in place invites a
   * screen showing one store's returns under another's name.
   */
  const switchStore = useCallback(async (merchantId: string) => {
    const result = await api.post<{ token: string }>(
      "/admin/auth/switch",
      { merchantId },
      { auth: "admin" },
    );
    setToken("admin", result.token);
    window.location.assign("/admin");
  }, []);

  const logout = useCallback(() => {
    clearToken("admin");
    setSession(null);
  }, []);

  return (
    <AuthContext.Provider value={{ session, loading, login, logout, switchStore }}>
      {children}
    </AuthContext.Provider>
  );
}
