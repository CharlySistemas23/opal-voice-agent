import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { TOOL_DEFINITIONS, dispatchTool } from './tools.js';

dotenv.config();
const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
  PUBLIC_URL,
} = process.env;
if (!OPENAI_API_KEY) { console.error('Falta OPENAI_API_KEY'); process.exit(1); }
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) { console.error('Falta TWILIO_*'); process.exit(1); }

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const VOICE = process.env.VOICE || 'alloy';
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || '0.8');
const PORT = parseInt(process.env.PORT || '8765', 10);

const SYSTEM_MESSAGE = `Eres el asistente personal bilingüe de voz de Carlos, dueño de joyería Opal & Co (sistema POS multisucursal). CRITICAL: Detecta el idioma del PRIMER turno (español/inglés) y mantén SOLO ese idioma toda la llamada. NO mezcles. Match exactly.

REGLA DE ORO: Para CUALQUIER dato del negocio (ventas, inventario, empleados, clientes, reparaciones, caja, etc) USA UN TOOL. NUNCA inventes números ni nombres. Si no hay tool para algo, dilo: "no tengo eso por voz, te abro un issue".

CATÁLOGO DE TOOLS (cuándo usar cada uno):

** Captura y memoria **
- take_note → "anota X", "guarda esto", "recuérdame"
- get_recent_notes → "¿qué te dije?", "¿qué anoté?", "¿qué pendientes tengo?", "¿qué tenía que recordar?"
- search_brain → "¿qué dije sobre Carmina?", "¿hablé de oro?", buscar nota específica
- schedule_callback → "llámame en X min", "márcame de regreso"
- create_issue → bugs, mejoras, cambios que requieren código

IMPORTANTE: cuando Carlos pregunte "¿qué te pedí?", "¿qué teníamos pendiente?", "¿de qué hablamos?", USA get_recent_notes o search_brain. NUNCA digas "no recuerdo" — si no encuentras nada, dilo explícitamente con la tool: "Busqué en tus notas y no encontré nada sobre X".

** Ventas y KPIs **
- get_dashboard_kpis → "¿cómo va el día?", "resumen", utilidad bruta y margen
- get_sales → "¿cuánto vendí hoy/ayer/esta semana/mes?" — acepta filtros branch_name, seller_name
- get_top_sellers → "¿quién vendió más?"
- get_top_products → "¿qué se vendió más?"
- get_top_customers → "mejores clientes"
- get_recent_sales → "última venta", "ventas recientes"

** Inventario **
- get_inventory_summary → "¿cuánto inventario tengo?", "valor del inventario"
- get_low_stock → "¿qué se está acabando?", "stock bajo"

** Operaciones **
- get_pending_repairs → "reparaciones pendientes"
- get_open_cash_sessions → "cajas abiertas"
- get_employees_summary → "¿cuántos empleados?"
- get_branches_summary → "¿qué sucursales tengo?"

** Sistema **
- get_system_status → "¿está funcionando el POS?"
- get_recent_errors → "¿hay errores?"
- restart_backend → SOLO si Carlos lo pide explícitamente. CONFIRMA verbalmente antes ("¿confirmas? Causa 30s de downtime").

SUCURSALES de Opal (te ayudará identificar de cuál habla Carlos):
- L VALLARTA (Lázaro Cárdenas - Vallarta)
- MALECON (Puerto Vallarta - Malecón)  ← la más activa, casi todas las ventas turísticas
- SAN SEBASTIAN (San Sebastián del Oeste)
- SAYULITA

CRITICO: cuando reportes ventas, SIEMPRE menciona la sucursal o "todas las sucursales". Las tools devuelven el campo by_branch con el breakdown. Cuando Carlos pregunte "¿de qué sucursal son esos datos?", responde con ese detalle.

PERIODOS aceptados (para todas las tools de ventas/KPIs):
- Relativos: today, yesterday, this_week, last_week, this_month, last_month, last_3_months, last_6_months, this_year, last_year
- Nombres de mes: "enero", "marzo", "march" (asume este año si no especifican)
- Mes + año: "marzo 2024", "january 2025"
- Formato YYYY-MM: "2026-03"
- Custom: usa date_from/date_to en YYYY-MM-DD

Carlos puede preguntar cosas como:
- "¿cuánto vendí en febrero?" → period: "febrero"
- "¿en marzo del año pasado?" → period: "marzo 2025" (calcula tú el año)
- "del 1 al 15 de marzo" → date_from: "2026-03-01", date_to: "2026-03-15"
- "compara febrero vs marzo" → compare_periods con period_a, period_b
- "¿cómo fueron las ventas mes por mes?" → get_sales_by_month
- "¿cuál fue mi mejor mes?" → get_sales_by_month, devuelve best_month

Reporta resultados de forma natural y breve. Si una tool falla, dilo y sugiere alternativa o create_issue. NO cuelgues primero.`;

