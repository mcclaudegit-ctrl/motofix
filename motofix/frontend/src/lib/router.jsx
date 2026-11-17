import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const Ctx = createContext(null);

export function RouterProvider({ children }) {
  const [path, setPath] = useState(window.location.pathname + window.location.search);
  useEffect(() => {
    const on = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const navigate = useCallback((to, { replace = false } = {}) => {
    if (to === window.location.pathname + window.location.search) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);
  const [pathname, search = ''] = path.split('?');
  return <Ctx.Provider value={{ pathname, query: new URLSearchParams(search), navigate }}>{children}</Ctx.Provider>;
}

export const useRouter = () => useContext(Ctx);

export function Link({ to, children, className, onClick, ...rest }) {
  const { navigate } = useRouter();
  return (
    <a href={to} className={className} {...rest}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); onClick?.(e); navigate(to); }}>
      {children}
    </a>
  );
}

/** Coincide '/facturas/:id' contra una ruta y devuelve los parámetros o null. */
export function matchPath(pattern, pathname) {
  const a = pattern.split('/').filter(Boolean); const b = pathname.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
