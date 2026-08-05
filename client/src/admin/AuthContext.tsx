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
    setSession({ user: result.user, merchant: result.merchant });
  }, []);

  const logout = useCallback(() => {
    clearToken("admin");
    setSession(null);
  }, []);

  return (
    <AuthContext.Provider value={{ session, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