const LOG_EVENT_TYPES = [
  'error',
  'response.done',
  'session.created',
  'session.updated',
  'conversation.item.input_audio_transcription.completed',
  'response.audio_transcript.done',
  'response.function_call_arguments.done',
];

// ============================================================================
// Twilio outbound calls
// ============================================================================

async function makeOutboundCall({ to, reason }) {
  const callbackUrl = `${PUBLIC_URL}/callback?reason=${encodeURIComponent(reason || '')}`;
  const body = new URLSearchParams({
    To: to,
    From: TWILIO_PHONE_NUMBER,
    Url: callbackUrl,
    Method: 'POST',
  });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message || JSON.stringify(json)}`);
  return json; // { sid, status, ... }
}

function scheduleCallback({ minutes, reason, to }) {
  const ms = Math.max(0, minutes) * 60 * 1000;
  const fireAt = new Date(Date.now() + ms).toISOString();
  console.log(`[callback] scheduled for ${fireAt} → ${to} (reason: ${reason || '—'})`);
  setTimeout(async () => {
    try {
      const call = await makeOutboundCall({ to, reason });
      console.log(`[callback] outbound call placed sid=${call.sid} status=${call.status}`);
    } catch (e) {
      console.error('[callback] failed:', e.message);
    }
  }, ms);
  return fireAt;
}

// ============================================================================
// HTTP routes
// ============================================================================

fastify.get('/', async (req, reply) => reply.send({ message: 'voice-agent up', port: PORT }));
fastify.get('/health', async (req, reply) => reply.send({ ok: true, model: MODEL }));

// Endpoint on-demand: dispara una llamada outbound a tu número (sin banner Trial)
// Uso: abrir https://...ngrok-free.dev/call-me?key=opal2026 desde teléfono o navegador
const CALL_ME_KEY = process.env.CALL_ME_KEY || 'opal2026';
const DEFAULT_TO = '+523222740010';
fastify.get('/call-me', async (request, reply) => {
  if (request.query?.key !== CALL_ME_KEY) {
    return reply.code(401).send({ error: 'invalid_key' });
  }
  const to = request.query?.to || DEFAULT_TO;
  const reason = request.query?.reason || '';
  try {
    const call = await makeOutboundCall({ to, reason });
    console.log(`[call-me] outbound placed sid=${call.sid} status=${call.status} to=${to}`);
    reply.type('text/html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Llamando…</title>
<style>body{font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}h1{font-size:2em}p{opacity:.7}.dot{display:inline-block;animation:p 1.4s infinite;}.dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}@keyframes p{0%,80%,100%{opacity:.3}40%{opacity:1}}</style>
</head><body>
<h1>📞 Llamando<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></h1>
<p>Tu teléfono va a sonar en segundos</p>
<p style="font-size:.8em;margin-top:2em">SID: ${call.sid}</p>
</body></html>`);
  } catch (e) {
    console.error('[call-me] error:', e.message);
    reply.code(500).send({ error: e.message });
  }
});

