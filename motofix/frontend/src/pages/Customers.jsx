import { useState } from 'react';
import { LuPlus, LuSearch, LuPencil } from 'react-icons/lu';
import { get, post, put } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Button, Card, Modal, Field, Empty, Spinner, useLoad, useToast, useDebounced, fmtDate } from '../ui.jsx';

export default function Customers() {
  const { can } = useAuth(); const toast = useToast();
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const { data, loading, reload } = useLoad(() => get(`/api/customers?q=${encodeURIComponent(dq)}`), [dq]);
  const [form, setForm] = useState(null);
  const save = async () => {
    try { form.id ? await put(`/api/customers/${form.id}`, form) : await post('/api/customers', form); toast('Cliente guardado', 'ok'); setForm(null); reload(); } catch (e) { toast(e.message, 'err'); }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <div className="page-head"><div><h1>Clientes</h1><p>Registro de clientes del taller.</p></div>
        {can('customers.manage') && <Button variant="primary" icon={LuPlus} onClick={() => setForm({ name: '', id_number: '', phone: '', email: '' })}>Nuevo cliente</Button>}</div>
      <div className="toolbar"><div className="search"><LuSearch /><input placeholder="Buscar por nombre, cédula o teléfono" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" /></div></div>
      <Card flush>{loading && !data ? <Spinner /> : data.customers.length === 0 ? <Empty>Sin resultados.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Nombre</th><th>Cédula</th><th>Teléfono</th><th>Correo</th><th>Registrado</th><th /></tr></thead>
          <tbody>{data.customers.map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td className="mono">{c.id_number || '—'}</td><td>{c.phone || '—'}</td><td>{c.email || '—'}</td><td className="muted">{fmtDate(c.created_at)}</td>
            <td className="right">{can('customers.manage') && <Button size="sm" variant="ghost" icon={LuPencil} aria-label="Editar" onClick={() => setForm({ ...c })} />}</td></tr>)}</tbody></table></div>)}</Card>
      {form && <Modal title={form.id ? 'Editar cliente' : 'Nuevo cliente'} onClose={() => setForm(null)} footer={<><Button onClick={() => setForm(null)}>Cancelar</Button><Button variant="primary" disabled={!form.name} onClick={save}>Guardar</Button></>}>
        <Field label="Nombre completo *"><input value={form.name} onChange={set('name')} /></Field>
        <div className="row"><Field label="Cédula"><input value={form.id_number || ''} onChange={set('id_number')} /></Field><Field label="Teléfono"><input value={form.phone || ''} onChange={set('phone')} /></Field></div>
        <Field label="Correo"><input type="email" value={form.email || ''} onChange={set('email')} /></Field></Modal>}
    </>
  );
}
