// Tools operacionales que el agente puede invocar por voz.
// Cada tool retorna un objeto { ok, ...data, error? } que se manda como
// function_call_output al modelo para que continue la conversación.

import pg from 'pg';

const { Pool } = pg;

// ============================================================================
// Pools de Postgres (lazy init)
// ============================================================================
let posPool = null;
let brainPool = null;

function getPosPool() {
  if (!posPool && process.env.POS_DATABASE_URL) {
    posPool = new Pool({
      connectionString: process.env.POS_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return posPool;
}

function getBrainPool() {
  if (!brainPool && process.env.GBRAIN_DATABASE_URL) {
    brainPool = new Pool({
      connectionString: process.env.GBRAIN_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return brainPool;
}

// ============================================================================
// Tool: take_note — guarda nota en gbrain
// ============================================================================
export async function take_note({ content, tags = [] }) {
  if (!content) return { ok: false, error: 'content_required' };
  const pool = getBrainPool();
  if (!pool) return { ok: false, error: 'gbrain_not_configured' };

  const now = new Date();
  const slug = `notes/voice-${now.toISOString().slice(0, 10)}-${now.toTimeString().slice(0, 8).replace(/:/g, '')}`;
  const title = content.slice(0, 60).trim() + (content.length > 60 ? '...' : '');
  const md = `# ${title}\n\n${content}\n`;
  const tagsArr = Array.isArray(tags) ? tags : [];
  tagsArr.push('voice-note');

  try {
    const client = await pool.connect();
    try {
      await client.query(`
        INSERT INTO pages (slug, type, title, compiled_truth, tags, created_at, updated_at)
        VALUES ($1, 'note', $2, $3, $4, NOW(), NOW())
        ON CONFLICT (slug) DO UPDATE SET compiled_truth = EXCLUDED.compiled_truth, updated_at = NOW()
      `, [slug, title, md, tagsArr]);
      return { ok: true, slug, message: `Nota guardada en ${slug}` };
    } finally {
      client.release();
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// Tool: get_system_status — health check del backend POS
// ============================================================================
export async function get_system_status() {
  const url = process.env.POS_HEALTH_URL || 'https://backend-no-tocar-production.up.railway.app/api/health';
  try {
    const start = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const elapsed = Date.now() - start;
    let body = {};
    try { body = await res.json(); } catch {}
    return {
      ok: true,
      online: res.ok,
      status_code: res.status,
      response_time_ms: elapsed,
      details: body,
      summary: res.ok ? `POS online, respuesta en ${elapsed}ms` : `POS NO responde (HTTP ${res.status})`,
    };
  } catch (e) {
    return { ok: true, online: false, error: e.message, summary: `POS no accesible: ${e.message}` };
  }
}

// ============================================================================
// Tool: get_sales_today — métricas de ventas del día
// ============================================================================
export async function get_sales_today() {
  const pool = getPosPool();
  if (!pool) return { ok: false, error: 'pos_database_not_configured' };

  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT
          COUNT(*)::int                            AS total_ventas,
          COALESCE(SUM(total), 0)::numeric(12,2)   AS total_mxn,
          COALESCE(AVG(total), 0)::numeric(12,2)   AS ticket_promedio,
          COUNT(DISTINCT branch_id)::int           AS sucursales_activas
        FROM sales
        WHERE created_at >= CURRENT_DATE
          AND status = 'completed'
      `);
      const r = result.rows[0];
      return {
        ok: true,
        total_ventas: r.total_ventas,
        total_mxn: parseFloat(r.total_mxn),
        ticket_promedio: parseFloat(r.ticket_promedio),
        sucursales_activas: r.sucursales_activas,
        summary: r.total_ventas === 0
          ? 'No hay ventas completadas hoy'
          : `${r.total_ventas} ventas hoy por ${r.total_mxn} pesos. Ticket promedio ${r.ticket_promedio}.`,
      };
    } finally {
      client.release();
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// Tool: get_recent_errors — últimos errores del audit_log del POS
// ============================================================================
export async function get_recent_errors({ limit = 5 } = {}) {
  const pool = getPosPool();
  if (!pool) return { ok: false, error: 'pos_database_not_configured' };

  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT id, action, entity_type, details, created_at
        FROM audit_logs
        WHERE action ILIKE '%error%' OR action ILIKE '%fail%'
        ORDER BY created_at DESC
        LIMIT $1
      `, [Math.min(limit, 20)]);
      return {
        ok: true,
        count: result.rowCount,
        errors: result.rows.map(r => ({
          when: r.created_at.toISOString(),
          action: r.action,
          entity: r.entity_type,
          details: typeof r.details === 'object' ? JSON.stringify(r.details).slice(0, 200) : String(r.details).slice(0, 200),
        })),
        summary: result.rowCount === 0
          ? 'No hay errores recientes'
          : `${result.rowCount} errores. El más reciente: ${result.rows[0].action}`,
      };
    } finally {
      client.release();
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// Tool: restart_backend — reinicia servicio Railway del POS
// ============================================================================
export async function restart_backend() {
  const token = process.env.RAILWAY_TOKEN;
  const serviceId = process.env.RAILWAY_BACKEND_SERVICE_ID;
  const envId = process.env.RAILWAY_ENV_ID;
  if (!token || !serviceId || !envId) {
    return { ok: false, error: 'railway_not_configured' };
  }

  // Mutation: serviceInstanceRedeploy (re-despliega el último deploy del servicio)
  // Necesita: serviceId, environmentId
  const query = `
    mutation Redeploy($serviceId: String!, $environmentId: String!) {
      serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
    }
  `;
  try {
    const res = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        'Project-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { serviceId, environmentId: envId } }),
    });
    const json = await res.json();
    if (json.errors) return { ok: false, error: json.errors[0].message };
    return {
      ok: true,
      summary: 'Backend reiniciándose. Estará listo en 30-60 segundos.',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// Tool: create_issue — abre issue en GitHub para fix manual posterior
// ============================================================================
export async function create_issue({ title, body, urgency = 'normal' }) {
  if (!title) return { ok: false, error: 'title_required' };
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
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
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json.message || `HTTP ${res.status}` };
    return {
      ok: true,
      issue_number: json.number,
      url: json.html_url,
      summary: `Issue #${json.number} creado: ${title}`,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// Definición de tools para OpenAI Realtime
// ============================================================================
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'take_note',
    description: 'Guarda una nota, idea, recordatorio o pendiente en el cerebro (gbrain). Úsalo cuando Carlos diga "anota", "guarda esto", "recuérdame", "apunta", "save this", "remember".',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Contenido de la nota tal como Carlos lo dijo.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags opcionales para clasificar.' },
      },
      required: ['content'],
    },
  },
  {
    type: 'function',
    name: 'schedule_callback',
    description: 'Programa una llamada de regreso al teléfono actual del usuario en N minutos. Úsalo cuando pida "llámame en X min", "márcame de regreso", "call me back".',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Minutos hasta la llamada. 0 = inmediato.' },
        reason: { type: 'string', description: 'Tema de la llamada de regreso.' },
      },
      required: ['minutes'],
    },
  },
  {
    type: 'function',
    name: 'get_system_status',
    description: 'Consulta si el backend del POS está online y reporta tiempo de respuesta. Úsalo cuando Carlos pregunte "¿está funcionando el sistema?", "status", "todo bien con el POS?".',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'get_sales_today',
    description: 'Reporta ventas del día actual: cantidad, total en pesos, ticket promedio, sucursales activas. Úsalo cuando Carlos pregunte "cómo van las ventas hoy", "cuánto se ha vendido", "métricas del día".',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'get_recent_errors',
    description: 'Lista los últimos errores del audit_log del POS. Úsalo cuando Carlos pregunte "hay errores", "qué está fallando", "últimos errores".',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Cuántos errores mostrar (max 20). Default 5.' },
      },
    },
  },
  {
    type: 'function',
    name: 'restart_backend',
    description: 'REINICIA el servicio backend del POS en Railway. Causa downtime de 30-60s. Úsalo SOLO cuando Carlos pida explícitamente "reinicia el backend", "reinicia el sistema", "restart". NUNCA por iniciativa propia.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'create_issue',
    description: 'Abre un issue en GitHub para que se resuelva después manualmente. Úsalo cuando Carlos describa un bug, una mejora o una tarea no urgente que requiere cambios de código.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título corto y descriptivo (ej "fix bug en cálculo de comisiones").' },
        body: { type: 'string', description: 'Descripción detallada con lo que dijo Carlos.' },
        urgency: { type: 'string', enum: ['low', 'normal', 'urgent'], description: 'Urgencia.' },
      },
      required: ['title'],
    },
  },
];

// ============================================================================
// Dispatcher: ejecuta el tool por nombre
// ============================================================================
export async function dispatchTool(name, args) {
  switch (name) {
    case 'take_note': return take_note(args);
    case 'get_system_status': return get_system_status();
    case 'get_sales_today': return get_sales_today();
    case 'get_recent_errors': return get_recent_errors(args);
    case 'restart_backend': return restart_backend();
    case 'create_issue': return create_issue(args);
    // schedule_callback se queda en index.js porque necesita state local del setTimeout
    default: return { ok: false, error: `unknown_tool: ${name}` };
  }
}