// TwiML para llamada entrante normal
fastify.all('/incoming-call', async (request, reply) => {
  const from = request.body?.From || request.query?.From || 'unknown';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream">
      <Parameter name="From" value="${from}" />
      <Parameter name="callType" value="inbound" />
    </Stream>
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

// TwiML para callback outbound (cuando Twilio nos llama de regreso)
fastify.all('/callback', async (request, reply) => {
  const reason = request.query?.reason || request.body?.reason || '';
  const to = request.body?.To || ''; // el número que Twilio llamó
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream">
      <Parameter name="From" value="${to}" />
      <Parameter name="callType" value="callback" />
      <Parameter name="reason" value="${reason}" />
    </Stream>
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

// ============================================================================
// WebSocket / OpenAI Realtime bridge
// ============================================================================

fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection) => {
    console.log('[twilio] caller connected');

    let streamSid = null;
    let callSid = null;
    let from = 'unknown';
    let callType = 'inbound';
    let callbackReason = '';
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    const transcriptLog = [];

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${MODEL}`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
    );

    const initSession = () => {
      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
          temperature: TEMPERATURE,
          tools: TOOL_DEFINITIONS,
          tool_choice: 'auto',
        },
      }));

      // Greeting personalizado según tipo de llamada
      let greeting;
      if (callType === 'callback') {
        greeting = callbackReason
          ? `Saluda con: "Hola Carlos, te llamo de regreso. Me pediste llamarte sobre ${callbackReason}. ¿Qué necesitas?"`
          : 'Saluda con: "Hola Carlos, te llamo de regreso como pediste. ¿Qué necesitas?"';
      } else {
        greeting = 'Saluda con: "Hola Carlos, te escucho. Hi Carlos, I am here."';
      }
      openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: greeting }] }
      }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    };

    const handleSpeechStarted = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsed = latestMediaTimestamp - responseStartTimestampTwilio;
        if (lastAssistantItem) {
          openAiWs.send(JSON.stringify({
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsed,
          }));
        }
        connection.send(JSON.stringify({ event: 'clear', streamSid }));
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    const sendMark = () => {
      if (streamSid) {
        connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
        markQueue.push('responsePart');
      }
    };

    // ---------- Function call handler ----------
    const handleFunctionCall = async (callId, name, argsJson) => {
      console.log(`[fn] ${name}(${argsJson})`);
      let args;
      try { args = JSON.parse(argsJson); } catch { args = {}; }
      let output;

      if (name === 'schedule_callback') {
        // schedule_callback se queda local (necesita state del setTimeout + 'from')
        const minutes = Number(args.minutes ?? 0);
        const reason = args.reason || '';
        if (!from || from === 'unknown') {
          output = { ok: false, error: 'no_caller_number' };
        } else if (minutes === 0) {
          setTimeout(() => makeOutboundCall({ to: from, reason }).catch(e => console.error('[cb]', e.message)), 1000);
          output = { ok: true, scheduled_for: 'inmediato', to: from, summary: 'Te llamo en unos segundos' };
        } else {
          const fireAt = scheduleCallback({ minutes, reason, to: from });
          output = { ok: true, scheduled_for: fireAt, to: from, minutes, reason, summary: `Te marco en ${minutes} minuto${minutes === 1 ? '' : 's'}` };
        }
      } else {
        // Las demás tools van por dispatcher (tools.js)
        try {
          output = await dispatchTool(name, args);
        } catch (e) {
          output = { ok: false, error: e.message };
        }
      }

      console.log(`[fn] ${name} → ${output.ok ? 'ok' : 'fail'}: ${output.summary || output.error || ''}`);

      openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
      }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    };

    openAiWs.on('open', () => {
      console.log('[openai] realtime connected');
      setTimeout(initSession, 100);
    });

    openAiWs.on('message', (data) => {
      try {
        const ev = JSON.parse(data);
        if (LOG_EVENT_TYPES.includes(ev.type)) console.log(`[openai] ${ev.type}`);

        if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript) {
          transcriptLog.push({ role: 'user', text: ev.transcript.trim(), ts: new Date().toISOString() });
          console.log(`[transcript] caller: ${ev.transcript.trim()}`);
        }
        if (ev.type === 'response.audio_transcript.done' && ev.transcript) {
          transcriptLog.push({ role: 'assistant', text: ev.transcript.trim(), ts: new Date().toISOString() });
          console.log(`[transcript] assistant: ${ev.transcript.trim()}`);
        }

        // Function call done → ejecutar
        if (ev.type === 'response.function_call_arguments.done') {
          handleFunctionCall(ev.call_id, ev.name, ev.arguments).catch(err =>
            console.error('[fn] error:', err.message)
          );
        }

        if (ev.type === 'response.audio.delta' && ev.delta) {
          connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: ev.delta } }));
          if (!responseStartTimestampTwilio) responseStartTimestampTwilio = latestMediaTimestamp;
          if (ev.item_id) lastAssistantItem = ev.item_id;
          sendMark();
        }
        if (ev.type === 'input_audio_buffer.speech_started') handleSpeechStarted();
        if (ev.type === 'error') console.error('[openai] error:', JSON.stringify(ev));
      } catch (err) {
        console.error('[openai] parse error:', err.message);
      }
    });

    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case 'media':
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
            }
            break;
          case 'start':
            streamSid = data.start.streamSid;
            callSid = data.start.callSid || null;
            const params = data.start.customParameters || {};
            from = params.From || 'unknown';
            callType = params.callType || 'inbound';
            callbackReason = params.reason || '';
            console.log(`[twilio] stream start sid=${streamSid} from=${from} type=${callType} reason="${callbackReason}"`);
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            break;
          case 'mark':
            if (markQueue.length > 0) markQueue.shift();
            break;
        }
      } catch (err) {
        console.error('[twilio] parse error:', err.message);
      }
    });

    connection.on('close', () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log(`[twilio] disconnected. ${transcriptLog.length} mensajes capturados.`);
      writeBrainPage(transcriptLog, from, callSid, callType).catch(err =>
        console.error('[brain] error:', err.message)
      );
    });

    openAiWs.on('close', () => console.log('[openai] disconnected'));
    openAiWs.on('error', (err) => console.error('[openai] error:', err.message));
  });
});

// ============================================================================
// Brain page writer
// ============================================================================

// Escribe meeting page en gbrain Postgres directamente (sin gbrain CLI — no
// está instalado en el container). Usa el mismo pool que take_note.
import pg from 'pg';
const _brainPool = process.env.GBRAIN_DATABASE_URL ? new pg.Pool({
  connectionString: process.env.GBRAIN_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
}) : null;

async function writeBrainPage(transcript, from, callSid, callType) {
  if (transcript.length === 0 || !_brainPool) return;
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5).replace(':', '');
  const slug = `meetings/call-${date}-${time}`;
  const title = `Llamada ${date} ${time}`;
  const body = transcript.map(t => `**${t.role === 'user' ? 'Carlos' : 'Asistente'}**: ${t.text}`).join('\n\n');
  const md = `# ${title}\n\n**Caller:** ${from}\n**Tipo:** ${callType}\n**Mensajes:** ${transcript.length}\n\n## Transcripción\n\n${body}\n`;
  const fm = JSON.stringify({
    tags: ['voice-call', 'twilio', callType],
    caller: from, call_sid: callSid || 'unknown', call_type: callType,
  });
  const client = await _brainPool.connect();
  try {
    await client.query(`
      INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter, created_at, updated_at)
      VALUES ('default', $1, 'meeting', $2, $3, $4::jsonb, NOW(), NOW())
      ON CONFLICT (source_id, slug)
      DO UPDATE SET compiled_truth = EXCLUDED.compiled_truth, updated_at = NOW()
    `, [slug, title, md, fm]);
    console.log(`[brain] page creada: ${slug}`);
  } finally { client.release(); }
}

// Error boundary global — evita que errores no manejados maten el server.
// Sin esto, una tool con error inesperado tumba la VM y Railway la reinicia,
// con downtime de ~30s mid-call.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`[voice-agent] listening on :${PORT} model=${MODEL} public=${PUBLIC_URL || '?'}`);
});
