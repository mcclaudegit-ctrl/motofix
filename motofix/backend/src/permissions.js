// Catálogo de permisos y matriz por defecto (PRD §2 y §5). La matriz vive en la BD (role_permissions)
// y es editable desde el módulo de Control de Accesos; esto solo define los valores iniciales.

export const ROLES = {
  admin: { label: 'Administrador', description: 'Acceso total, gestión de usuarios y roles' },
  gerente: { label: 'Gerente', description: 'Dashboards ejecutivos, aprobación de anulaciones y excepciones' },
  auditor: { label: 'Auditor', description: 'Revisión independiente de CxP, hallazgos y reportes (sin aprobar)' },
  contador: { label: 'Contador', description: 'Registros financieros, NIIF 15, conciliaciones y auditoría' },
  recepcionista: { label: 'Recepcionista', description: 'Órdenes de trabajo, clientes y facturación estándar' },
  ventas: { label: 'Asistente de Ventas', description: 'Catálogo, cotizaciones y precuentas' },
  proveedor: { label: 'Proveedor', description: 'Portal externo de facturas de insumos' },
};

export const PERMISSIONS = {
  'dashboard.view': { group: 'Dashboard', label: 'Ver dashboard ejecutivo y KPIs' },
  'dashboard.basic': { group: 'Dashboard', label: 'Ver panel operativo básico' },
  'invoices.view': { group: 'Facturación', label: 'Consultar facturas' },
  'invoices.create': { group: 'Facturación', label: 'Emitir facturas de venta y servicio' },
  'invoices.pay': { group: 'Facturación', label: 'Registrar cobro de facturas' },
  'invoices.discount': { group: 'Facturación', label: 'Aplicar descuentos al emitir' },
  'invoices.void': { group: 'Facturación', label: 'Anular facturas directamente' },
  'approvals.request': { group: 'Aprobaciones', label: 'Solicitar anulaciones y descuentos' },
  'approvals.resolve': { group: 'Aprobaciones', label: 'Aprobar o rechazar solicitudes' },
  'inventory.view': { group: 'Inventario', label: 'Consultar catálogo e inventario' },
  'inventory.view_cost': { group: 'Inventario', label: 'Ver costos de repuestos' },
  'inventory.edit': { group: 'Inventario', label: 'Crear y modificar catálogo' },
  'inventory.adjust': { group: 'Inventario', label: 'Ajustar stock manualmente' },
  'workorders.view': { group: 'Órdenes de trabajo', label: 'Consultar órdenes de trabajo' },
  'workorders.create': { group: 'Órdenes de trabajo', label: 'Crear órdenes de trabajo' },
  'workorders.update': { group: 'Órdenes de trabajo', label: 'Actualizar estado de órdenes' },
  'customers.view': { group: 'Clientes', label: 'Consultar clientes' },
  'customers.manage': { group: 'Clientes', label: 'Registrar y editar clientes' },
  'quotes.view': { group: 'Cotizaciones', label: 'Consultar cotizaciones y precuentas' },
  'quotes.create': { group: 'Cotizaciones', label: 'Crear cotizaciones y precuentas' },
  'purchases.view': { group: 'Compras', label: 'Consultar facturas de compra' },
  'purchases.create': { group: 'Compras', label: 'Registrar compras e insumos' },
  'purchases.approve': { group: 'Compras', label: 'Aprobar, rechazar y pagar compras' },
  'accounting.view': { group: 'Contabilidad', label: 'Ver conciliaciones y monitor NIIF 15' },
  'accounting.export': { group: 'Contabilidad', label: 'Exportar libros contables' },
  'ai.view': { group: 'Auditor Inteligente y bitácora', label: 'Ver alertas del Auditor Inteligente' },
  'ai.scan': { group: 'Auditor Inteligente y bitácora', label: 'Ejecutar escaneo y gestionar alertas' },
  'audit.view': { group: 'Auditor Inteligente y bitácora', label: 'Consultar bitácora de auditoría' },
  'notifications.security': { group: 'Auditor Inteligente y bitácora', label: 'Recibir alertas de seguridad' },
  'users.manage': { group: 'Accesos', label: 'Gestionar usuarios' },
  'permissions.manage': { group: 'Accesos', label: 'Editar la matriz de permisos' },
  'supplier.portal': { group: 'Portal proveedores', label: 'Acceder al portal de proveedores' },
  'ap.view': { group: 'Cuentas por pagar', label: 'Ver facturas CxP y dashboard de riesgo' },
  'ap.simulate': { group: 'Cuentas por pagar', label: 'Registrar facturas CxP (captura, PDF, demostración y bandeja simulada)' },
  'ap.review': { group: 'Cuentas por pagar', label: 'Revisar hallazgos y limpieza de datos' },
  'ap.approve': { group: 'Cuentas por pagar', label: 'Aprobar facturas (primer nivel)' },
  'ap.approve_high': { group: 'Cuentas por pagar', label: 'Aprobar facturas sobre el límite (segundo nivel)' },
  'ap.vendors.view': { group: 'Cuentas por pagar', label: 'Ver proveedores y empleados' },
  'ap.vendors.manage': { group: 'Cuentas por pagar', label: 'Gestionar maestro de proveedores' },
  'ap.import': { group: 'Cuentas por pagar', label: 'Importar bases de datos externas' },
  'ap.reports': { group: 'Cuentas por pagar', label: 'Generar y descargar reportes' },
  'ap.settings': { group: 'Cuentas por pagar', label: 'Configurar límite, tipo de cambio y pesos de riesgo' },
};

