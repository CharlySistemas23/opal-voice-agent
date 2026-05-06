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

// Mapa de nombres de mes → número (0-11)
const MONTH_MAP = {
  enero: 0, ene: 0, january: 0, jan: 0,
  febrero: 1, feb: 1, february: 1,
  marzo: 2, mar: 2, march: 2,
  abril: 3, abr: 3, april: 3, apr: 3,
  mayo: 4, may: 4,
  junio: 5, jun: 5, june: 5,
  julio: 6, jul: 6, july: 6,
  agosto: 7, ago: 7, august: 7, aug: 7,
  septiembre: 8, sep: 8, september: 8,
  octubre: 9, oct: 9, october: 9,
  noviembre: 10, nov: 10, november: 10,
  diciembre: 11, dic: 11, december: 11, dec: 11,
};
const MONTH_LABEL_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

// Convierte un periodo (string o {date_from,date_to}) a { from, to, label }
// Acepta:
//   today, yesterday, this_week, last_week, this_month, last_month
//   last_3_months, last_6_months, this_year, last_year
//   nombre de mes: "enero", "marzo 2024", "march", "feb 2025"
//   YYYY-MM: "2026-03"
//   {date_from:"2026-01-01", date_to:"2026-01-31"} (custom)
function periodToRange(period, dateFrom, dateTo) {
  // Custom date range
  if (dateFrom || dateTo) {
    const from = dateFrom ? new Date(dateFrom + 'T00:00:00') : new Date('1970-01-01');
    const to = dateTo ? new Date(new Date(dateTo + 'T00:00:00').getTime() + 86400000) : new Date();
    return { from, to, label: `del ${dateFrom || '?'} al ${dateTo || 'hoy'}` };
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);
  const p = String(period || 'today').toLowerCase().trim().replace(/\s+/g, '_');

  // Periodos relativos predefinidos
  switch (p) {
    case 'today': case 'hoy':
      return { from: today, to: tomorrow, label: 'hoy' };
    case 'yesterday': case 'ayer': {
      const y = new Date(today.getTime() - 86400000);
      return { from: y, to: today, label: 'ayer' };
    }
    case 'this_week': case 'esta_semana': case 'semana': {
      const dow = today.getDay() || 7;
      const monday = new Date(today.getTime() - (dow - 1) * 86400000);
      return { from: monday, to: tomorrow, label: 'esta semana' };
    }
    case 'last_week': case 'semana_pasada': case 'la_semana_pasada': {
      const dow = today.getDay() || 7;
      const lastMon = new Date(today.getTime() - (dow - 1 + 7) * 86400000);
      const lastSun = new Date(lastMon.getTime() + 7 * 86400000);
      return { from: lastMon, to: lastSun, label: 'la semana pasada' };
    }
    case 'this_month': case 'este_mes': case 'mes':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: tomorrow, label: 'este mes' };
    case 'last_month': case 'mes_pasado': case 'el_mes_pasado': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: start, to: end, label: `${MONTH_LABEL_ES[start.getMonth()]} ${start.getFullYear()}` };
    }
    case 'last_3_months': case 'ultimos_3_meses': case 'ultimo_trimestre': {
      const start = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      return { from: start, to: tomorrow, label: 'últimos 3 meses' };
    }
    case 'last_6_months': case 'ultimos_6_meses': case 'ultimo_semestre': {
      const start = new Date(now.getFullYear(), now.getMonth() - 6, 1);
      return { from: start, to: tomorrow, label: 'últimos 6 meses' };
    }
    case 'this_year': case 'este_anio': case 'este_año': case 'anio_actual':
      return { from: new Date(now.getFullYear(), 0, 1), to: tomorrow, label: `${now.getFullYear()}` };
    case 'last_year': case 'anio_pasado': case 'año_pasado': case 'anio_anterior': {
      const y = now.getFullYear() - 1;
      return { from: new Date(y, 0, 1), to: new Date(y + 1, 0, 1), label: `${y}` };
    }
  }

  // Formato YYYY-MM (ej "2026-03")
  const ymMatch = p.match(/^(\d{4})-(\d{2})$/);
  if (ymMatch) {
    const y = parseInt(ymMatch[1], 10), m = parseInt(ymMatch[2], 10) - 1;
    return { from: new Date(y, m, 1), to: new Date(y, m + 1, 1), label: `${MONTH_LABEL_ES[m]} ${y}` };
  }

  // Nombre de mes (con o sin año): "marzo", "marzo_2024", "march_2025"
  const tokens = p.split(/[_\s-]+/);
  for (let i = 0; i < tokens.length; i++) {
    const m = MONTH_MAP[tokens[i]];
    if (m !== undefined) {
      let y = now.getFullYear();
      // Buscar año en los demás tokens
      for (const t of tokens) {
        const yNum = parseInt(t, 10);
        if (yNum >= 2020 && yNum <= 2100) { y = yNum; break; }
      }
      // Si el mes ya pasó este año Y no se especifica año, asumir este año (usuario suele querer mes actual)
      // Si el mes es FUTURO en este año Y no especificó año, asumir año pasado
      if (!tokens.some(t => /^20\d{2}$/.test(t))) {
        if (m > now.getMonth()) y = y - 1;
      }
      return { from: new Date(y, m, 1), to: new Date(y, m + 1, 1), label: `${MONTH_LABEL_ES[m]} ${y}` };
    }
  }

  // Fallback: today
  return { from: today, to: tomorrow, label: 'hoy' };
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
export async function get_sales({ period = 'today', branch_name, seller_name, date_from, date_to } = {}) {
  const { from, to, label } = periodToRange(period, date_from, date_to);
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
export async function get_dashboard_kpis({ period = 'today', date_from, date_to } = {}) {
  const { from, to, label } = periodToRange(period, date_from, date_to);
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
export async function get_top_sellers({ period = 'today', limit = 5, date_from, date_to } = {}) {
  const { from, to, label } = periodToRange(period, date_from, date_to);
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
export async function get_top_products({ period = 'today', limit = 5, date_from, date_to } = {}) {
  const { from, to, label } = periodToRange(period, date_from, date_to);
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
export async function get_top_customers({ period = 'this_month', limit = 5, date_from, date_to } = {}) {
  const { from, to, label } = periodToRange(period, date_from, date_to);
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
// get_sales_by_month — desglose mensual del año (histórico)
// ============================================================================
export async function get_sales_by_month({ year } = {}) {
  const y = year || new Date().getFullYear();
  try {
    const r = await posQuery(`
      SELECT
        EXTRACT(MONTH FROM created_at)::int AS m,
        COUNT(*)::int AS n,
        COALESCE(SUM(total), 0)::numeric(14,2) AS total
      FROM sales
      WHERE EXTRACT(YEAR FROM created_at) = $1 AND status = 'completed'
      GROUP BY EXTRACT(MONTH FROM created_at)
      ORDER BY m
    `, [y]);
    const months = r.rows.map(x => ({
      month: MONTH_LABEL_ES[x.m - 1], month_num: x.m,
      sales_count: x.n, total: parseFloat(x.total),
    }));
    const total = months.reduce((a, b) => a + b.total, 0);
    const best = months.reduce((a, b) => (b.total > (a?.total || 0) ? b : a), null);
    return {
      ok: true, year: y, months, total_year: total,
      best_month: best,
      summary: months.length === 0
        ? `Sin ventas en ${y}`
        : `${y}: total ${fmtMxn(total)}. Mejor mes: ${best.month} con ${fmtMxn(best.total)}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// compare_periods — compara ventas/utilidad entre 2 periodos
// ============================================================================
export async function compare_periods({ period_a, period_b }) {
  if (!period_a || !period_b) return { ok: false, error: 'period_a y period_b requeridos' };
  const a = await get_dashboard_kpis({ period: period_a });
  const b = await get_dashboard_kpis({ period: period_b });
  if (!a.ok) return { ok: false, error: `Periodo A: ${a.error}` };
  if (!b.ok) return { ok: false, error: `Periodo B: ${b.error}` };
  const delta = a.revenue_mxn - b.revenue_mxn;
  const pct = b.revenue_mxn > 0 ? (delta / b.revenue_mxn) * 100 : 0;
  const arrow = delta >= 0 ? '↑' : '↓';
  const dir = delta >= 0 ? 'más' : 'menos';
  return {
    ok: true,
    period_a: { label: a.period, revenue: a.revenue_mxn, sales: a.sales_count, gross_profit: a.gross_profit_mxn, margin: a.margin_percent },
    period_b: { label: b.period, revenue: b.revenue_mxn, sales: b.sales_count, gross_profit: b.gross_profit_mxn, margin: b.margin_percent },
    delta_revenue: parseFloat(delta.toFixed(2)),
    delta_percent: parseFloat(pct.toFixed(1)),
    summary: `${a.period}: ${fmtMxn(a.revenue_mxn)} (${a.sales_count} ventas). ` +
             `${b.period}: ${fmtMxn(b.revenue_mxn)} (${b.sales_count} ventas). ` +
             `${arrow} ${fmtMxn(Math.abs(delta))} ${dir} en ${a.period} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`,
  };
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
      period: { type: 'string', description: 'today | yesterday | this_week | last_week | this_month | last_month | last_3_months | last_6_months | this_year | last_year | nombre_de_mes (ej "enero", "marzo 2024") | YYYY-MM (ej "2026-03")' },
      date_from: { type: 'string', description: 'Fecha inicio YYYY-MM-DD (override de period). Para rangos custom.' },
      date_to: { type: 'string', description: 'Fecha fin YYYY-MM-DD (override de period).' },
      branch_name: { type: 'string', description: 'Nombre o parte del nombre de la sucursal (ILIKE).' },
      seller_name: { type: 'string', description: 'Nombre o parte del nombre del vendedor.' },
    } },
  },
  {
    type: 'function', name: 'get_top_sellers',
    description: 'Top vendedores por monto vendido. Para "¿quién vendió más?", "top vendedores".',
    parameters: { type: 'object', properties: {
      period: { type: 'string', description: 'today | yesterday | this_week | last_week | this_month | last_month | last_3_months | last_6_months | this_year | last_year | nombre_de_mes (ej "enero", "marzo 2024") | YYYY-MM (ej "2026-03")' },
      date_from: { type: 'string', description: 'Fecha inicio YYYY-MM-DD (override de period). Para rangos custom.' },
      date_to: { type: 'string', description: 'Fecha fin YYYY-MM-DD (override de period).' },
      limit: { type: 'number' },
    } },
  },
  {
    type: 'function', name: 'get_top_products',
    description: 'Top productos vendidos. Para "¿qué se vendió más?", "productos top".',
    parameters: { type: 'object', properties: {
      period: { type: 'string', description: 'today | yesterday | this_week | last_week | this_month | last_month | last_3_months | last_6_months | this_year | last_year | nombre_de_mes (ej "enero", "marzo 2024") | YYYY-MM (ej "2026-03")' },
      date_from: { type: 'string', description: 'Fecha inicio YYYY-MM-DD (override de period). Para rangos custom.' },
      date_to: { type: 'string', description: 'Fecha fin YYYY-MM-DD (override de period).' },
      limit: { type: 'number' },
    } },
  },
  {
    type: 'function', name: 'get_top_customers',
    description: 'Top clientes por monto comprado. Para "¿clientes top?", "mejores clientes".',
    parameters: { type: 'object', properties: {
      period: { type: 'string', description: 'today | yesterday | this_week | last_week | this_month | last_month | last_3_months | last_6_months | this_year | last_year | nombre_de_mes (ej "enero", "marzo 2024") | YYYY-MM (ej "2026-03")' },
      date_from: { type: 'string', description: 'Fecha inicio YYYY-MM-DD (override de period). Para rangos custom.' },
      date_to: { type: 'string', description: 'Fecha fin YYYY-MM-DD (override de period).' },
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
  {
    type: 'function', name: 'get_sales_by_month',
    description: 'Desglose mensual del año (histórico). Para "¿cómo fueron las ventas mes por mes?", "¿cuál fue mi mejor mes?", "ventas de 2025".',
    parameters: { type: 'object', properties: { year: { type: 'number', description: 'Año (default: actual)' } } },
  },
  {
    type: 'function', name: 'compare_periods',
    description: 'Compara KPIs entre 2 periodos (ventas, utilidad, margen). Para "compara enero vs febrero", "este mes vs el pasado", "2024 vs 2025".',
    parameters: {
      type: 'object',
      properties: {
        period_a: { type: 'string', description: 'Periodo A (ej "marzo", "this_month", "2026-03", "marzo 2024")' },
        period_b: { type: 'string', description: 'Periodo B' },
      },
      required: ['period_a', 'period_b'],
    },
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
    case 'get_sales_by_month':     return get_sales_by_month(args);
    case 'compare_periods':        return compare_periods(args);
    case 'get_recent_errors':      return get_recent_errors(args);
    case 'restart_backend':        return restart_backend();
    case 'create_issue':           return create_issue(args);
    default: return { ok: false, error: `unknown_tool: ${name}` };
  }
}
