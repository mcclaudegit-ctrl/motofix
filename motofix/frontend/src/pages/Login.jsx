import { useEffect, useState } from 'react';
import { LuKeyRound, LuSparkles } from 'react-icons/lu';
import { useAuth } from '../lib/auth.jsx';
import { get } from '../lib/api.js';
import { Button, Field } from '../ui.jsx';

export default function Login() {
  const { login, demoLogin } = useAuth();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(null);
  useEffect(() => { get('/api/auth/demo-roles').then(setDemo).catch(() => {}); }, []);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await login(email, password); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const enter = async (key) => { setBusy(true); setError(''); try { await demoLogin(key); } catch (err) { setError(err.message); setBusy(false); } };

  return (
    <div className="login">
      <div className="login-art">
        <div className="gear-bg" aria-hidden="true" />
        <img src="/logo-full.jpg" alt="MotoFix" />
        <p>Facturación, inventario y control de accesos con auditoría inteligente para tu taller.</p>
      </div>
      <div className="login-form">
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>Iniciar sesión</h1>
        <p className="muted" style={{ marginTop: 0 }}>Ingresa con tu cuenta del taller.</p>
        {error && <div className="error-box" role="alert">{error}</div>}
        <form onSubmit={submit}>
          <Field label="Correo electrónico"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" placeholder="nombre@motofix.demo" /></Field>
          <Field label="Contraseña"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></Field>
          <Button variant="primary" icon={LuKeyRound} disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>Entrar</Button>
        </form>
        {demo?.enabled && (
          <div style={{ marginTop: 26 }}>
            <div className="callout"><LuSparkles size={16} /><span><b>Modo demo.</b> Entra directo con un perfil para ver cómo cambia la interfaz según el rol. Contraseña de todas las cuentas: <span className="mono">{demo.password}</span></span></div>
            <div className="role-grid">
              {demo.roles.map((r) => (
                <button key={r.key} className="role-card" onClick={() => enter(r.key)} disabled={busy}>
                  <b>{r.key.startsWith('proveedor') ? `Proveedor ${r.key.slice(-1)}` : r.roleLabel}</b><span>{r.name.split(' (')[0]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
