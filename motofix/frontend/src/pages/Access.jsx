import { useState } from 'react';
import { LuPlus, LuPencil, LuLock, LuInfo } from 'react-icons/lu';
import { get, post, put, patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Button, Card, Badge, Modal, Field, Empty, Spinner, useLoad, useToast, fmtDate } from '../ui.jsx';

export default function Access() {
  const { can, refresh } = useAuth(); const toast = useToast();
  const [tab, setTab] = useState(can('permissions.manage') ? 'matriz' : 'usuarios');
  const perms = useLoad(() => get('/api/permissions'), []);
  const users = useLoad(() => (can('users.manage') ? get('/api/users') : { users: [] }), []);
  const sup = useLoad(() => (can('users.manage') ? get('/api/suppliers') : { suppliers: [] }), []);
  const [form, setForm] = useState(null);

  const toggle = async (role, permission, granted) => {
    try { await put('/api/permissions', { role, permission, granted }); await Promise.all([perms.reload(), refresh()]); toast(`${granted ? 'Permiso otorgado' : 'Permiso revocado'}: ${permission}`, 'ok'); } catch (e) { toast(e.message, 'err'); }
  };
  const saveUser = async () => {
    try { form.id ? await patch(`/api/users/${form.id}`, { name: form.name, role: form.role, active: form.active, supplier_id: form.role === 'proveedor' ? Number(form.supplier_id) : null, ...(form.password ? { password: form.password } : {}) })
      : await post('/api/users', { ...form, supplier_id: form.role === 'proveedor' ? Number(form.supplier_id) : undefined }); toast('Usuario guardado', 'ok'); setForm(null); users.reload(); } catch (e) { toast(e.message, 'err'); }
  };

  const p = perms.data;
  const groups = p ? [...new Set(p.catalog.map((c) => c.group))] : [];
  const externals = users.data?.users.filter((u) => u.role === 'proveedor' && u.active).length ?? 0;

  return (
    <>
      <div className="page-head"><div><h1>Control de accesos</h1><p>Asigna y revoca permisos por perfil. Los cambios aplican de inmediato, quedan en la bitácora y son vigilados por el Auditor Inteligente.</p></div></div>
      <div className="tabs">{can('permissions.manage') && <button className={`tab ${tab === 'matriz' ? 'on' : ''}`} onClick={() => setTab('matriz')}>Matriz de permisos</button>}{can('users.manage') && <button className={`tab ${tab === 'usuarios' ? 'on' : ''}`} onClick={() => setTab('usuarios')}>Usuarios</button>}</div>

      {tab === 'matriz' && (!p ? <Spinner /> : <>
        <div className="callout" style={{ marginBottom: 14 }}><LuInfo size={16} /><span>Prueba: quita a <b>Recepcionista</b> un permiso, cambia a ese rol con el selector superior y verás el botón o sección bloqueados. Los permisos <LuLock size={12} /> del Administrador están protegidos para evitar bloquear el sistema.</span></div>
        <Card flush><div className="table-wrap"><table className="matrix"><thead><tr><th>Permiso</th>{p.roles.map((r) => <th key={r.key} className="role" title={r.description}>{r.label}</th>)}</tr></thead>
          <tbody>{groups.map((g) => [<tr className="grp" key={g}><td colSpan={p.roles.length + 1}>{g}</td></tr>, ...p.catalog.filter((c) => c.group === g).map((c) => (
            <tr key={c.key}><td>{c.label}<br /><small className="mono muted">{c.key}</small></td>
              {p.roles.map((r) => { const on = p.matrix[r.key].includes(c.key);
                const locked = (r.key === 'admin' && !on === false && p.protected.includes(c.key)) || (r.key === 'proveedor' && c.key !== 'supplier.portal') || (c.key === 'supplier.portal' && !['proveedor', 'admin'].includes(r.key));
                return <td className="cell" key={r.key}><button className={`switch ${on ? 'on' : ''}`} disabled={locked} role="switch" aria-checked={on} aria-label={`${c.label} — ${r.label}`} onClick={() => toggle(r.key, c.key, !on)} /></td>; })}</tr>))])}</tbody></table></div></Card></>)}

      {tab === 'usuarios' && (!users.data ? <Spinner /> : <>
        <div className="toolbar"><Badge tone={externals >= 3 ? 'warn' : 'brand'}>Usuarios externos: {externals} / 3</Badge><Button variant="primary" icon={LuPlus} style={{ marginLeft: 'auto' }} onClick={() => setForm({ name: '', email: '', role: 'recepcionista', password: '', supplier_id: '', active: 1 })}>Nuevo usuario</Button></div>
        <Card flush><div className="table-wrap"><table><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th>Creado</th><th /></tr></thead>
          <tbody>{users.data.users.map((u) => <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}><td><b>{u.name}</b>{u.supplier_name && <><br /><small className="muted">{u.supplier_name}</small></>}</td><td className="mono">{u.email}</td><td><Badge tone={u.role === 'proveedor' ? 'warn' : 'brand'}>{u.roleLabel}</Badge></td><td>{u.active ? <Badge tone="ok">Activo</Badge> : <Badge>Inactivo</Badge>}</td><td className="muted">{fmtDate(u.created_at)}</td>
            <td className="right"><Button size="sm" variant="ghost" icon={LuPencil} aria-label="Editar" onClick={() => setForm({ ...u, password: '' })} /></td></tr>)}</tbody></table></div></Card></>)}

      {form && <Modal title={form.id ? 'Editar usuario' : 'Nuevo usuario'} onClose={() => setForm(null)} footer={<><Button onClick={() => setForm(null)}>Cancelar</Button><Button variant="primary" onClick={saveUser} disabled={!form.name || !form.email || (!form.id && !form.password)}>Guardar</Button></>}>
        <Field label="Nombre completo"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Correo"><input type="email" value={form.email} disabled={!!form.id} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <div className="row"><Field label="Rol"><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{p?.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field>
          {form.role === 'proveedor' && <Field label="Proveedor autorizado"><select value={form.supplier_id || ''} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}><option value="">Selecciona…</option>{sup.data?.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}</div>
        <Field label={form.id ? 'Nueva contraseña (opcional)' : 'Contraseña'} hint="Mínimo 10 caracteres, con letras y números."><input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        {form.id && <label className="chk"><input type="checkbox" checked={!!form.active} onChange={(e) => setForm({ ...form, active: e.target.checked ? 1 : 0 })} /> Cuenta activa</label>}</Modal>}
    </>
  );
}
