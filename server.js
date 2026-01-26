// ========================= IMPORTS =========================
const express = require('express');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const cors = require('cors');
// ========================= CONFIG =========================
const cfgPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('config.json missing');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const agentId = config.agentId;
const scaleCfg = config.scale || {};
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
const weighQueue = [];
const MAX_QUEUE = 5;

let scaleState = 'IDLE';       // IDLE | WAITING_UI | ERROR
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

    // End of one operator-confirmed weighing
    if (line.trim().startsWith('PCS:')) {
      const rec = parseRecord(buffer);
      buffer = [];
      if (!rec) return;

      const event = {
        eventId: `evt_${Date.now()}`,
        ...rec,
        receivedAt: Date.now(),
        consumed: false
      };

      weighQueue.push(event);
      if (weighQueue.length > MAX_QUEUE) weighQueue.shift();

      scaleState = 'WAITING_UI';
      scaleReason = 'operator confirmed weight';

      audit({ type: 'WEIGH_EVENT_CREATED', event });

      console.log('[SCALE] event created', event.eventId);
    }
  });
}

// ========================= AUTO-EXPIRE =========================
setInterval(() => {
  const now = Date.now();
  for (const e of weighQueue) {
    if (!e.consumed && now - e.receivedAt > 15000) {
      e.consumed = true;
      audit({ type: 'WEIGH_EVENT_EXPIRED', eventId: e.eventId });
    }
  }
}, 2000);

// ========================= HTTP API =========================
app.get('/local-config', (req, res) => {
  res.json({
    terminalId: agentId,
    capabilities: {
      scale: true
    },
    endpoints: {
      scaleStatus: '/scale/status',
      scaleConsume: '/scale/consume'
    },
    agent: {
      uptimeSec: Math.floor(process.uptime())
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/scale/status', (req, res) => {
  const last = weighQueue.at(-1);
  res.json({
    terminalId: agentId,
    state: scaleState,
    reason: scaleReason,
    queueDepth: weighQueue.filter(e => !e.consumed).length,
    lastRawAgeMs: lastRawAt ? Date.now() - lastRawAt : null,
    lastEventAgeMs: last ? Date.now() - last.receivedAt : null
  });
});

app.post('/scale/consume', (req, res) => {
  const evt = weighQueue.find(e => !e.consumed);

  if (!evt) {
    scaleState = 'IDLE';
    scaleReason = 'waiting for operator';

    audit({ type: 'WEIGH_CONSUME_FAILED', reason: 'NO_EVENT' });

    return res.status(409).json({
      status: 'NO_EVENT',
      reason: 'operator has not pressed scale button'
    });
  }

  evt.consumed = true;
  scaleState = 'IDLE';
  scaleReason = 'waiting for next weigh';

  audit({ type: 'WEIGH_CONSUMED', event: evt });

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

app.get('/audit/recent', (req, res) => {
  if (!fs.existsSync(AUDIT_LOG)) return res.json([]);
  const lines = fs.readFileSync(AUDIT_LOG, 'utf8')
    .trim().split('\n').slice(-50);
  res.json(lines.map(l => JSON.parse(l)));
});

// ========================= RELAY (STATUS ONLY) =========================
let ws;
function connectRelay() {
  if (!relayUrl) return;
  ws = new WebSocket(relayUrl);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'register', agentId }));
  });

  ws.on('close', () => setTimeout(connectRelay, 5000));
}
connectRelay();

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'scale_status',
      agentId,
      payload: {
        state: scaleState,
        queueDepth: weighQueue.filter(e => !e.consumed).length
      }
    }));
  }
}, 500);

// ========================= START =========================
app.listen(PORT, () => {
  console.log(`✅ Agent ${agentId} running on http://localhost:${PORT}`);
});