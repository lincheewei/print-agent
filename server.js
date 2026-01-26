// ========================= IMPORTS =========================
const express = require('express');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const cors = require('cors');
const fetch = global.fetch || require("node-fetch");
// ========================= CONFIG =========================
const cfgPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('config.json missing');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const agentId = config.agentId;
const scaleCfg = config.scale || {};
const printerCfg = config.printer || {};
const relayUrl = config.relayUrl || null;
const PORT = config.localHttpPort || 9000;

const AUDIT_LOG = path.join(__dirname, 'audit.log.jsonl');

// ========================= APP =========================
const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// ========================= AUDIT =========================
function audit(entry) {
  fs.appendFile(
    AUDIT_LOG,
    JSON.stringify({
      ts: new Date().toISOString(),
      agentId,
      ...entry
    }) + '\n',
    () => { }
  );
}

// ========================= SCALE STATE =========================
let currentEvent = null;     // 🔥 ONLY ONE EVENT
let scaleState = 'IDLE';     // IDLE | WAITING_UI | ERROR
let scaleReason = 'waiting for operator';
let lastRawAt = null;

// ========================= SERIAL =========================
let buffer = [];
let port, parser;

function openScale() {
  try {
    port = new SerialPort({
      path: scaleCfg.port,
      baudRate: scaleCfg.baud || 9600,
      autoOpen: false
    });

    parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    port.open(err => {
      if (err) {
        scaleState = 'ERROR';
        scaleReason = err.message;
        console.error('[SCALE]', err.message);
        setTimeout(openScale, 3000);
      } else {
        scaleState = 'IDLE';
        scaleReason = 'connected';
        console.log('[SCALE] connected on', scaleCfg.port);
      }
    });

    port.on('close', () => {
      scaleState = 'ERROR';
      scaleReason = 'port closed';
      setTimeout(openScale, 3000);
    });

    port.on('error', err => {
      scaleState = 'ERROR';
      scaleReason = err.message;
    });

  } catch (e) {
    console.error('[SCALE] init failed', e.message);
  }
}

openScale();

// ========================= PARSER =========================
function parseRecord(lines) {
  const txt = lines.join('\n');
  const net = /NET:\s*([-\d.]+)\s*kg/i.exec(txt)?.[1];
  const uw = /U\/W:\s*([-\d.]+)\s*g/i.exec(txt)?.[1];
  const pcs = /PCS:\s*(\d+)/i.exec(txt)?.[1];
  if (!(net && uw && pcs)) return null;

  return {
    net_kg: Number(net),
    unit_weight_g: Number(uw),
    pcs: Number(pcs)
  };
}

if (parser) {
  parser.on('data', line => {
    buffer.push(line);
    lastRawAt = Date.now();

    if (line.trim().startsWith('PCS:')) {
      const rec = parseRecord(buffer);
      buffer = [];
      if (!rec) return;

      // 🔥 OVERWRITE previous event
      currentEvent = {
        eventId: `evt_${Date.now()}`,
        ...rec,
        receivedAt: Date.now(),
        consumed: false
      };

      scaleState = 'WAITING_UI';
      scaleReason = 'operator confirmed weight';

      audit({ type: 'WEIGH_EVENT_UPDATED', event: currentEvent });
      console.log('[SCALE] latest event updated', currentEvent.eventId);
    }
  });
}

// ========================= AUTO EXPIRE =========================
setInterval(() => {
  if (
    currentEvent &&
    !currentEvent.consumed &&
    Date.now() - currentEvent.receivedAt > 15000
  ) {
    audit({
      type: 'WEIGH_EVENT_EXPIRED',
      eventId: currentEvent.eventId
    });

    currentEvent = null;
    scaleState = 'IDLE';
    scaleReason = 'waiting for operator';
  }
}, 2000);

