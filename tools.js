// Tools operacionales que el agente puede invocar por voz.
// Todas las tools devuelven { ok, ...data, error?, summary? }.
// El campo `summary` es lo que el modelo dice al usuario en una frase corta.

import pg from 'pg';
const { Pool } = pg;

// ============================================================================
// Pools (lazy)
// ============================================================================
let posPool = null, brainPool = null;
function getPosPool() {
  if (!posPool && process.env.POS_DATABASE_URL) {
    posPool = new Pool({
      connectionString: process.env.POS_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
    });
  }
  return posPool;
}
function getBrainPool() {
  if (!brainPool && process.env.GBRAIN_DATABASE_URL) {
    brainPool = new Pool({
      connectionString: process.env.GBRAIN_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
    });
  }
  return brainPool;
}

// Helper: ejecuta SQL en POS y libera connection
async function posQuery(sql, params = []) {
  const pool = getPosPool();
  if (!pool) throw new Error('POS_DATABASE_URL not configured');
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// Helper: convierte "today" / "yesterday" / "this_week" / "this_month" a SQL boundaries
function periodToRange(period) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);
  switch ((period || 'today').toLowerCase()) {
    case 'today':
    case 'hoy':
      return { from: today, to: tomorrow, label: 'hoy' };
    case 'yesterday':
    case 'ayer': {
      const y = new Date(today.getTime() - 86400000);
      return { from: y, to: today, label: 'ayer' };
    }
    case 'this_week':
    case 'esta_semana':
    case 'semana': {
      const dow = today.getDay() || 7;
      const monday = new Date(today.getTime() - (dow - 1) * 86400000);
      return { from: monday, to: tomorrow, label: 'esta semana' };
    }
    case 'this_month':
    case 'este_mes':
    case 'mes': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: start, to: tomorrow, label: 'este mes' };
    }
    default:
      return { from: today, to: tomorrow, label: 'hoy' };
  }
}

const fmtMxn = n => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0);

// ============================================================================
// take_note
// ============================================================================
export async function take_note({ content, tags = [] }) {
  if (!content) return { ok: false, error: 'content_required' };
  const pool = getBrainPool();
  if (!pool) return { ok: false, error: 'gbrain_not_configured' };
  const now = new Date();
  const slug = `notes/voice-${now.toISOString().slice(0, 10)}-${now.toTimeString().slice(0, 8).replace(/:/g, '')}`;
  const title = (content.slice(0, 60).trim() + (content.length > 60 ? '...' : '')) || 'Nota de voz';
  const md = `# ${title}\n\n${content}\n`;
  const tagsArr = [...(Array.isArray(tags) ? tags : []), 'voice-note'];
  const frontmatter = JSON.stringify({ tags: tagsArr, source: 'voice' });
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter, created_at, updated_at)
        VALUES ('default', $1, 'note', $2, $3, $4::jsonb, NOW(), NOW())
        ON CONFLICT (source_id, slug) DO UPDATE SET compiled_truth = EXCLUDED.compiled_truth, updated_at = NOW()
      `, [slug, title, md, frontmatter]);
      return { ok: true, slug, summary: 'Nota guardada' };
    } finally { client.release(); }
  } catch (e) { return { ok: false, error: `gbrain: ${e.message}` }; }
}

// ============================================================================
// get_system_status
// ============================================================================
export async function get_system_status() {
  const url = process.env.POS_HEALTH_URL || 'https://backend-production-6260.up.railway.app/health';
  try {
    const start = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const elapsed = Date.now() - start;
    let body = {}; try { body = await res.json(); } catch {}
    const pool = body?.dbDiagnostics?.pool;
    const breaker = body?.dbDiagnostics?.breaker?.state;
    let summary = res.ok ? `POS online en ${elapsed}ms` : `POS no responde (HTTP ${res.status})`;
    if (pool) summary += `, pool ${pool.totalCount}/${pool.idleCount} idle, ${pool.waitingCount} esperando, breaker ${breaker || '?'}`;
    return { ok: true, online: res.ok, status_code: res.status, response_time_ms: elapsed, details: body, summary };
  } catch (e) { return { ok: true, online: false, error: e.message, summary: `POS inaccesible: ${e.message}` }; }
}

// ============================================================================
// get_sales — ventas con filtros opcionales
// ============================================================================
export async function get_sales({ period = 'today', branch_name, seller_name } = {}) {
  const { from, to, label } = periodToRange(period);
  let sql = `
    SELECT COUNT(s.id)::int AS n, COALESCE(SUM(s.total), 0)::numeric(14,2) AS total,
           COALESCE(AVG(s.total), 0)::numeric(14,2) AS avg_ticket
    FROM sales s
    LEFT JOIN branches b ON s.branch_id = b.id
    LEFT JOIN catalog_sellers cs ON s.seller_id = cs.id
    WHERE s.created_at >= $1 AND s.created_at < $2 AND s.status = 'completed'
  `;
  const params = [from, to];
  if (branch_name) { params.push(`%${branch_name}%`); sql += ` AND b.name ILIKE $${params.length}`; }
  if (seller_name) { params.push(`%${seller_name}%`); sql += ` AND cs.name ILIKE $${params.length}`; }
  try {
    const r = await posQuery(sql, params);
    const row = r.rows[0];
    let scope = label;
    if (branch_name) scope += ` en ${branch_name}`;
    if (seller_name) scope += ` por ${seller_name}`;
    return {
      ok: true,
      period: label, n: row.n,
      total_mxn: parseFloat(row.total), avg_ticket: parseFloat(row.avg_ticket),
      summary: row.n === 0
        ? `Cero ventas ${scope}`
        : `${row.n} ventas ${scope} por ${fmtMxn(row.total)}, ticket promedio ${fmtMxn(row.avg_ticket)}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_dashboard_kpis — vista del día con utilidad estimada
