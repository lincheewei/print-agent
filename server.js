// agent.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');
const axios = require('axios');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { execSync } = require('child_process');
const packageJson = (() => {
  try { return require('./package.json'); } catch (e) { return {}; }
})();

// Load configuration (config.json)
const cfgPath = path.resolve(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('config.json not found. Create one next to agent.js (see recommended config in docs).');
  process.exit(1);
}
let config = {};
try {
  config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (err) {
  console.error('Failed to read/parse config.json:', err.message);
  process.exit(1);
}

// Allow environment overrides (optional)
const agentId = process.env.AGENT_ID || config.agentId || 'unknown-agent';
const relayUrl = process.env.RELAY_URL || config.relayUrl || null;
const localHttpPort = parseInt(process.env.LOCAL_HTTP_PORT || config.localHttpPort || 5000, 10);
const scale = Object.assign({}, config.scale || {});
const printer = Object.assign({}, config.printer || {});

// Allowed origins: comma-separated env or config value. Example: "http://localhost:5173,http://localhost:3000"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || config.allowedOrigins || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Create Express app
const app = express();

// --- CORS & Logging middleware (run before any body parsers / routes)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Logging for debugging incoming requests and origin
  console.log(`[HTTP] ${req.method} ${req.url} Origin: ${origin || 'NONE'} UA: ${req.headers['user-agent'] || 'unknown'}`);

  // Decide what to set for Access-Control-Allow-Origin
  // If ALLOWED_ORIGINS contains '*' then allow all origins (dev convenience)
  let allowOrigin = null;
  if (ALLOWED_ORIGINS.includes('*')) {
    allowOrigin = '*';
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    allowOrigin = origin;
  }

  // Fallback for dev: if no origin matched and origin present, allow it (optional)
  if (!allowOrigin && origin && ALLOWED_ORIGINS.length === 0) {
    allowOrigin = origin;
  }

  // Set headers
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  } else {
    // Explicitly not allowing origin. For debugging we still set same header to avoid ambiguous absence,
    // but better is to return 403 if you want to block unknown origins. We'll set 'null' to indicate blocked origin.
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  // If you need cookies/auth from browser, set Access-Control-Allow-Credentials: true and explicit origin (not '*')
  res.setHeader('Access-Control-Allow-Credentials', 'false');

  // Short-circuit preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// global JSON body parsing (after CORS)
app.use(express.json({ limit: '1mb' }));

// ---------------- SCALE ----------------
let latestRecord = null;
let port;
let parser;
if (scale && scale.port) {
  try {
    port = new SerialPort({ path: scale.port, baudRate: scale.baud || 9600, autoOpen: false });
    parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
    port.open(err => {
      if (err) {
        console.error(`[SCALE] Failed to open ${scale.port}:`, err.message);
      } else {
        console.log(`[SCALE] ${scale.port} opened @ ${scale.baud || 9600} baud`);
      }
    });
  } catch (err) {
    console.error('[SCALE] serialport init error', err.message);
  }
} else {
  console.warn('[SCALE] No scale.port configured in config.json');
}

let buffer = [];
if (parser) {
  parser.on('data', line => {
    if (scale.modeAuto) {
      const rec = parseRecord([line]);
      if (rec) latestRecord = rec;
      return;
    }
    buffer.push(line);
    if (line.trim().startsWith('PCS:')) {
      const rec = parseRecord(buffer);
      buffer = [];
      if (rec) latestRecord = rec;
    }
  });
}

function parseRecord(lines) {
  const txt = lines.join('\n');
  const sn = /SN\.(\d+)/.exec(txt)?.[1];
  const net = /NET:\s*([-\d.]+)\s*kg/i.exec(txt)?.[1];
  const uw  = /U\/W:\s*([-\d.]+)\s*g/i.exec(txt)?.[1];
  const pcs = /PCS:\s*(\d+)/i.exec(txt)?.[1];
  if (!(sn && net && uw && pcs)) return null;
  return {
    timestamp: new Date().toISOString(),
    serial_no: parseInt(sn, 10),
    net_kg: parseFloat(net),
    unit_weight_g: parseFloat(uw),
    pcs: parseInt(pcs, 10)
  };
}

async function getScale() {
  if (!latestRecord) throw new Error('No scale data available');
  return latestRecord;
}

// ---------------- PRINTING ----------------
async function handlePrintJob(printData) {
  const { printerType, tspl, escpos, printerIP, labelData } = printData || {};
  try {
    if (!printerType) throw new Error('printerType required');
    if (printerType === 'tsc') {
      const file = path.join(__dirname, `tsc_${Date.now()}.txt`);
      await fs.promises.writeFile(file, labelData || tspl || '', 'ascii');
      if (!printer.tscShareName) throw new Error('printer.tscShareName not configured');
      const cmd = `copy /b "${file}" \\\\localhost\\${printer.tscShareName}`;
      execSync(cmd, { stdio: 'inherit', shell: true });
      fs.unlink(file, () => {});
      return { success: true, message: 'TSC label printed' };
    }

    if (printerType === 'hprt') {
      const finalData = escpos ? Buffer.from(escpos, 'binary') : null;
      if (!finalData) throw new Error('No ESC/POS data provided');

      const ip = printerIP || printer.hprtIp;
      if (ip) {
        const client = new net.Socket();
        return new Promise((resolve, reject) => {
          client.connect(9100, ip, () => {
            client.write(finalData);
            client.end();
          });
          client.on('close', () => resolve({ success: true, message: `HPRT sent via TCP:${ip}` }));
          client.on('error', err => reject(err));
        });
      } else {
        if (!printer.hprtShareName) throw new Error('printer.hprtShareName not configured');
        const file = path.join(__dirname, `hprt_${Date.now()}.bin`);
        await fs.promises.writeFile(file, finalData);
        const cmd = `copy /b "${file}" \\\\localhost\\${printer.hprtShareName}`;
        execSync(cmd, { stdio: 'inherit', shell: true });
        fs.unlink(file, () => {});
        return { success: true, message: 'HPRT label printed' };
      }
    }

    throw new Error('Unknown printer type');
  } catch (err) {
    console.error('[PRINT] error', err.message);
    return { success: false, error: err.message };
  }
}

// ---------------- RELAY CONNECTION ----------------
let ws;
let hb;
function connectRelay() {
  if (!relayUrl) {
    console.warn('[RELAY] relayUrl not configured; skipping relay connection.');
    return;
  }

  ws = new WebSocket(relayUrl);

  ws.on('open', () => {
    console.log('🔗 Connected to relay', relayUrl);
    // Send a richer register that includes local-config; relay can ignore extra fields if it wants
    const localConfig = buildLocalConfig();
    ws.send(JSON.stringify({ type: 'register', agentId, localConfig }));
    hb = setInterval(() => {
      try { ws.ping(); } catch (e) { /* ignore */ }
    }, 20000);
  });

  ws.on('message', async msg => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (err) {
      console.warn('[RELAY] invalid JSON message', err.message);
      return;
    }

    // print job command
    if (data.type === 'print') {
      const res = await handlePrintJob(data.printData);
      try { ws.send(JSON.stringify({ type: 'print_result', agentId, ...res })); } catch (e) {}
    }

    // get scale reading
    if (data.type === 'get_scale' && data.requestId) {
      try {
        const r = await getScale();
        ws.send(JSON.stringify({ type: 'scale_reading', requestId: data.requestId, reading: r, agentId }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'scale_reading', requestId: data.requestId, error: err.message, agentId }));
      }
    }

    // example: release bins proxy to internal production API
    if (data.type === 'release_bins_request' && data.requestId) {
      try {
        const resp = await axios.post('http://10.0.100.15:51554/api/Production/UpdateListMaterialRelease',
          data.payload, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
        ws.send(JSON.stringify({ type: 'release_bins_response', requestId: data.requestId, success: true, data: resp.data, agentId }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'release_bins_response', requestId: data.requestId, success: false, error: err.message, agentId }));
      }
    }

    // agent_http: relay asks this agent to make a local HTTP call and return result
    if (data.type === 'agent_http' && data.requestId) {
      const { requestId, method = 'GET', path: reqPath = '', headers = {}, body: forwardedBody } = data;
      try {
        if (typeof reqPath !== 'string' || reqPath.match(/^\s*https?:\/\//i)) {
          throw new Error('Invalid path');
        }

        const cleanPath = reqPath.replace(/^\/+/, '');
        const localUrl = `http://localhost:${localHttpPort}/${cleanPath}`.replace(/([^:]\/)\/+/g, '$1');

        console.log(`[AGENT] agent_http -> ${method} ${localUrl} (reqId=${requestId})`);

        const forwardHeaders = Object.assign({}, headers);
        // sanitize headers
        delete forwardHeaders.host;
        delete forwardHeaders.connection;
        delete forwardHeaders['content-length'];

        const axiosRes = await axios({
          url: localUrl,
          method,
          headers: forwardHeaders,
          data: forwardedBody,
          timeout: 7000,
          responseType: 'arraybuffer',
          validateStatus: () => true
        });

        const resHeaders = axiosRes.headers || {};
        const buffer = Buffer.from(axiosRes.data || []);
        let responseBody;
        try {
          const txt = buffer.toString('utf8');
          responseBody = JSON.parse(txt);
        } catch (e) {
          responseBody = buffer.toString('base64');
          resHeaders['x-content-base64'] = '1';
        }

        ws.send(JSON.stringify({
          type: 'agent_http_response',
          requestId,
          status: axiosRes.status || 200,
          headers: resHeaders,
          body: responseBody,
          agentId
        }));
        console.log(`[AGENT] agent_http_response reqId=${requestId} status=${axiosRes.status}`);
      } catch (err) {
        console.error('[AGENT] agent_http error', err.message);
        try {
          ws.send(JSON.stringify({
            type: 'agent_http_response',
            requestId,
            status: err.response?.status || 500,
            headers: err.response?.headers || {},
            body: { error: err.message },
            agentId
          }));
        } catch (e) {}
      }
    }
  });

  ws.on('close', () => {
    console.log('❌ Relay disconnected, retry in 5s');
    clearInterval(hb);
    setTimeout(connectRelay, 5000);
  });

  ws.on('error', e => {
    console.error('WS error', e?.message || e);
  });
}
connectRelay();