// Permisos que el rol admin nunca puede perder (evita bloqueo del sistema).
export const ADMIN_PROTECTED = ['users.manage', 'permissions.manage', 'audit.view', 'dashboard.view'];

const ALL = Object.keys(PERMISSIONS);

export const DEFAULT_MATRIX = {
  admin: ALL,
  gerente: [
    'dashboard.view', 'invoices.view', 'invoices.create', 'invoices.pay', 'invoices.discount', 'invoices.void',
    'approvals.request', 'approvals.resolve', 'inventory.view', 'inventory.view_cost', 'inventory.edit', 'inventory.adjust',
    'workorders.view', 'workorders.create', 'workorders.update', 'customers.view', 'customers.manage',
    'quotes.view', 'quotes.create', 'purchases.view', 'accounting.view', 'ai.view', 'ai.scan', 'notifications.security',
    'ap.view', 'ap.review', 'ap.approve', 'ap.approve_high', 'ap.vendors.view', 'ap.vendors.manage', 'ap.import', 'ap.reports', 'ap.settings',
  ],
  auditor: [
    'dashboard.view', 'invoices.view', 'workorders.view', 'inventory.view', 'purchases.view', 'accounting.view',
    'ai.view', 'ai.scan', 'audit.view', 'notifications.security',
    'ap.view', 'ap.vendors.view', 'ap.reports',
  ],
  contador: [
    'dashboard.view', 'invoices.view', 'invoices.create', 'invoices.pay', 'approvals.request',
    'inventory.view', 'inventory.view_cost', 'workorders.view', 'customers.view', 'quotes.view',
    'purchases.view', 'purchases.create', 'purchases.approve', 'accounting.view', 'accounting.export',
    'ai.view', 'ai.scan', 'audit.view', 'notifications.security',
    'ap.view', 'ap.simulate', 'ap.review', 'ap.approve', 'ap.vendors.view', 'ap.import', 'ap.reports',
  ],
  recepcionista: [
    'dashboard.basic', 'invoices.view', 'invoices.create', 'invoices.pay', 'inventory.view',
    'workorders.view', 'workorders.create', 'workorders.update', 'customers.view', 'customers.manage',
    'quotes.view', 'quotes.create', 'ap.simulate',
  ],
  ventas: ['dashboard.basic', 'inventory.view', 'customers.view', 'quotes.view', 'quotes.create'],
  proveedor: ['supplier.portal'],
};