// ============================================================================
export async function get_dashboard_kpis({ period = 'today' } = {}) {
  const { from, to, label } = periodToRange(period);
  try {
    const r = await posQuery(`
      WITH s AS (
        SELECT id, total, branch_id FROM sales
        WHERE created_at >= $1 AND created_at < $2 AND status = 'completed'
      ),
      cogs AS (
        SELECT COALESCE(SUM(si.quantity * COALESCE(ii.cost, 0)), 0)::numeric(14,2) AS total_cogs
        FROM sale_items si
        JOIN s ON si.sale_id = s.id
        LEFT JOIN inventory_items ii ON si.item_id = ii.id
      ),
      commissions AS (
        SELECT COALESCE(SUM(COALESCE(si.seller_commission,0) + COALESCE(si.guide_commission,0)), 0)::numeric(14,2) AS total
        FROM sale_items si JOIN s ON si.sale_id = s.id
      )
      SELECT
        (SELECT COUNT(*) FROM s)::int AS sales_n,
        (SELECT COALESCE(SUM(total),0) FROM s)::numeric(14,2) AS revenue,
        (SELECT total_cogs FROM cogs) AS cogs,
        (SELECT total FROM commissions) AS commissions,
        (SELECT COUNT(DISTINCT branch_id) FROM s)::int AS active_branches
    `, [from, to]);
    const k = r.rows[0];
    const revenue = parseFloat(k.revenue), cogs = parseFloat(k.cogs), comm = parseFloat(k.commissions);
    const gross = revenue - cogs - comm;
    const margin = revenue > 0 ? (gross / revenue) * 100 : 0;
    return {
      ok: true,
      period: label,
      sales_count: k.sales_n,
      revenue_mxn: revenue, cogs_mxn: cogs, commissions_mxn: comm,
      gross_profit_mxn: parseFloat(gross.toFixed(2)),
      margin_percent: parseFloat(margin.toFixed(1)),
      active_branches: k.active_branches,
      summary: k.sales_n === 0
        ? `Sin ventas ${label}`
        : `${k.sales_n} ventas ${label} por ${fmtMxn(revenue)}, utilidad bruta ${fmtMxn(gross)} (margen ${margin.toFixed(0)}%)`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_top_sellers
// ============================================================================
export async function get_top_sellers({ period = 'today', limit = 5 } = {}) {
  const { from, to, label } = periodToRange(period);
  try {
    const r = await posQuery(`
      SELECT cs.name AS seller, COUNT(s.id)::int AS n,
             COALESCE(SUM(s.total), 0)::numeric(14,2) AS total
      FROM sales s
      JOIN catalog_sellers cs ON s.seller_id = cs.id
      WHERE s.created_at >= $1 AND s.created_at < $2 AND s.status = 'completed'
      GROUP BY cs.name
      ORDER BY total DESC
      LIMIT $3
    `, [from, to, Math.min(limit, 20)]);
    const rows = r.rows.map(x => ({ seller: x.seller, n: x.n, total: parseFloat(x.total) }));
    return {
      ok: true, period: label, sellers: rows,
      summary: rows.length === 0
        ? `Sin ventas ${label}`
        : `Top ${label}: ${rows.slice(0, 3).map(x => `${x.seller} ${fmtMxn(x.total)}`).join(', ')}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_top_products
// ============================================================================
export async function get_top_products({ period = 'today', limit = 5 } = {}) {
  const { from, to, label } = periodToRange(period);
  try {
    const r = await posQuery(`
      SELECT COALESCE(ii.name, 'Item ' || si.item_id::text) AS name,
             ii.category, ii.metal,
             SUM(si.quantity)::int AS qty,
             COALESCE(SUM(si.subtotal), 0)::numeric(14,2) AS total
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      LEFT JOIN inventory_items ii ON si.item_id = ii.id
      WHERE s.created_at >= $1 AND s.created_at < $2 AND s.status = 'completed'
      GROUP BY ii.name, ii.category, ii.metal, si.item_id
      ORDER BY total DESC
      LIMIT $3
    `, [from, to, Math.min(limit, 20)]);
    const rows = r.rows.map(x => ({ name: x.name, category: x.category, metal: x.metal, qty: x.qty, total: parseFloat(x.total) }));
    return {
      ok: true, period: label, products: rows,
      summary: rows.length === 0
        ? `Sin ventas ${label}`
        : `Top productos ${label}: ${rows.slice(0, 3).map(p => `${p.name} (${p.qty})`).join(', ')}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_inventory_summary
// ============================================================================
export async function get_inventory_summary({ branch_name } = {}) {
  let sql = `
    SELECT b.name AS branch, COUNT(ii.id)::int AS items,
           COALESCE(SUM(ii.stock_actual), 0)::int AS total_stock,
           COALESCE(SUM(ii.cost * ii.stock_actual), 0)::numeric(14,2) AS valor_costo,
           COALESCE(SUM(ii.price * ii.stock_actual), 0)::numeric(14,2) AS valor_venta
    FROM inventory_items ii
    LEFT JOIN branches b ON ii.branch_id = b.id
    WHERE ii.status NOT IN ('deleted', 'vendida')
  `;
  const params = [];
  if (branch_name) { params.push(`%${branch_name}%`); sql += ` AND b.name ILIKE $${params.length}`; }
  sql += ' GROUP BY b.name ORDER BY valor_costo DESC';
  try {
    const r = await posQuery(sql, params);
    const rows = r.rows.map(x => ({
      branch: x.branch, items: x.items, total_stock: x.total_stock,
      valor_costo: parseFloat(x.valor_costo), valor_venta: parseFloat(x.valor_venta),
    }));
    const tot = rows.reduce((a, b) => ({ items: a.items + b.items, costo: a.costo + b.valor_costo, venta: a.venta + b.valor_venta }), { items: 0, costo: 0, venta: 0 });
    return {
      ok: true, by_branch: rows,
      total_items: tot.items, total_valor_costo: tot.costo, total_valor_venta: tot.venta,
      summary: `${tot.items} piezas, valor a costo ${fmtMxn(tot.costo)}, a venta ${fmtMxn(tot.venta)}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_low_stock
// ============================================================================
export async function get_low_stock({ limit = 10 } = {}) {
  try {
    const r = await posQuery(`
      SELECT ii.sku, ii.name, ii.category, ii.stock_actual, ii.stock_min, b.name AS branch
      FROM inventory_items ii
      LEFT JOIN branches b ON ii.branch_id = b.id
      WHERE ii.status = 'disponible' AND ii.stock_actual <= COALESCE(NULLIF(ii.stock_min, 0), 1)
      ORDER BY ii.stock_actual ASC, ii.name ASC
      LIMIT $1
    `, [Math.min(limit, 30)]);
    const rows = r.rows.map(x => ({ sku: x.sku, name: x.name, category: x.category, stock: x.stock_actual, min: x.stock_min, branch: x.branch }));
    return {
      ok: true, items: rows,
      summary: rows.length === 0 ? 'Sin items con stock bajo' : `${rows.length} items con stock bajo. Más urgente: ${rows[0].name}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_pending_repairs
// ============================================================================
export async function get_pending_repairs({ status, limit = 10 } = {}) {
  let sql = `
    SELECT r.folio, r.status, r.estimated_cost, r.estimated_delivery_date,
           c.name AS customer_name, b.name AS branch
    FROM repairs r
    LEFT JOIN customers c ON r.customer_id = c.id
    LEFT JOIN branches b ON r.branch_id = b.id
    WHERE r.status IN ('pendiente', 'en_proceso', 'completada')
  `;
  const params = [];
  if (status) { params.push(status); sql += ` AND r.status = $${params.length}`; }
  params.push(Math.min(limit, 30));
  sql += ` ORDER BY r.created_at DESC LIMIT $${params.length}`;
  try {
    const r = await posQuery(sql, params);
    return {
      ok: true, count: r.rowCount, repairs: r.rows,
      summary: r.rowCount === 0 ? 'Cero reparaciones pendientes' : `${r.rowCount} reparaciones pendientes`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_open_cash_sessions
// ============================================================================
export async function get_open_cash_sessions() {
  try {
    const r = await posQuery(`
      SELECT cs.id, cs.initial_amount, cs.date, b.name AS branch,
             u.username AS user_name,
             COALESCE((SELECT SUM(amount) FROM cash_movements cm WHERE cm.session_id = cs.id), 0)::numeric(14,2) AS movements_total
      FROM cash_sessions cs
      LEFT JOIN branches b ON cs.branch_id = b.id
      LEFT JOIN users u ON cs.user_id = u.id
      WHERE cs.status = 'open'
      ORDER BY cs.date DESC
    `);
    return {
      ok: true, count: r.rowCount, sessions: r.rows,
      summary: r.rowCount === 0 ? 'Cero cajas abiertas' : `${r.rowCount} cajas abiertas`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_top_customers
// ============================================================================
export async function get_top_customers({ period = 'this_month', limit = 5 } = {}) {
  const { from, to, label } = periodToRange(period);
  try {
    const r = await posQuery(`
      SELECT c.name, c.phone, COUNT(s.id)::int AS purchases,
             COALESCE(SUM(s.total), 0)::numeric(14,2) AS total
      FROM sales s
      JOIN customers c ON s.customer_id = c.id
      WHERE s.created_at >= $1 AND s.created_at < $2 AND s.status = 'completed'
      GROUP BY c.id, c.name, c.phone
      ORDER BY total DESC
      LIMIT $3
    `, [from, to, Math.min(limit, 20)]);
    const rows = r.rows.map(x => ({ name: x.name, phone: x.phone, purchases: x.purchases, total: parseFloat(x.total) }));
    return {
      ok: true, period: label, customers: rows,
      summary: rows.length === 0
        ? `Cero clientes registrados ${label}`
        : `Top ${label}: ${rows.slice(0, 3).map(c => `${c.name} ${fmtMxn(c.total)}`).join(', ')}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_employees_summary
// ============================================================================
export async function get_employees_summary({ branch_name } = {}) {
  let sql = `
    SELECT b.name AS branch, e.role, COUNT(e.id)::int AS n
    FROM employees e
    LEFT JOIN branches b ON e.branch_id = b.id
    WHERE e.active = true
  `;
  const params = [];
  if (branch_name) { params.push(`%${branch_name}%`); sql += ` AND b.name ILIKE $${params.length}`; }
  sql += ' GROUP BY b.name, e.role ORDER BY b.name, e.role';
  try {
    const r = await posQuery(sql, params);
    const total = r.rows.reduce((a, b) => a + b.n, 0);
    return {
      ok: true, by_branch_role: r.rows, total_active: total,
      summary: `${total} empleados activos`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_branches_summary
// ============================================================================
export async function get_branches_summary() {
  try {
    const r = await posQuery(`
      SELECT b.code, b.name, b.active,
             (SELECT COUNT(*) FROM employees e WHERE e.branch_id = b.id AND e.active = true)::int AS employees,
             (SELECT COUNT(*) FROM inventory_items ii WHERE ii.branch_id = b.id AND ii.status = 'disponible')::int AS items_disponibles
      FROM branches b
      WHERE b.active = true
      ORDER BY b.name
    `);
    return {
      ok: true, branches: r.rows, count: r.rowCount,
      summary: `${r.rowCount} sucursales activas: ${r.rows.map(b => b.name).join(', ')}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_recent_sales
// ============================================================================
export async function get_recent_sales({ limit = 5 } = {}) {
  try {
    const r = await posQuery(`
      SELECT s.folio, s.total, s.created_at, s.status,
             b.name AS branch, cs.name AS seller, c.name AS customer
      FROM sales s
      LEFT JOIN branches b ON s.branch_id = b.id
      LEFT JOIN catalog_sellers cs ON s.seller_id = cs.id
      LEFT JOIN customers c ON s.customer_id = c.id
      ORDER BY s.created_at DESC
      LIMIT $1
    `, [Math.min(limit, 20)]);
    const rows = r.rows.map(x => ({
      folio: x.folio, total: parseFloat(x.total), when: x.created_at.toISOString(),
      status: x.status, branch: x.branch, seller: x.seller, customer: x.customer,
    }));
    return {
      ok: true, sales: rows, count: r.rowCount,
      summary: rows.length === 0 ? 'Sin ventas recientes' :
        `Última venta: folio ${rows[0].folio} por ${fmtMxn(rows[0].total)} en ${rows[0].branch}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// get_recent_errors (POS audit_logs)
// ============================================================================
export async function get_recent_errors({ limit = 5 } = {}) {
  try {
    const r = await posQuery(`
      SELECT action, entity_type, details, created_at
      FROM audit_logs
      WHERE action ILIKE '%error%' OR action ILIKE '%fail%'
      ORDER BY created_at DESC
      LIMIT $1
    `, [Math.min(limit, 20)]);
    return {
      ok: true, count: r.rowCount,
      errors: r.rows.map(x => ({
        when: x.created_at.toISOString(), action: x.action, entity: x.entity_type,
        details: typeof x.details === 'object' ? JSON.stringify(x.details).slice(0, 200) : String(x.details).slice(0, 200),
      })),
      summary: r.rowCount === 0 ? 'Cero errores recientes' : `${r.rowCount} errores. Más reciente: ${r.rows[0].action}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// restart_backend (Railway)
// ============================================================================
export async function restart_backend() {
  const token = process.env.RAILWAY_TOKEN;
  const serviceId = process.env.RAILWAY_BACKEND_SERVICE_ID;
  const envId = process.env.RAILWAY_ENV_ID;
  if (!token || !serviceId || !envId) return { ok: false, error: 'railway_not_configured' };
  const query = `mutation Redeploy($s:String!,$e:String!) { serviceInstanceRedeploy(serviceId:$s, environmentId:$e) }`;
  try {
    const res = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { 'Project-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { s: serviceId, e: envId } }),
    });
    const json = await res.json();
    if (json.errors) return { ok: false, error: json.errors[0].message };
    return { ok: true, summary: 'Backend reiniciándose. Estará listo en 30-60 segundos.' };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// create_issue (GitHub)
// ============================================================================
export async function create_issue({ title, body, urgency = 'normal' }) {
  if (!title) return { ok: false, error: 'title_required' };
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo) return { ok: false, error: 'github_not_configured' };
  const labels = ['voice-request'];
  if (urgency === 'urgent' || urgency === 'urgente') labels.push('urgent');
  if (urgency === 'low' || urgency === 'baja') labels.push('low-priority');
  const payload = {
    title,
    body: `${body || ''}\n\n---\n_Creado vía voice-agent — ${new Date().toISOString()}_`,
    labels,
  };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json.message || `HTTP ${res.status}` };
    return { ok: true, issue_number: json.number, url: json.html_url, summary: `Issue número ${json.number} abierto` };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// TOOL DEFINITIONS para OpenAI Realtime
// ============================================================================
export const TOOL_DEFINITIONS = [
  // ============ NOTAS / CALLBACKS ============
  {
    type: 'function', name: 'take_note',
    description: 'Guarda una nota, idea, recordatorio o pendiente en el cerebro (gbrain). Úsalo cuando Carlos diga "anota", "guarda esto", "recuérdame", "save this".',
    parameters: { type: 'object', properties: {
      content: { type: 'string', description: 'Contenido de la nota tal como Carlos lo dijo.' },
      tags: { type: 'array', items: { type: 'string' } },
    }, required: ['content'] },
  },
  {
    type: 'function', name: 'schedule_callback',
    description: 'Programa una llamada de regreso al teléfono actual del usuario en N minutos. Para "llámame en X min", "márcame de regreso".',
    parameters: { type: 'object', properties: {
      minutes: { type: 'number', description: 'Minutos hasta la llamada. 0 = inmediato.' },
      reason: { type: 'string' },
    }, required: ['minutes'] },
  },

  // ============ READ-ONLY DEL POS ============
  {
    type: 'function', name: 'get_dashboard_kpis',
    description: 'KPIs principales: ventas totales, utilidad bruta, margen, cogs, comisiones. Para "¿cómo va el día?", "resumen del mes", "estado del negocio".',
    parameters: { type: 'object', properties: {
      period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'this_month'], description: 'Periodo. Default today.' },
    } },
  },
  {
    type: 'function', name: 'get_sales',
    description: 'Ventas con filtros: periodo, sucursal, vendedor. Para "¿cuánto vendí hoy?", "ventas en Cancún", "qué vendió Juan esta semana".',
    parameters: { type: 'object', properties: {
      period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'this_month'] },
      branch_name: { type: 'string', description: 'Nombre o parte del nombre de la sucursal (ILIKE).' },
      seller_name: { type: 'string', description: 'Nombre o parte del nombre del vendedor.' },
    } },
  },
  {
    type: 'function', name: 'get_top_sellers',
    description: 'Top vendedores por monto vendido. Para "¿quién vendió más?", "top vendedores".',
    parameters: { type: 'object', properties: {
      period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'this_month'] },
      limit: { type: 'number' },
    } },
  },
  {
    type: 'function', name: 'get_top_products',
    description: 'Top productos vendidos. Para "¿qué se vendió más?", "productos top".',
    parameters: { type: 'object', properties: {
      period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'this_month'] },
      limit: { type: 'number' },
    } },
  },
  {
    type: 'function', name: 'get_top_customers',
    description: 'Top clientes por monto comprado. Para "¿clientes top?", "mejores clientes".',
    parameters: { type: 'object', properties: {
      period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'this_month'] },
      limit: { type: 'number' },
    } },
  },
  {
    type: 'function', name: 'get_inventory_summary',
    description: 'Resumen de inventario por sucursal: piezas, stock total, valor a costo y a venta. Para "¿cuánto inventario tengo?", "valor del inventario".',
    parameters: { type: 'object', properties: {
      branch_name: { type: 'string' },
    } },
  },
  {
    type: 'function', name: 'get_low_stock',
    description: 'Items con stock bajo (≤ stock_min). Para "¿qué se está acabando?", "stock bajo", "qué reabastecer".',
    parameters: { type: 'object', properties: {
      limit: { type: 'number' },
    } },
  },
  {
    type: 'function', name: 'get_pending_repairs',
    description: 'Reparaciones pendientes (estados pendiente, en_proceso, completada). Para "¿reparaciones pendientes?".',
    parameters: { type: 'object', properties: {
      status: { type: 'string', enum: ['pendiente', 'en_proceso', 'completada'] },
      limit: { type: 'number' },
    } },
  },
  {
    type: 'function', name: 'get_open_cash_sessions',
    description: 'Cajas actualmente abiertas con totales. Para "¿hay cajas abiertas?", "estado de las cajas".',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function', name: 'get_employees_summary',
    description: 'Conteo de empleados activos por sucursal y rol. Para "¿cuántos empleados tengo?", "personal activo".',
    parameters: { type: 'object', properties: { branch_name: { type: 'string' } } },
  },
  {
    type: 'function', name: 'get_branches_summary',
    description: 'Lista de sucursales activas con conteo de empleados e items. Para "¿qué sucursales tengo?".',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function', name: 'get_recent_sales',
    description: 'Últimas N ventas en detalle (folio, monto, sucursal, vendedor, cliente). Para "última venta", "ventas recientes".',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
  },

  // ============ SISTEMA / OPERACIÓN ============
  {
    type: 'function', name: 'get_system_status',
    description: 'Health check del backend POS con info de pool DB y circuit breaker. Para "¿está funcionando el sistema?".',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function', name: 'get_recent_errors',
    description: 'Últimos errores del audit_log del POS. Para "¿hay errores?", "fallas recientes".',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    type: 'function', name: 'restart_backend',
    description: 'REINICIA el backend del POS en Railway (downtime ~30-60s). Úsalo SOLO cuando Carlos pida explícitamente "reinicia el backend". CONFIRMA verbalmente antes.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function', name: 'create_issue',
    description: 'Abre issue en GitHub para fix manual posterior. Úsalo cuando Carlos describa un bug, mejora o cambio que requiera código.',
    parameters: { type: 'object', properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      urgency: { type: 'string', enum: ['low', 'normal', 'urgent'] },
    }, required: ['title'] },
  },
];

// ============================================================================
// dispatcher
// ============================================================================
export async function dispatchTool(name, args) {
  switch (name) {
    case 'take_note':              return take_note(args);
    case 'get_system_status':      return get_system_status();
    case 'get_dashboard_kpis':     return get_dashboard_kpis(args);
    case 'get_sales':              return get_sales(args);
    case 'get_top_sellers':        return get_top_sellers(args);
    case 'get_top_products':       return get_top_products(args);
    case 'get_top_customers':      return get_top_customers(args);
    case 'get_inventory_summary':  return get_inventory_summary(args);
    case 'get_low_stock':          return get_low_stock(args);
    case 'get_pending_repairs':    return get_pending_repairs(args);
    case 'get_open_cash_sessions': return get_open_cash_sessions();
    case 'get_employees_summary':  return get_employees_summary(args);
    case 'get_branches_summary':   return get_branches_summary();
    case 'get_recent_sales':       return get_recent_sales(args);
    case 'get_recent_errors':      return get_recent_errors(args);
    case 'restart_backend':        return restart_backend();
    case 'create_issue':           return create_issue(args);
    default: return { ok: false, error: `unknown_tool: ${name}` };
  }
}
