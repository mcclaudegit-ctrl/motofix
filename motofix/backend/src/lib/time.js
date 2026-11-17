import { config } from '../config.js';

const pad = (n) => String(n).padStart(2, '0');
export const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Partes de fecha/hora en zona horaria del taller (Costa Rica). */
export function localParts(iso) {
  const l = new Date(new Date(iso).getTime() + config.tzOffsetHours * 3600e3);
  return {
    date: l.toISOString().slice(0, 10), hour: l.getUTCHours(), minute: l.getUTCMinutes(), dow: l.getUTCDay(),
    hm: `${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`,
  };
}

export const crc = (n) => '₡' + new Intl.NumberFormat('es-CR').format(Math.round(n || 0));
export const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400e3;
