import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { get, post, getToken, setToken, setUnauthorizedHandler } from './api.js';

const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null); // { user, permissions, demoMode }
  const [booting, setBooting] = useState(!!getToken());

  const apply = useCallback((data) => { setToken(data.token ?? getToken()); setSession({ user: data.user, permissions: new Set(data.permissions), demoMode: data.demoMode }); }, []);
  const logout = useCallback(async () => { try { await post('/api/auth/logout', {}, { quiet: true }); } catch { /* sesión ya inválida */ } setToken(null); setSession(null); }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { setToken(null); setSession(null); });
    if (!getToken()) return;
    get('/api/auth/me').then((d) => apply(d)).catch(() => setToken(null)).finally(() => setBooting(false));
  }, [apply]);

  const value = useMemo(() => ({
    booting, user: session?.user, demoMode: session?.demoMode, permissions: session?.permissions,
    can: (...ps) => !!session && ps.some((p) => session.permissions.has(p)),
    login: async (email, password) => apply(await post('/api/auth/login', { email, password })),
    demoLogin: async (key) => apply(await post('/api/auth/demo-login', { key })),
    // Refresca permisos vigentes (p. ej. tras editar la matriz de roles)
    refresh: async () => apply(await get('/api/auth/me')),
    logout,
  }), [session, booting, apply, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