// ========================= HTTP API =========================
app.get('/local-config', (req, res) => {
  res.json({
    terminalId: agentId,
    capabilities: {
      scale: true,
      printer: !!printerCfg
    },
    endpoints: {
      scaleStatus: '/scale/status',
      scaleConsume: '/scale/consume',
      printerStatus: '/printer/status'
    },
    agent: {
      uptimeSec: Math.floor(process.uptime())
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/scale/status', (req, res) => {
  res.json({
    terminalId: agentId,
    state: scaleState,
    reason: scaleReason,
    hasEvent: !!currentEvent,
    lastRawAgeMs: lastRawAt ? Date.now() - lastRawAt : null,
    lastEventAgeMs: currentEvent
      ? Date.now() - currentEvent.receivedAt
      : null
  });
});

app.post('/scale/consume', (req, res) => {
  if (!currentEvent || currentEvent.consumed) {
    scaleState = 'IDLE';
    scaleReason = 'waiting for operator';

    audit({ type: 'WEIGH_CONSUME_FAILED', reason: 'NO_EVENT' });

    return res.status(409).json({
      status: 'NO_EVENT',
      reason: 'no scale reading available'
    });
  }

  const evt = currentEvent;
  evt.consumed = true;

  audit({ type: 'WEIGH_CONSUMED', event: evt });

  currentEvent = null;
  scaleState = 'IDLE';
  scaleReason = 'waiting for next weigh';

  res.json({
    status: 'OK',
    event: {
      eventId: evt.eventId,
      net_kg: evt.net_kg,
      pcs: evt.pcs,
      unit_weight_g: evt.unit_weight_g,
      timestamp: evt.receivedAt
    }
  });
});

// ========================= PRINTER STATUS =========================
app.get('/printer/status', (req, res) => {
  if (!printerCfg || Object.keys(printerCfg).length === 0) {
    return res.json({
      terminalId: agentId,
      connected: false,
      reason: 'printer not configured'
    });
  }

  // 🔧 Placeholder for future OS-level probing
  res.json({
    terminalId: agentId,
    connected: true,
    printer: {
      name: printerCfg.name || printerCfg.tscShareName || printerCfg.hprtShareName || 'Unknown',
      type: printerCfg.type || 'unknown'
    },
    status: 'READY'
  });
});

app.get('/audit/recent', (req, res) => {
  if (!fs.existsSync(AUDIT_LOG)) return res.json([]);
  const lines = fs.readFileSync(AUDIT_LOG, 'utf8')
    .trim().split('\n').slice(-50);
  res.json(lines.map(l => JSON.parse(l)));
});

// ========================= RELAY (STATUS ONLY) =========================
// ========================= RELAY =========================
let ws;

function connectRelay() {
  if (!relayUrl) return;

  ws = new WebSocket(relayUrl);

  ws.on("open", () => {
    console.log("🔗 Connected to relay");
    ws.send(JSON.stringify({ type: "register", agentId }));
  });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 🔥 REQUIRED: handle HTTP proxy
    if (msg.type === "agent_http") {
      const { requestId, method, path, body } = msg;
      console.log("📥 agent_http:", method, path);

      try {
        const url = `http://127.0.0.1:${PORT}/${String(path).replace(/^\/+/, "")}`;

        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: method === "GET" ? undefined : JSON.stringify(body)
        });

        const data = await res.json().catch(() => null);

        ws.send(JSON.stringify({
          type: "agent_http_response",   // ✅ FIXED
          requestId,
          status: res.status,
          body: data
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: "agent_http_response",   // ✅ FIXED
          requestId,
          status: 500,
          body: { error: err.message }
        }));
      }
    }
  });

  ws.on("close", () => {
    console.log("❌ Relay disconnected, retrying...");
    setTimeout(connectRelay, 3000);
  });

  ws.on("error", () => {
    try { ws.close(); } catch { }
  });
}

connectRelay();

// ========================= START =========================
app.listen(PORT, () => {
  console.log(`✅ Agent ${agentId} running on http://localhost:${PORT}`);
});