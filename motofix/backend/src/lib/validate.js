import { HttpError } from './http.js';

const bad = (name, msg) => new HttpError(422, 'VALIDACION', `${name}: ${msg}`);

export const v = {
  str(val, name, { min = 1, max = 300, optional = false } = {}) {
    if (val == null || val === '') {
      if (optional) return null;
      throw bad(name, 'es obligatorio');
    }
    if (typeof val !== 'string') throw bad(name, 'debe ser texto');
    const s = val.trim();
    if (s.length < min) throw bad(name, `debe tener al menos ${min} caracteres`);
    if (s.length > max) throw bad(name, `no puede exceder ${max} caracteres`);
    return s;
  },
  num(val, name, { min = -Infinity, max = Infinity, int = false, optional = false } = {}) {
    if (val == null || val === '') {
      if (optional) return null;
      throw bad(name, 'es obligatorio');
    }
    const n = Number(val);
    if (!Number.isFinite(n)) throw bad(name, 'debe ser numérico');
    if (int && !Number.isInteger(n)) throw bad(name, 'debe ser un entero');
    if (n < min) throw bad(name, `debe ser ≥ ${min}`);
    if (n > max) throw bad(name, `debe ser ≤ ${max}`);
    return n;
  },
  oneOf(val, name, list, { optional = false } = {}) {
    if ((val == null || val === '') && optional) return null;
    if (!list.includes(val)) throw bad(name, `valor inválido (permitidos: ${list.join(', ')})`);
    return val;
  },
  email(val, name = 'email') {
    const s = v.str(val, name, { max: 120 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad(name, 'formato inválido');
    return s;
  },
  array(val, name, { min = 0, max = 100 } = {}) {
    if (!Array.isArray(val)) throw bad(name, 'debe ser una lista');
    if (val.length < min) throw bad(name, `requiere al menos ${min} elemento(s)`);
    if (val.length > max) throw bad(name, `máximo ${max} elementos`);
    return val;
  },
};
