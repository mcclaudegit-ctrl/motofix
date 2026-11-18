import { useState } from 'react';
import { LuCheck, LuX, LuPencil, LuUpload, LuPlay, LuDownload, LuRefreshCw, LuPlus, LuTriangleAlert, LuShieldCheck } from 'react-icons/lu';
import { get, post, put, patch, download, getToken } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link, useRouter } from '../lib/router.jsx';
import { Button, Card, Badge, Modal, Field, Empty, Spinner, Kpi, useLoad, useToast, useDebounced, crc, fmtDate, ago } from '../ui.jsx';

const RISK = { alto: ['danger', 'Riesgo alto'], medio: ['warn', 'Riesgo medio'], bajo: ['ok', 'Riesgo bajo'] };
const CXP_STATUS = { en_revision: ['warn', 'En revisión'], aprobada_parcial: ['brand', 'Aprobada 1/2'], aprobada: ['ok', 'Aprobada'], rechazada: ['danger', 'Rechazada'] };
const CATEGORIES = ['Gastos operativos', 'Compras de inventario', 'Pagos a proveedores', 'Activos fijos'];
const SOURCES = { xml: 'XML', pdf: 'PDF', manual: 'Manual', correo: 'Correo', importado: 'Importación' };
const fmtTax = (d) => (d && d.length === 10 ? `${d[0]}-${d.slice(1, 4)}-${d.slice(4)}` : d || '—');

export const RiskBadge = ({ level, score }) => <Badge tone={RISK[level]?.[0]}>{RISK[level]?.[1] || level}{score != null ? ` · ${score}` : ''}</Badge>;
export const CxpStatus = ({ status }) => <Badge tone={CXP_STATUS[status]?.[0]}>{CXP_STATUS[status]?.[1] || status}</Badge>;

async function sendRaw(url, file) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', Authorization: `Bearer ${getToken()}` }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || 'No se pudo procesar el archivo'), { data, status: res.status });
  return data;
}

// Vercel acepta como máximo 4,5 MB por solicitud: los archivos más grandes se envían en partes de 3 MB
// y el servidor las vuelve a unir (hasta 20 MB en total).
const CHUNK = 3 * 1024 * 1024;
const MAX_IMPORT = 20 * 1024 * 1024;
async function uploadForImport(file, onProgress) {
  const name = encodeURIComponent(file.name);
  if (file.size > MAX_IMPORT) throw new Error('El archivo supera 20 MB');
  if (file.size <= CHUNK) return sendRaw(`/api/ap/import/inspect?name=${name}`, file);
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const total = Math.ceil(file.size / CHUNK);
  let out = null;
  for (let part = 0; part < total; part++) {
    onProgress?.(part, total);
    const blob = file.slice(part * CHUNK, (part + 1) * CHUNK, 'application/octet-stream');
    out = await sendRaw(`/api/ap/import/chunk?upload=${id}&part=${part}&total=${total}&name=${name}`, blob);
  }
  onProgress?.(total, total);
  return out;
}

const Head = ({ title, text, actions }) => (
  <div className="page-head"><div><h1>{title}</h1><p>{text}</p></div>{actions && <div className="actions">{actions}</div>}</div>
);
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 };

