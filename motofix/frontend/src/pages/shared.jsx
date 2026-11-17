import { useState } from 'react';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import { Button, crc } from '../ui.jsx';

/** Editor de líneas de producto: { product_id, qty, unit_cost? }. withCost muestra costo unitario editable (compras). */
export function ProductLines({ products, lines, setLines, withCost, priceOf, label = 'Agregar producto…' }) {
  const [pick, setPick] = useState('');
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const add = () => {
    const p = byId[pick]; if (!p) return;
    setLines((l) => (l.some((x) => x.product_id === p.id) ? l.map((x) => (x.product_id === p.id ? { ...x, qty: x.qty + 1 } : x)) : [...l, { product_id: p.id, qty: 1, unit_cost: withCost ? p.cost || 0 : undefined }]));
    setPick('');
  };
  return (
    <div>
      {lines.length > 0 && (
        <div className="table-wrap"><table className="lines"><thead><tr><th>Producto</th><th>Cant.</th>{withCost && <th>Costo unit. (₡)</th>}{priceOf && <th className="right">Precio</th>}<th /></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.product_id}><td>{byId[l.product_id]?.name}</td>
              <td><input type="number" min={1} value={l.qty} onChange={(e) => setLines(lines.map((x) => (x === l ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)))} /></td>
              {withCost && <td><input type="number" min={1} value={l.unit_cost} style={{ width: 110 }} onChange={(e) => setLines(lines.map((x) => (x === l ? { ...x, unit_cost: Number(e.target.value) || 0 } : x)))} /></td>}
              {priceOf && <td className="right num">{crc(priceOf(byId[l.product_id]) * l.qty)}</td>}
              <td><Button variant="ghost" size="sm" aria-label="Quitar" onClick={() => setLines(lines.filter((x) => x !== l))}><LuTrash2 /></Button></td></tr>))}</tbody></table></div>
      )}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1, minWidth: 200 }}><option value="">{label}</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <Button icon={LuPlus} disabled={!pick} onClick={add}>Agregar</Button>
      </div>
    </div>
  );
}
