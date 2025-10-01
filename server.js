const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { execSync } = require('child_process');
const axios = require('axios'); // add to top if not already
// Load configuration
const config = require('./config.json');
const { agentId, relayUrl, scale, printer, localHttpPort } = config;
const CONFIG_PUSH_URL = `${relayUrl.replace('ws://', 'http://').replace('wss://', 'https://')}/api/agent-config`;
const API_KEY = process.env.AGENT_API_KEY || null; // set securely in production

const app = express();
app.use(express.json());



// ---------------- SCALE ----------------
let latestRecord = null;
const port = new SerialPort({ path: scale.port, baudRate: scale.baud, autoOpen: false });
const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

port.open(err => {
  if (err) {
    console.error(`[SCALE] Failed to open ${scale.port}:`, err.message);
    return;
  }
  console.log(`[SCALE] ${scale.port} opened @ ${scale.baud} baud`);
});

let buffer = [];
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
  const { printerType, tspl, escpos, printerIP, labelData } = printData;
  try {
    if (printerType === 'tsc') {
      const file = path.join(__dirname, `tsc_${Date.now()}.txt`);
      await fs.promises.writeFile(file, labelData || tspl, 'ascii');
      const cmd = `copy /b "${file}" \\\\localhost\\${printer.tscShareName}`;
      execSync(cmd, { stdio: 'inherit', shell: true });
      fs.unlink(file, ()=>{});
      return { success: true, message: 'TSC label printed' };
    }

    if (printerType === 'hprt') {
      let finalData = escpos ? Buffer.from(escpos, 'binary') : null;
      if (!finalData) throw new Error('No ESC/POS data provided');

      if (printerIP || printer.hprtIp) {
        const ip = printerIP || printer.hprtIp;
        const client = new net.Socket();
        return new Promise((resolve, reject) => {
          client.connect(9100, ip, () => { client.write(finalData); client.end(); });
          client.on('close', () => resolve({ success: true, message: `HPRT sent via TCP:${ip}` }));
          client.on('error', err => reject(err));
        });
      } else {
        const file = path.join(__dirname, `hprt_${Date.now()}.bin`);
        await fs.promises.writeFile(file, finalData);
        const cmd = `copy /b "${file}" \\\\localhost\\${printer.hprtShareName}`;
        execSync(cmd, { stdio: 'inherit', shell: true });
        fs.unlink(file, ()=>{});
        return { success: true, message: 'HPRT label printed' };
      }
    }

    throw new Error('Unknown printer type');
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------------- RELAY CONNECTION ----------------
let ws, hb;
function connectRelay() {
  ws = new WebSocket(relayUrl);

  ws.on('open', () => {
    console.log('🔗 Connected to relay');
    ws.send(JSON.stringify({ type: 'register', agentId }));
    hb = setInterval(() => ws.ping(), 20000);
  });

  ws.on('message', async msg => {
    const data = JSON.parse(msg);
    if (data.type === 'print') {
      const res = await handlePrintJob(data.printData);
      ws.send(JSON.stringify({ type: 'print_result', ...res }));
    }
    if (data.type === 'get_scale' && data.requestId) {
      try {
        const r = await getScale();
        ws.send(JSON.stringify({ type: 'scale_reading', requestId: data.requestId, reading: r }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'scale_reading', requestId: data.requestId, error: err.message }));
      }
    }
    if (data.type === 'release_bins_request' && data.requestId) {
      try {
        const resp = await axios.post('http://10.0.100.15:51554/api/Production/UpdateListMaterialRelease',
          data.payload, { headers: { 'Content-Type': 'application/json' } });
        ws.send(JSON.stringify({ type: 'release_bins_response', requestId: data.requestId, success: true, data: resp.data }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'release_bins_response', requestId: data.requestId, success: false, error: err.message }));
      }
    }
  });

  ws.on('close', () => { console.log('❌ Relay disconnected, retry in 5s'); clearInterval(hb); setTimeout(connectRelay, 5000); });
  ws.on('error', e => console.error('WS error', e));
}
connectRelay();

// ---------------- LOCAL HTTP (optional) ----------------
app.get('/get_weight', async (req,res)=>{
  try { res.json(await getScale()); }
  catch (err) { res.status(204).end(); }
});

app.post('/print-label', async (req,res)=>{
  const result = await handlePrintJob(req.body);
  res.json(result);
});

app.listen(localHttpPort, ()=> console.log(`✅ Agent ready on http://localhost:${localHttpPort} as ${agentId}`));






// ---------------- PUSH LOCAL CONFIG TO SERVER ----------------
async function pushConfigToRelay(cfg) {
  // Try WS first (preferred)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'agent_config', action: 'push', agentId, config: cfg }));
    console.log('[CONFIG] Pushed via WS');
    return;
  }

  // Fallback to HTTP
  if (API_KEY) {
    try {
      await axios.post(CONFIG_PUSH_URL, { agentId, config: cfg }, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        timeout: 5000
      });
      console.log('[CONFIG] Pushed via HTTP');
    } catch (err) {
      console.error('[CONFIG] HTTP push failed:', err.message);
    }
  }
}

// Push on startup
setTimeout(() => {
  pushConfigToRelay(config);
}, 2000); // wait a bit for WS to connect

// Watch for changes and re-push
fs.watchFile(path.resolve(__dirname, 'config.json'), { interval: 2000 }, () => {
  console.log('[CONFIG] File changed, re-pushing');
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    pushConfigToRelay(cfg);
  } catch (err) {
    console.error('[CONFIG] Failed to read/reload config:', err.message);
  }
});