// ---------------- LOCAL HTTP ENDPOINTS ----------------

function buildLocalConfig() {
  const base = {
    agentId,
    localHttpPort,
    scale: Object.assign({}, scale),
    printer: Object.assign({}, printer),
    version: packageJson.version || null,
    timestamp: new Date().toISOString()
  };
  return base;
}

app.get('/local-config', (req, res) => {
  try {
    // Log origin for debugging
    console.log('[HTTP] /local-config requested. Origin:', req.headers.origin);

    let cfg = {};
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      try { cfg = JSON.parse(raw); } catch (e) { cfg = {}; }
    }
    // normalize return fields
    const normalized = Object.assign({}, cfg);
    normalized.agentId = normalized.agentId || agentId;
    normalized.localHttpPort = normalized.localHttpPort || localHttpPort;
    normalized.scale = normalized.scale || scale || {};
    normalized.printer = normalized.printer || printer || {};
    normalized.version = normalized.version || packageJson.version || null;
    normalized.lastSeen = new Date().toISOString();

    // Ensure CORS headers set for this response (in case some upstream middleware altered)
    const origin = req.headers.origin;
    if (origin && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', 'null');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

    res.json({ success: true, config: normalized });
  } catch (err) {
    // set headers on error responses as well
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/ping', (req, res) => {
  res.json({ ok: true, agentId, timestamp: new Date().toISOString() });
});

app.get('/info', (req, res) => {
  res.json({
    agentId,
    localHttpPort,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/get_weight', async (req, res) => {
  try {
    const r = await getScale();
    res.json(r);
  } catch (err) {
    res.status(204).end();
  }
});

app.post('/print-label', async (req, res) => {
  const result = await handlePrintJob(req.body);
  res.json(result);
});

app.listen(localHttpPort, () => {
  console.log(`✅ Agent ready on http://localhost:${localHttpPort} as ${agentId}`);
});