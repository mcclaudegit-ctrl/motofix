import { Router } from '../lib/http.js';
import { sessionRoutes } from './session.js';
import { billingRoutes } from './billing.js';
import { catalogRoutes } from './catalog.js';
import { supplierRoutes } from './suppliers.js';
import { adminRoutes } from './admin.js';
import { apRoutes } from './ap.js';

export function buildRouter() {
  const r = new Router();
  sessionRoutes(r);
  billingRoutes(r);
  catalogRoutes(r);
  supplierRoutes(r);
  adminRoutes(r);
  apRoutes(r);
  return r;
}