// ---------- Panel ----------
export default function CxpDashboard() {
  const { data, loading } = useLoad(() => get('/api/ap/dashboard'), [], { poll: 20000 });
  const { can } = useAuth(); const { navigate } = useRouter();
  if (loading && !data) return <Spinner />;
  const k = data.kpis; const maxAmt = Math.max(1, ...Object.values(data.by_level).map((l) => l.amount));
  const maxWeek = Math.max(1, ...data.trend.map((t) => t.amount));
  return (
    <>
      <Head title="Cuentas por pagar · Panel de riesgo" text="Facturas clasificadas por nivel de riesgo para que el auditor concentre su esfuerzo en los hallazgos críticos."
        actions={<>{can('ap.simulate') && <Link to="/cxp/bandeja" className="btn">Bandeja de correo</Link>}<Link to="/cxp/reportes" className="btn dark">Reportes</Link></>} />
      <div style={{ ...grid, marginBottom: 18 }}>
        <Kpi label="Facturas abiertas" value={k.abiertas} sub={`${k.facturas} registradas en total`} />
        <Kpi label="Monto abierto" value={crc(k.monto_abierto)} sub="Pendiente de aprobación" />
        <Kpi label="Riesgo alto abierto" value={k.alto_abiertas} sub="Requieren atención del auditor" alert={k.alto_abiertas > 0} />
        <Kpi label="Revisión pendiente" value={k.revision_pendiente} sub="Datos por confirmar" />
        <Kpi label="Procesadas por XML" value={`${k.automatizadas_pct}%`} sub="Sin intervención humana" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px,1fr) minmax(300px,2fr)', gap: 18, alignItems: 'start' }}>
        <Card title="Niveles de riesgo (abiertas)">
          {['alto', 'medio', 'bajo'].map((l) => (
            <div key={l} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                <RiskBadge level={l} /><span className="num">{data.by_level[l].count} · {crc(data.by_level[l].amount)}</span>
              </div>
              <div style={{ height: 10, background: 'var(--line, #e5e9ec)', borderRadius: 6 }}>
                <div style={{ width: `${(data.by_level[l].amount / maxAmt) * 100}%`, height: '100%', borderRadius: 6,
                  background: l === 'alto' ? '#c0392b' : l === 'medio' ? '#e08e0b' : 'var(--brand)' }} />
              </div>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Límite de aprobación de segundo nivel: {crc(data.settings.limite_aprobacion)}</div>
        </Card>
        <Card title="Facturas por semana (últimas 8)">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 150 }}>
            {data.trend.map((t) => (
              <div key={t.week} style={{ flex: 1, textAlign: 'center' }} title={`${t.count} factura(s) · ${crc(t.amount)}`}>
                <div style={{ height: `${Math.max(3, (t.amount / maxWeek) * 120)}px`, background: 'var(--brand)', borderRadius: '4px 4px 0 0', opacity: t.count ? 1 : 0.25 }} />
                <small className="muted" style={{ fontSize: 10 }}>{t.week.slice(5)}</small>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px,3fr) minmax(260px,2fr)', gap: 18, marginTop: 18, alignItems: 'start' }}>
        <Card title="Facturas críticas" flush>
          {data.critical.length === 0 ? <Empty>No hay facturas de riesgo alto abiertas.</Empty> : (
            <div className="table-wrap"><table><thead><tr><th>Factura</th><th>Proveedor</th><th>Monto</th><th>Motivo principal</th></tr></thead>
              <tbody>{data.critical.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/cxp/facturas/${c.id}`)}>
                  <td className="mono"><b>{c.invoice_number || 's/n'}</b><br /><RiskBadge level="alto" score={c.risk_score} /></td>
                  <td>{c.vendor_name || '—'}</td><td className="num">{crc(c.total_crc)}</td>
                  <td style={{ maxWidth: 300, fontSize: 12 }}>{c.findings[0]?.label || '—'}</td>
                </tr>))}</tbody></table></div>)}
        </Card>
        <Card title="Reglas que más se activan">
          {data.top_rules.length === 0 ? <Empty>Sin hallazgos abiertos.</Empty> : data.top_rules.map((r) => (
            <div key={r.rule} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line, #e5e9ec)', fontSize: 13 }}>
              <span>{r.label}</span><b className="num">{r.count}</b>
            </div>))}
        </Card>
      </div>
      <Card title="Actividad reciente de la bandeja" className="" flush>
        {data.inbox.length === 0 ? <Empty>Sin correos registrados.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Cuándo</th><th>Remitente</th><th>Asunto</th><th>Resultado</th></tr></thead>
            <tbody>{data.inbox.map((m) => <tr key={m.id}><td>{ago(m.received_at)}</td><td className="mono">{m.counterpart}</td><td>{m.subject}</td><td style={{ maxWidth: 380, fontSize: 12 }}>{m.outcome}</td></tr>)}</tbody></table></div>)}
      </Card>
    </>
  );
}

// ---------- Listado ----------
export function CxpInvoices() {
  const [status, setStatus] = useState('abiertas'); const [risk, setRisk] = useState(''); const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const qs = new URLSearchParams({ ...(status && { status }), ...(risk && { risk }), ...(dq && { q: dq }), limit: 200 }).toString();
  const { data, loading } = useLoad(() => get(`/api/ap/invoices?${qs}`), [qs], { poll: 20000 });
  const { navigate } = useRouter(); const { can } = useAuth();
  return (
    <>
      <Head title="Facturas por pagar" text="Todas las facturas registradas por correo, XML, PDF, captura manual o importación."
        actions={can('ap.simulate') && <Link to="/cxp/facturas/nueva" className="btn primary"><LuPlus /> Registrar factura</Link>} />
      <div className="toolbar" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
          <option value="abiertas">Abiertas</option><option value="en_revision">En revisión</option><option value="aprobada_parcial">Aprobada 1/2</option>
          <option value="aprobada">Aprobadas</option><option value="rechazada">Rechazadas</option><option value="">Todas</option>
        </select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)} aria-label="Riesgo">
          <option value="">Todo riesgo</option><option value="alto">Alto</option><option value="medio">Medio</option><option value="bajo">Bajo</option>
        </select>
        <input placeholder="Buscar proveedor o factura" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
      </div>
      <Card flush>
        {loading && !data ? <Spinner /> : data.invoices.length === 0 ? <Empty>No hay facturas con esos filtros.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Factura</th><th>Proveedor</th><th>Fecha</th><th>Total CRC</th><th>Origen</th><th>Riesgo</th><th>Estado</th></tr></thead>
            <tbody>{data.invoices.map((i) => (
              <tr key={i.id} className="clickable" onClick={() => navigate(`/cxp/facturas/${i.id}`)}>
                <td className="mono"><b>{i.invoice_number || 'sin número'}</b></td>
                <td>{i.vendor_name || '—'}<br /><small className="muted mono">{fmtTax(i.vendor_tax_id)}</small></td>
                <td>{fmtDate(i.issue_date)}</td><td className="num">{crc(i.total_crc)}</td>
                <td><Badge>{SOURCES[i.source] || i.source}</Badge></td>
                <td><RiskBadge level={i.risk_level} score={i.risk_score} /></td>
                <td><CxpStatus status={i.status} />{i.needs_human_review ? <><br /><small style={{ color: '#b45309' }}>Requiere revisión</small></> : null}</td>
              </tr>))}</tbody></table></div>)}
      </Card>
      {data && <small className="muted">{data.total} resultado(s)</small>}
    </>
  );
}

// ---------- Registro manual o PDF ----------
export function CxpNew() {
  const toast = useToast(); const { navigate } = useRouter();
  const [f, setF] = useState({ vendor_name: '', tax_id: '', invoice_number: '', issue_date: '', currency: 'CRC', subtotal: '', tax: '', total: '', category: 'Gastos operativos', bank_account: '', description: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try { const r = await post('/api/ap/invoices', f); toast('Factura registrada y analizada', 'ok'); navigate(`/cxp/facturas/${r.invoice.id}`); }
    catch (err) { toast(err.message, 'err'); } finally { setBusy(false); }
  };
  const pdf = async (e) => {
    const file = e.target.files?.[0]; if (!file) return; setBusy(true);
    try { const r = await sendRaw(`/api/ap/invoices/pdf?name=${encodeURIComponent(file.name)}`, file); toast('PDF leído. Revisa los datos antes de aprobar.', 'ok'); navigate(`/cxp/facturas/${r.invoice.id}`); }
    catch (err) { toast(err.message, 'err'); } finally { setBusy(false); e.target.value = ''; }
  };
  return (
    <>
      <Head title="Registrar factura" text="Captura manual o lectura de PDF. Los datos se estandarizan automáticamente y cada corrección queda en la bitácora." />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px,2fr) minmax(260px,1fr)', gap: 18, alignItems: 'start' }}>
        <Card title="Captura manual">
          <form onSubmit={submit} style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
            <Field label="Proveedor *"><input required value={f.vendor_name} onChange={set('vendor_name')} /></Field>
            <Field label="Cédula" hint="Solo dígitos o con guiones; se estandariza"><input value={f.tax_id} onChange={set('tax_id')} /></Field>
            <Field label="Número de factura *"><input required value={f.invoice_number} onChange={set('invoice_number')} /></Field>
            <Field label="Fecha de emisión *"><input type="date" required value={f.issue_date} onChange={set('issue_date')} /></Field>
            <Field label="Moneda"><select value={f.currency} onChange={set('currency')}><option value="CRC">Colones (₡)</option><option value="USD">Dólares ($)</option></select></Field>
            <Field label="Categoría"><select value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Subtotal" hint="Si lo dejas vacío se calcula desde el total"><input value={f.subtotal} onChange={set('subtotal')} /></Field>
            <Field label="IVA"><input value={f.tax} onChange={set('tax')} /></Field>
            <Field label="Total *"><input required value={f.total} onChange={set('total')} /></Field>
            <Field label="Cuenta bancaria"><input value={f.bank_account} onChange={set('bank_account')} /></Field>
            <Field label="Descripción"><input value={f.description} onChange={set('description')} /></Field>
            <div style={{ gridColumn: '1 / -1' }}><Button type="submit" variant="primary" icon={LuCheck} disabled={busy}>Registrar y analizar</Button></div>
          </form>
        </Card>
        <Card title="Leer factura en PDF">
          <p className="muted" style={{ fontSize: 13 }}>Un proveedor de IA gratuito extrae los campos del PDF. Toda factura leída así requiere revisión humana antes de aprobarse.</p>
          <label className="btn" style={{ cursor: 'pointer' }}><LuUpload /> Elegir PDF<input type="file" accept="application/pdf" onChange={pdf} hidden disabled={busy} /></label>
        </Card>
      </div>
    </>
  );
}

// ---------- Detalle ----------
export function CxpDetail({ params }) {
  const id = Number(params.id); const toast = useToast(); const { can } = useAuth();
  const { data, loading, reload } = useLoad(() => get(`/api/ap/invoices/${id}`), [id], { poll: 20000 });
  const [dlg, setDlg] = useState(null);
  if (loading && !data) return <Spinner />;
  if (!data) return <Empty>Factura no encontrada.</Empty>;
  const open = data.status === 'en_revision' || data.status === 'aprobada_parcial';
  const needPerm = data.approval_perm_needed;
  const canApprove = open && needPerm && can(needPerm) && !data.needs_human_review;
  const act = async (fn, msg) => { try { await fn(); toast(msg, 'ok'); setDlg(null); reload(); } catch (e) { toast(e.message, 'err'); } };

  return (
    <>
      <Head title={`Factura ${data.invoice_number || 'sin número'}`} text={`${data.vendor_name || 'Proveedor sin nombre'} · ${fmtDate(data.issue_date)} · origen ${SOURCES[data.source] || data.source}`}
        actions={<><CxpStatus status={data.status} /><RiskBadge level={data.risk_level} score={data.risk_score} /></>} />
      {data.needs_human_review ? (
        <div className="error-box" style={{ marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
          <LuTriangleAlert /><span>Requiere revisión humana: corrige o confirma los datos antes de aprobar.</span>
        </div>) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px,3fr) minmax(280px,2fr)', gap: 18, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 18 }}>
          <Card title="Datos estandarizados" actions={can('ap.review') && open && <Button size="sm" icon={LuPencil} onClick={() => setDlg({ kind: 'edit', f: { invoice_number: data.invoice_number, issue_date: data.issue_date, vendor_name: data.vendor_name, vendor_tax_id: data.vendor_tax_id || '', currency: data.currency, subtotal: data.subtotal, tax: data.tax, total: data.total, category: data.category, bank_account: data.bank_account || '', description: data.description || '' }, confirm: false })}>Corregir</Button>}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12, fontSize: 14 }}>
              <div><small className="muted">Proveedor</small><br /><b>{data.vendor_name || '—'}</b>{data.vendor ? <><br /><small style={{ color: '#2e7d32' }}>En el maestro</small></> : <><br /><small style={{ color: '#b45309' }}>No registrado</small></>}</div>
              <div><small className="muted">Cédula</small><br /><span className="mono">{fmtTax(data.vendor_tax_id)}</span></div>
              <div><small className="muted">Número</small><br /><span className="mono">{data.invoice_number || '—'}</span></div>
              <div><small className="muted">Fecha</small><br />{fmtDate(data.issue_date)}</div>
              <div><small className="muted">Subtotal / IVA</small><br />{crc(data.subtotal)} / {crc(data.tax)}</div>
              <div><small className="muted">Total</small><br /><b className="num">{data.currency} {Number(data.total).toLocaleString('es-CR')}</b>{data.currency === 'USD' && <><br /><small className="muted">≈ {crc(data.total_crc)} al tipo de cambio</small></>}</div>
              <div><small className="muted">Categoría</small><br />{data.category}</div>
              <div><small className="muted">Cuenta bancaria</small><br /><span className="mono" style={{ fontSize: 12 }}>{data.bank_account || '—'}</span></div>
            </div>
          </Card>

          <Card title={`Hallazgos (${data.findings.length})`} flush>
            {data.findings.length === 0 ? <Empty><LuShieldCheck /> Sin hallazgos: la factura cumple todas las pruebas.</Empty> : (
              <div className="table-wrap"><table><thead><tr><th>Prueba</th><th>Detalle</th><th>Peso</th></tr></thead>
                <tbody>{data.findings.map((f) => <tr key={f.rule}><td><b style={{ fontSize: 13 }}>{f.label}</b><br /><small className="muted mono">{f.rule}</small></td><td style={{ fontSize: 13 }}>{f.detail}</td><td className="num">+{f.weight}</td></tr>)}</tbody></table></div>)}
          </Card>

          <Card title="Bitácora de limpieza" flush>
            {data.cleaning_log.length === 0 ? <Empty>No se hicieron cambios a los datos recibidos.</Empty> : (
              <div className="table-wrap"><table><thead><tr><th>Campo</th><th>Antes</th><th>Después</th></tr></thead>
                <tbody>{data.cleaning_log.map((l, i) => <tr key={i}><td>{l.field}</td><td className="mono" style={{ fontSize: 12 }}>{l.from || '∅'}</td><td className="mono" style={{ fontSize: 12 }}>{l.to || '∅'}</td></tr>)}</tbody></table></div>)}
          </Card>
        </div>

        <div style={{ display: 'grid', gap: 18 }}>
          <Card title="Aprobación">
            <p style={{ fontSize: 13, marginTop: 0 }}>
              Límite de segundo nivel: {crc(data.settings.limite_aprobacion)}. Esta factura requiere <b>{data.required_approvals}</b> aprobación(es).
            </p>
            {data.approvers.map((a, i) => <div key={a.id} style={{ fontSize: 13, marginBottom: 6 }}><LuCheck /> Nivel {i + 1}: <b>{a.name}</b> <small className="muted">({a.role})</small></div>)}
            {data.creator && <small className="muted">Registró: {data.creator.name}. Nadie aprueba lo que registró.</small>}
            {data.status === 'rechazada' && <div className="error-box" style={{ marginTop: 10 }}>Rechazada: {data.reject_reason}</div>}
            {open && (
              <div className="actions" style={{ marginTop: 14, flexWrap: 'wrap' }}>
                {needPerm && can(needPerm) ? (
                  <Button variant="primary" icon={LuCheck} disabled={!canApprove} onClick={() => setDlg({ kind: 'approve', note: '' })} title={data.needs_human_review ? 'Corrige y confirma los datos primero' : ''}>Aprobar</Button>
                ) : <Button locked>Aprobar</Button>}
                {needPerm && can(needPerm) && <Button variant="danger" icon={LuX} onClick={() => setDlg({ kind: 'reject', note: '' })}>Rechazar</Button>}
              </div>)}
            {open && data.risk_level === 'alto' && <small className="muted" style={{ display: 'block', marginTop: 8 }}>Riesgo alto: la aprobación exige justificación escrita.</small>}
          </Card>
          <Card title="Movimientos" flush>
            {data.audit.length === 0 ? <Empty>Sin movimientos.</Empty> : (
              <div className="table-wrap"><table><tbody>{data.audit.map((a, i) => <tr key={i}><td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(a.ts, true)}</td><td style={{ fontSize: 12 }}><b>{a.action}</b><br />{a.user_name || 'Sistema'} · {a.detail}</td></tr>)}</tbody></table></div>)}
          </Card>
        </div>
      </div>

      {dlg?.kind === 'approve' && (
        <Modal title={`Aprobar ${data.invoice_number || 'factura'} · nivel ${data.approvers.length + 1}`} onClose={() => setDlg(null)}
          footer={<><Button onClick={() => setDlg(null)}>Cancelar</Button><Button variant="primary" disabled={data.risk_level === 'alto' && dlg.note.trim().length < 10}
            onClick={() => act(() => post(`/api/ap/invoices/${id}/approve`, { note: dlg.note }), 'Factura aprobada')}>Confirmar aprobación</Button></>}>
          <p className="muted">Monto {crc(data.total_crc)}. {data.risk_level === 'alto' ? 'Por riesgo alto, escribe la justificación (mínimo 10 caracteres).' : 'La nota es opcional.'}</p>
          <Field label={data.risk_level === 'alto' ? 'Justificación *' : 'Nota'}><textarea rows={3} value={dlg.note} onChange={(e) => setDlg({ ...dlg, note: e.target.value })} /></Field>
        </Modal>)}
      {dlg?.kind === 'reject' && (
        <Modal title="Rechazar factura" onClose={() => setDlg(null)}
          footer={<><Button onClick={() => setDlg(null)}>Cancelar</Button><Button variant="danger" disabled={dlg.note.trim().length < 5}
            onClick={() => act(() => post(`/api/ap/invoices/${id}/reject`, { reason: dlg.note }), 'Factura rechazada')}>Rechazar</Button></>}>
          <Field label="Motivo *"><textarea rows={3} value={dlg.note} onChange={(e) => setDlg({ ...dlg, note: e.target.value })} /></Field>
        </Modal>)}
      {dlg?.kind === 'edit' && (
        <Modal title="Corregir datos" wide onClose={() => setDlg(null)}
          footer={<><Button onClick={() => setDlg(null)}>Cancelar</Button><Button onClick={() => act(() => patch(`/api/ap/invoices/${id}`, { ...dlg.f, confirm: dlg.confirm }), dlg.confirm ? 'Datos confirmados' : 'Correcciones guardadas')}>Guardar</Button></>}>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            {[['vendor_name', 'Proveedor'], ['vendor_tax_id', 'Cédula'], ['invoice_number', 'Número'], ['issue_date', 'Fecha (AAAA-MM-DD)'], ['subtotal', 'Subtotal'], ['tax', 'IVA'], ['total', 'Total'], ['bank_account', 'Cuenta bancaria'], ['description', 'Descripción']].map(([k, label]) => (
              <Field key={k} label={label}><input value={dlg.f[k] ?? ''} onChange={(e) => setDlg({ ...dlg, f: { ...dlg.f, [k]: e.target.value } })} /></Field>))}
            <Field label="Moneda"><select value={dlg.f.currency} onChange={(e) => setDlg({ ...dlg, f: { ...dlg.f, currency: e.target.value } })}><option value="CRC">CRC</option><option value="USD">USD</option></select></Field>
            <Field label="Categoría"><select value={dlg.f.category} onChange={(e) => setDlg({ ...dlg, f: { ...dlg.f, category: e.target.value } })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, fontSize: 14 }}>
            <input type="checkbox" checked={dlg.confirm} onChange={(e) => setDlg({ ...dlg, confirm: e.target.checked })} /> Confirmo que los datos son correctos (permite aprobar)
          </label>
        </Modal>)}
    </>
  );
}

// ---------- Bandeja simulada ----------
export function CxpInbox() {
  const { can } = useAuth(); const toast = useToast();
  const { data, loading, reload } = useLoad(() => get('/api/ap/inbox'), [], { poll: 15000 });
  const [busy, setBusy] = useState(null); const [last, setLast] = useState(null);
  const run = async (scenario) => {
    setBusy(scenario);
    try { const r = await post('/api/ap/inbox/simulate', { scenario }); setLast(r); toast('Correo simulado procesado', 'ok'); reload(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(null); }
  };
  const cards = [
    ['cumple', 'Cumple con todo', 'Proveedor registrado, factura en XML completa. Se procesa sola; no se responde al proveedor.', 'ok'],
    ['parcial', 'Cumple parcialmente', 'Factura en PDF sin XML y con formatos sucios. Entra a revisión humana y se pide el XML.', 'warn'],
    ['no_cumple', 'No cumple del todo', 'Sin adjunto o con datos mínimos faltantes. Queda bloqueada y se solicita información al proveedor.', 'danger'],
  ];
  return (
    <>
      <Head title="Bandeja de correo simulada" text="Ficticia: no envía ni recibe correos reales. Cada botón genera facturas aleatorias del nivel de cumplimiento elegido." />
      <div style={{ ...grid, marginBottom: 18 }}>
        {cards.map(([key, title, text, tone]) => (
          <Card key={key} title={title} actions={<Badge tone={tone}>{key === 'cumple' ? 'Automático' : key === 'parcial' ? 'Revisión' : 'Bloqueado'}</Badge>}>
            <p className="muted" style={{ fontSize: 13, minHeight: 56 }}>{text}</p>
            {can('ap.simulate')
              ? <Button variant="primary" icon={LuPlay} disabled={!!busy} onClick={() => run(key)}>{busy === key ? 'Procesando…' : 'Simular correo'}</Button>
              : <Button locked>Simular correo</Button>}
          </Card>))}
      </div>
      {last && (
        <Card title="Último correo procesado" className="" >
          <p style={{ margin: '0 0 8px' }}><b>{last.inbox.subject}</b> · {last.inbox.counterpart}</p>
          <p className="muted" style={{ fontSize: 13 }}>{last.outcome}</p>
          {last.warning && <small className="muted">{last.warning}</small>}
          {last.invoice && <p style={{ marginBottom: 0 }}><Link to={`/cxp/facturas/${last.invoice.id}`}>Abrir factura {last.invoice.invoice_number || 'sin número'} →</Link></p>}
        </Card>)}
      <Card title="Correos recibidos" flush>
        {loading && !data ? <Spinner /> : !data?.messages.length ? <Empty>Aún no hay correos.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Recibido</th><th>Remitente</th><th>Asunto</th><th>Escenario</th><th>Resultado</th></tr></thead>
            <tbody>{data.messages.map((m) => <tr key={m.id}><td style={{ whiteSpace: 'nowrap' }}>{fmtDate(m.received_at, true)}</td><td className="mono" style={{ fontSize: 12 }}>{m.counterpart}</td><td>{m.subject}</td>
              <td>{m.scenario ? <Badge>{data.scenarios[m.scenario]}</Badge> : '—'}</td><td style={{ maxWidth: 360, fontSize: 12 }}>{m.outcome}</td></tr>)}</tbody></table></div>)}
      </Card>
    </>
  );
}

// ---------- Proveedores y empleados ----------
export function CxpVendors() {
  const { can } = useAuth(); const toast = useToast();
  const vendors = useLoad(() => get('/api/ap/vendors'), []);
  const employees = useLoad(() => get('/api/ap/employees'), []);
  const [dlg, setDlg] = useState(null);
  const save = async () => {
    try {
      if (dlg.kind === 'new') await post('/api/ap/vendors', dlg.f);
      else await patch(`/api/ap/vendors/${dlg.id}`, dlg.f);
      toast('Proveedor guardado', 'ok'); setDlg(null); vendors.reload();
    } catch (e) { toast(e.message, 'err'); }
  };
  const emp = employees.data?.employees || [];
  return (
    <>
      <Head title="Proveedores y empleados" text="Maestro usado para validar cédulas, nombres y cuentas bancarias. Un proveedor que coincide con un empleado genera alerta."
        actions={can('ap.vendors.manage') ? <Button variant="primary" icon={LuPlus} onClick={() => setDlg({ kind: 'new', f: { name: '', tax_id: '', category: 'Gastos operativos', bank_account: '', contact_email: '' } })}>Nuevo proveedor</Button> : <Button locked>Nuevo proveedor</Button>} />
      <Card flush title="Maestro de proveedores">
        {vendors.loading && !vendors.data ? <Spinner /> : (
          <div className="table-wrap"><table><thead><tr><th>Proveedor</th><th>Cédula</th><th>Categoría</th><th>Cuenta bancaria</th><th>Facturas</th><th>Monto</th><th /></tr></thead>
            <tbody>{vendors.data.vendors.map((v) => (
              <tr key={v.id}><td><b>{v.name}</b>{v.status !== 'activo' && <><br /><Badge tone="danger">Inactivo</Badge></>}</td>
                <td className="mono">{fmtTax(v.tax_id)}</td><td>{v.category}</td>
                <td className="mono" style={{ fontSize: 12 }}>{v.bank_account || '—'}{v.bank_account_changed_at && <><br /><small style={{ color: '#b45309' }}>Cambiada {ago(v.bank_account_changed_at)}</small></>}</td>
                <td className="num">{v.invoices}</td><td className="num">{crc(v.amount)}</td>
                <td>{can('ap.vendors.manage') && <Button size="sm" icon={LuPencil} onClick={() => setDlg({ kind: 'edit', id: v.id, f: { name: v.name, bank_account: v.bank_account || '', status: v.status, contact_email: v.contact_email || '' } })}>Editar</Button>}</td></tr>))}</tbody></table></div>)}
      </Card>
      <Card flush title="Empleados (para detectar conflictos de interés)" className="" >
        {!emp.length ? <Empty>Sin empleados cargados.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Empleado</th><th>Cédula</th></tr></thead>
            <tbody>{emp.map((e) => <tr key={e.id}><td>{e.name}</td><td className="mono">{e.national_id}</td></tr>)}</tbody></table></div>)}
      </Card>
      {dlg && (
        <Modal title={dlg.kind === 'new' ? 'Nuevo proveedor' : 'Editar proveedor'} onClose={() => setDlg(null)}
          footer={<><Button onClick={() => setDlg(null)}>Cancelar</Button><Button variant="primary" onClick={save}>Guardar</Button></>}>
          <div style={{ display: 'grid', gap: 12 }}>
            {dlg.kind === 'new' && <Field label="Cédula *" hint="Entre 9 y 12 dígitos"><input value={dlg.f.tax_id} onChange={(e) => setDlg({ ...dlg, f: { ...dlg.f, tax_id: e.target.value } })} /></Field>}
            <Field label="Nombre"><input value={dlg.f.name} onChange={(e) => setDlg({ ...dlg, f: { ...dlg.f, name: e.target.value } })} /></Field>
            <Field label="Cuenta bancaria" hint="Cambiarla queda registrado y se marca en el panel"><input value={dlg.f.bank_account} onChange={(e) => setDlg({ ...dlg, f: { ...dlg.f, bank_account: e.target.value } })} /></Field>
            {dlg.kind === 'edit' && <Field label="Estado"><select value={dlg.f.status} onChange={(e) => setDlg({ ...dlg, f: { ...dlg.f, status: e.target.value } })}><option value="activo">Activo</option><option value="inactivo">Inactivo</option></select></Field>}
            {dlg.kind === 'new' && <Field label="Categoría"><select value={dlg.f.category} onChange={(e) => setDlg({ ...dlg, f: { ...dlg.f, category: e.target.value } })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>}
          </div>
        </Modal>)}
    </>
  );
}

// ---------- Importación ----------
export function CxpImport() {
  const toast = useToast();
  const [step, setStep] = useState(1); const [up, setUp] = useState(null); const [table, setTable] = useState(''); const [map, setMap] = useState({});
  const [result, setResult] = useState(null); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(null);
  const tables = up?.tables || []; const current = tables.find((t) => t.name === table) || tables[0];
  const onFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return; setBusy(true);
    try {
      const r = await uploadForImport(file, (done, total) => setProgress(done < total ? `Subiendo ${done + 1} de ${total} partes…` : null));
      setUp(r); setTable(r.tables[0]?.name || ''); setMap(r.tables[0]?.suggested || {}); setStep(2);
    } catch (err) { toast(err.message, 'err'); } finally { setBusy(false); setProgress(null); e.target.value = ''; }
  };
  const pickTable = (name) => { setTable(name); setMap(tables.find((t) => t.name === name)?.suggested || {}); };
  const run = async () => {
    setBusy(true);
    try { const r = await post('/api/ap/import/run', { token: up.token, table: current?.name, mapping: map }); setResult(r); setStep(3); toast(`${r.created} factura(s) importadas`, 'ok'); }
    catch (err) { toast(err.message, 'err'); } finally { setBusy(false); }
  };
  const fields = up?.fields || {};
  const required = Object.entries(fields).filter(([, m]) => m.required).map(([k]) => k);
  const missing = required.filter((k) => !map[k]);
  return (
    <>
      <Head title="Importar base de datos externa" text="Lee una base SQLite (.db, .sqlite) o un CSV en solo lectura. Cada fila pasa por la misma limpieza y motor de riesgo que las facturas manuales." />
      <Card title={`Paso ${step} de 3`}>
        {step === 1 && (
          <div>
            <p className="muted" style={{ fontSize: 13 }}>Acepta archivos SQLite y CSV (separado por comas o punto y coma) de hasta 20 MB; los grandes se suben por partes. Para PostgreSQL o MySQL, expórtalos a SQLite o CSV: el sistema no abre conexiones externas.</p>
            <label className="btn primary" style={{ cursor: 'pointer' }}><LuUpload /> {busy ? (progress || 'Leyendo…') : 'Elegir archivo'}
              <input type="file" accept=".db,.sqlite,.sqlite3,.csv,.txt" onChange={onFile} hidden disabled={busy} /></label>
          </div>)}
        {step === 2 && up && (
          <div style={{ display: 'grid', gap: 14 }}>
            {up.kind === 'sqlite' && (
              <Field label="Tabla"><select value={table} onChange={(e) => pickTable(e.target.value)}>{tables.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.rows} filas)</option>)}</select></Field>)}
            <div>
              <b style={{ fontSize: 14 }}>Vista previa</b>
              {current?.sample?.length ? <div className="table-wrap" style={{ marginTop: 6 }}><table><thead><tr>{current.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{current.sample.map((r, i) => <tr key={i}>{current.columns.map((c) => <td key={c} style={{ fontSize: 12 }}>{String(r[c] ?? '')}</td>)}</tr>)}</tbody></table></div> : <small className="muted">Sin filas de muestra.</small>}
            </div>
            <div>
              <b style={{ fontSize: 14 }}>Mapeo de columnas</b>
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', marginTop: 8 }}>
                {Object.entries(fields).map(([k, m]) => (
                  <Field key={k} label={`${m.label}${m.required ? ' *' : ''}`}>
                    <select value={map[k] || ''} onChange={(e) => setMap({ ...map, [k]: e.target.value || undefined })}>
                      <option value="">— no mapear —</option>{current?.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>))}
              </div>
            </div>
            <div className="actions">
              <Button onClick={() => { setUp(null); setStep(1); }}>Cancelar</Button>
              <Button variant="primary" icon={LuCheck} disabled={busy || missing.length > 0} onClick={run}>{busy ? 'Importando…' : 'Importar facturas'}</Button>
            </div>
            {missing.length > 0 && <small className="muted">Falta mapear: {missing.map((k) => fields[k].label).join(', ')}</small>}
          </div>)}
        {step === 3 && result && (
          <div style={{ display: 'grid', gap: 10 }}>
            <p style={{ margin: 0 }}>Se leyeron <b>{result.rows_read}</b> fila(s) (máximo {result.limit}). Facturas creadas: <b>{result.created}</b>. Con riesgo medio o alto: <b>{result.flagged}</b>. Requieren revisión: <b>{result.needs_review}</b>.</p>
            {result.errors.length > 0 && <div className="error-box">{result.errors.slice(0, 5).map((e) => <div key={e.fila}>Fila {e.fila}: {e.error}</div>)}</div>}
            <div className="actions"><Link to="/cxp/facturas" className="btn dark">Ver facturas</Link><Button onClick={() => { setStep(1); setUp(null); setResult(null); }}>Importar otro archivo</Button></div>
          </div>)}
      </Card>
    </>
  );
}

// ---------- Reportes ----------
export function CxpReports() {
  const { data, loading, reload } = useLoad(() => get('/api/ap/reports'), []);
  const { can } = useAuth(); const toast = useToast();
  const [kind, setKind] = useState('riesgo'); const [format, setFormat] = useState('pdf');
  const gen = async () => {
    try { await post('/api/ap/reports', { kind, format }); toast('Reporte generado', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  };
  const dl = async (r) => {
    try { await download(`/api/ap/reports/${r.id}/download`, `reporte-${r.id}.${r.format}`); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <>
      <Head title="Reportes automáticos" text="PDF para el expediente, Excel para análisis y CSV para cruzar datos. Se genera además un resumen de riesgo cada semana." />
      <Card title="Generar reporte" actions={can('ap.reports') ? null : <Badge>Solo lectura</Badge>}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <Field label="Tipo"><select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="riesgo">Resumen de riesgo por nivel</option><option value="pendientes">Facturas pendientes de aprobación</option><option value="hallazgos">Detalle de hallazgos de auditoría</option></select></Field>
          <Field label="Formato"><select value={format} onChange={(e) => setFormat(e.target.value)}><option value="pdf">PDF</option><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option></select></Field>
          {can('ap.reports') ? <Button variant="primary" icon={LuRefreshCw} onClick={gen}>Generar</Button> : <Button locked>Generar</Button>}
        </div>
      </Card>
      <Card flush title="Reportes generados" className="" >
        {loading && !data ? <Spinner /> : !data?.reports.length ? <Empty>Aún no hay reportes.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Reporte</th><th>Formato</th><th>Generado</th><th>Tipo</th><th /></tr></thead>
            <tbody>{data.reports.map((r) => <tr key={r.id}><td>{r.title}</td><td><Badge>{r.format.toUpperCase()}</Badge></td><td>{fmtDate(r.created_at, true)}</td>
              <td>{r.scheduled ? <Badge tone="brand">Semanal automático</Badge> : 'Manual'}</td>
              <td><Button size="sm" icon={LuDownload} onClick={() => dl(r)}>Descargar</Button></td></tr>)}</tbody></table></div>)}
      </Card>
    </>
  );
}

// ---------- Configuración ----------
export function CxpSettings() {
  const { can } = useAuth(); const toast = useToast();
  const { data, loading, reload } = useLoad(() => get('/api/ap/settings'), []);
  const [s, setS] = useState(null); const [w, setW] = useState(null);
  if (loading && !data) return <Spinner />;
  const cur = s || data.settings; const cw = w || Object.fromEntries(data.weights.map((x) => [x.rule, x.weight]));
  const saveS = async () => { try { await put('/api/ap/settings', cur); toast('Configuración guardada y riesgo recalculado', 'ok'); setS(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  const saveW = async () => { try { await put('/api/ap/risk-weights', { weights: cw }); toast('Pesos guardados y riesgo recalculado', 'ok'); setW(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  const locked = !can('ap.settings');
  const p = data.provider;
  return (
    <>
      <Head title="Configuración de cuentas por pagar" text="Límite de aprobación, tipo de cambio, umbrales de riesgo y peso de cada prueba. Cada cambio queda en la bitácora." />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px,1fr) minmax(320px,2fr)', gap: 18, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 18 }}>
          <Card title="Parámetros" actions={!locked && s && <Button size="sm" variant="primary" onClick={saveS}>Guardar</Button>}>
            <div style={{ display: 'grid', gap: 12 }}>
              <Field label="Límite de aprobación (₡)" hint="Sobre este monto se requiere segundo nivel"><input disabled={locked} value={cur.limite_aprobacion} onChange={(e) => setS({ ...cur, limite_aprobacion: e.target.value })} /></Field>
              <Field label="Tipo de cambio (CRC por USD)"><input disabled={locked} value={cur.tipo_cambio_usd} onChange={(e) => setS({ ...cur, tipo_cambio_usd: e.target.value })} /></Field>
              <Field label="Umbral riesgo medio (puntaje)"><input disabled={locked} value={cur.umbral_medio} onChange={(e) => setS({ ...cur, umbral_medio: e.target.value })} /></Field>
              <Field label="Umbral riesgo alto (puntaje)"><input disabled={locked} value={cur.umbral_alto} onChange={(e) => setS({ ...cur, umbral_alto: e.target.value })} /></Field>
            </div>
            {locked && <small className="muted">Solo el gerente o el administrador pueden cambiar la configuración.</small>}
          </Card>
          <Card title="Lectura de PDF (proveedor de IA)">
            <p style={{ fontSize: 13, marginTop: 0 }}>Estado: <Badge tone={p.provider === 'gemini' ? 'ok' : 'warn'}>{p.provider === 'gemini' ? `Activo (${p.model})` : 'Simulado'}</Badge></p>
            {p.warning && <small className="error-box" style={{ display: 'block' }}>{p.warning}</small>}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Se configura en el servidor con las variables AI_PROVIDER=gemini y AI_API_KEY. La clave nunca se muestra ni se guarda en la base de datos.</p>
          </Card>
        </div>
        <Card title="Pesos del motor de riesgo" flush actions={!locked && w && <Button size="sm" variant="primary" onClick={saveW}>Guardar pesos</Button>}>
          <div className="table-wrap"><table><thead><tr><th>Prueba</th><th>Peso</th><th>Por defecto</th></tr></thead>
            <tbody>{data.weights.map((x) => (
              <tr key={x.rule}><td style={{ fontSize: 13 }}>{x.label}<br /><small className="muted mono">{x.rule}</small></td>
                <td><input type="number" min="0" max="100" disabled={locked} style={{ width: 80 }} value={cw[x.rule]} onChange={(e) => setW({ ...cw, [x.rule]: Number(e.target.value) })} /></td>
                <td className="num muted">{x.default}</td></tr>))}</tbody></table></div>
          <small className="muted" style={{ display: 'block', padding: '10px 16px' }}>El puntaje es la suma de los pesos de las pruebas activadas, con tope de 100.</small>
        </Card>
      </div>
    </>
  );
}
