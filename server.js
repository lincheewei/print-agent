// ========================= IMPORTS =========================
const express = require("express");
const fs = require("fs");
const path = require("path");
const net = require("net");
const WebSocket = require("ws");
const axios = require("axios");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { exec } = require("child_process");

// ========================= CONFIG =========================
const ROOT = __dirname;
const cfgPath = path.join(ROOT, "config.json");
const QUEUE_FILE = path.join(ROOT, "print-queue.json");

if (!fs.existsSync(cfgPath)) {
  console.error("❌ config.json missing");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const agentId = config.agentId;
const relayUrl = config.relayUrl;
const PORT = config.localHttpPort || 9000;
const scaleCfg = config.scale || {};
const printerCfg = config.printer || {};

const app = express();
app.use(express.json());

// ========================= UTIL =========================
function safeWrite(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function logScale(...args) {
  console.log("[SCALE]", ...args);
}

function logScaleError(...args) {
  console.error("[SCALE]", ...args);
}
function now() {
  return new Date().toISOString();
}

// ========================= PRINT QUEUE =========================
let printQueue = [];

function loadQueue() {
  if (fs.existsSync(QUEUE_FILE)) {
    try {
      printQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
    } catch {
      printQueue = [];
    }
  }
}

function saveQueue() {
  safeWrite(QUEUE_FILE, printQueue);
}

function enqueuePrint(job) {
  printQueue.push(job);
  saveQueue();
}

function updateJob(id, patch) {
  const j = printQueue.find(j => j.jobId === id);
  if (j) Object.assign(j, patch);
  saveQueue();
}

loadQueue();

// ========================= PRINTER PROBE =========================
function probePrinterStatus() {
  return new Promise((resolve) => {
    // ---------- guard ----------
    if (
      !printerCfg?.name &&
      !printerCfg?.tscShareName &&
      !printerCfg?.hprtShareName
    ) {
      return resolve({
        connected: false,
        status: "NOT_CONFIGURED",
      });
    }

    // Prefer explicit name → fallback to share names
    const printerId =
      printerCfg.name ||
      printerCfg.tscShareName ||
      printerCfg.hprtShareName;

    // ---------- PowerShell ----------
    // IMPORTANT:
    // - Try Name first
    // - Then resolve by ShareName
    // - Always probe using REAL printer Name
    const psCmd = `
$ErrorActionPreference = 'SilentlyContinue';

$printer = Get-Printer -Name '${printerId}';

if (-not $printer) {
  $printer = Get-Printer | Where-Object { $_.ShareName -eq '${printerId}' };
}

if (-not $printer) {
  Write-Output 'NOT_FOUND';
  exit
}

$jobs = Get-PrintJob -PrinterName $printer.Name;

$status = @{
  Name        = $printer.Name;
  ShareName  = $printer.ShareName;
  Online     = -not $printer.Offline;
  Paused     = $printer.Paused;
  Error      = ($printer.PrinterStatus -ne 'Normal');
  Queue      = ($jobs | Measure-Object).Count
};

$status | ConvertTo-Json -Compress
`.trim();

    // ---------- exec ----------
    exec(
      `powershell -NoProfile -Command "${psCmd.replace(/\r?\n/g, " ")}"`,
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) {
          return resolve({
            connected: false,
            status: "ERROR",
            reason: err?.message || "powershell_failed",
          });
        }

        if (stdout.includes("NOT_FOUND")) {
          return resolve({
            connected: false,
            status: "NOT_FOUND",
          });
        }

        try {
          const data = JSON.parse(stdout.trim());

          let status = "READY";
          if (!data.Online) status = "OFFLINE";
          else if (data.Paused) status = "PAUSED";
          else if (data.Error) status = "ERROR";

          resolve({
            connected: true,
            status,
            name: data.Name,
            shareName: data.ShareName,
            online: data.Online,
            paused: data.Paused,
            hasError: data.Error,
            queueDepth: data.Queue,
          });
        } catch {
          resolve({
            connected: false,
            status: "ERROR",
            reason: "json_parse_failed",
          });
        }
      }
    );
  });
}

// ========================= SCALE =========================
let scaleState = "DISCONNECTED";
let currentEvent = null;
let buffer = [];
let port, parser;

function parseRecord(lines) {
  logScale("Parsing record:", lines);

  const txt = lines.join("\n");

  const net = /NET:\s*([-\d.]+)\s*kg/i.exec(txt)?.[1];
  const pcs = /PCS:\s*(\d+)/i.exec(txt)?.[1];

  // Optional U/W (some scales do NOT send this)
  const uw =
    /U\/W:\s*([-\d.]+)\s*g/i.exec(txt)?.[1] ??
    /UNIT\s*W(T|EIGHT)?:\s*([-\d.]+)/i.exec(txt)?.[2] ??
    null;

  if (!(net && pcs)) {
    logScaleError("Parse failed (missing NET or PCS)", { net, pcs });
    return null;
  }

  const record = {
    net_kg: Number(net),
    pcs: Number(pcs),
    unit_weight_g: uw !== null ? Number(uw) : null,
    receivedAt: Date.now(),
  };

  logScale("Parsed OK:", record);
  return record;
}

function openScale() {
  if (!scaleCfg.port) {
    logScale("No scale.port configured");
    return;
  }

  logScale(
    `Initializing scale on ${scaleCfg.port} @ ${scaleCfg.baud || 9600} baud`
  );

  port = new SerialPort({
    path: scaleCfg.port,
    baudRate: scaleCfg.baud || 9600,
    autoOpen: false,
  });

  parser = port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

  port.open(err => {
    if (err) {
      scaleState = "ERROR";
      logScaleError("Failed to open port:", err.message);
      setTimeout(openScale, 3000);
    } else {
      scaleState = "IDLE";
      logScale("Serial port opened successfully");
    }
  });

  port.on("error", err => {
    scaleState = "ERROR";
    logScaleError("Serial port error:", err.message);
  });

  port.on("close", () => {
    scaleState = "ERROR";
    logScaleError("Serial port closed unexpectedly, retrying...");
    setTimeout(openScale, 3000);
  });

  // 🔥 RAW DATA LOGGING
  port.on("data", buf => {
    logScale("RAW BUFFER:", buf.toString("hex"), "ASCII:", buf.toString());
  });

  // 🔥 PARSED LINE LOGGING
  parser.on("data", line => {
    logScale("LINE:", JSON.stringify(line));

    buffer.push(line);

    // Adjust trigger if needed
    if (line.trim().startsWith("PCS:")) {
      logScale("End-of-record detected");
      const rec = parseRecord(buffer);
      buffer = [];

      if (!rec) {
        logScaleError("Parse failed, raw record:", buffer);
        return;
      }

      currentEvent = { ...rec, consumed: false };
      scaleState = "WAITING_UI";

      logScale("Parsed record:", currentEvent);
    }
  });
}

openScale();

// ========================= PRINTING =========================

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
      fs.unlink(file, () => { });
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
        fs.unlink(file, () => { });
        return { success: true, message: 'HPRT label printed' };
      }
    }

    throw new Error('Unknown printer type');
  } catch (err) {
    console.error('[PRINT] error', err.message);
    return { success: false, error: err.message };
  }
}
async function sendToPrinter(job) {
  return new Promise((resolve, reject) => {
    try {
      if (job.type === "hprt" && printerCfg.hprtIp) {
        const client = new net.Socket();
        client.connect(9100, printerCfg.hprtIp, () => {
          client.write(Buffer.from(job.data, "binary"));
          client.end();
        });
        client.on("close", () => resolve());
        client.on("error", reject);
      } else if (job.type === "tsc" && printerCfg.tscShareName) {
        const tmp = path.join(ROOT, `print_${job.jobId}.txt`);
        fs.writeFileSync(tmp, job.data, "ascii");
        exec(`copy /b "${tmp}" \\\\localhost\\${printerCfg.tscShareName}`, err => {
          fs.unlinkSync(tmp);
          err ? reject(err) : resolve();
        });
      } else {
        reject(new Error("Printer not configured"));
      }
    } catch (e) {
      reject(e);
    }
  });
}

// ========================= PRINT WORKER =========================
setInterval(async () => {
  const job = printQueue.find(j => j.status === "QUEUED");
  if (!job) return;

  updateJob(job.jobId, { status: "PRINTING" });

  try {
    console.log("🖨️ PRINT JOB START", job.jobId, job.printerType);

    const result = await handlePrintJob({
      printerType: job.printerType,
      labelData: job.labelData,
      escpos: job.escpos
    });

    if (!result.success) throw new Error(result.error);

    updateJob(job.jobId, {
      status: "SUCCESS",
      finishedAt: now()
    });

    console.log("✅ PRINT SUCCESS", job.jobId);

  } catch (e) {
    console.error("❌ PRINT FAILED", job.jobId, e.message);

    job.retries++;
    updateJob(job.jobId, {
      status: job.retries >= 3 ? "FAILED" : "QUEUED",
      lastError: e.message
    });
  }
}, 2000);

// ========================= HTTP API =========================
app.get("/printer/status", async (req, res) => {
  const status = await probePrinterStatus();
  res.json({
    terminalId: agentId,
    printer: printerCfg?.name || printerCfg?.tscShareName || "Unknown",
    ...status,
    timestamp: new Date().toISOString()
  });
});

app.get("/health", async (req, res) => {
  const printer = await probePrinterStatus();

  const scaleHealthy =
    scaleState === "IDLE" ||
    scaleState === "WAITING_UI";

  const printerHealthy =
    printer.connected === true &&
    printer.status === "READY";

  const relayHealthy = relayConnected === true;

  const ok =
    relayHealthy &&
    printerHealthy &&
    scaleHealthy;

  res.json({
    ok, // 👈 REAL health
    agentId,
    uptime: process.uptime(),

    relay: {
      connected: relayConnected,
      url: relayUrl
    },

    printer,

    scale: {
      state: scaleState
    },

    queue: {
      total: printQueue.length,
      pending: printQueue.filter(j => j.status === "QUEUED").length
    },

    timestamp: now()
  });
});

app.post("/print-label", (req, res) => {
  const { printerType, labelData, escpos } = req.body;

  if (!printerType) {
    return res.status(400).json({
      success: false,
      error: "printerType required"
    });
  }

  const jobId = `job_${Date.now()}`;

  enqueuePrint({
    jobId,
    status: "QUEUED",
    retries: 0,
    createdAt: now(),

    // ✅ NORMALIZED FIELDS
    printerType,           // "tsc" | "hprt"
    labelData,             // TSPL
    escpos                 // optional
  });

  res.json({ success: true, jobId });
});

app.get("/print/status/:jobId", (req, res) => {
  const job = printQueue.find(j => j.jobId === req.params.jobId);
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(job);
});

app.get("/scale/status", (req, res) => {
  logScale("Status requested:", {
    state: scaleState,
    hasEvent: !!currentEvent,
  });

  res.json({
    state: scaleState,
    hasEvent: !!currentEvent,
  });
});

app.post("/scale/consume", (req, res) => {
  if (!currentEvent || currentEvent.consumed) {
    logScale("Consume rejected: NO_EVENT");
    return res.status(409).json({ error: "NO_EVENT" });
  }

  logScale("Consumed event:", currentEvent);

  currentEvent.consumed = true;
  const evt = currentEvent;
  currentEvent = null;
  scaleState = "IDLE";

  res.json({ success: true, event: evt });
});
// ========================= LOCAL CONFIG =========================
app.get("/local-config", (req, res) => {
  res.json({
    agentId,
    localHttpPort: PORT,

    scale: {
      enabled: !!scaleCfg.port,
      port: scaleCfg.port || null,
      baud: scaleCfg.baud || null,
    },

    printer: {
      configured: !!(
        printerCfg?.name ||
        printerCfg?.tscShareName ||
        printerCfg?.hprtShareName
      ),
      name:
        printerCfg.name ||
        printerCfg.tscShareName ||
        printerCfg.hprtShareName ||
        null,
      type: printerCfg.hprtIp ? "hprt" : "tsc",
    },

    relay: {
      url: relayUrl,
      connected: relayConnected,
    },

    version: config.version || null,
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ========================= RELAY =========================
// ========================= RELAY =========================
let ws = null;
let relayConnected = false;
let reconnectTimer = null;
let shuttingDown = false;

function connectRelay() {
  if (!relayUrl) {
    console.warn("[RELAY] relayUrl not configured");
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return; // already connected or connecting
  }

  console.log("[RELAY] Connecting to", relayUrl);

  try {
    ws = new WebSocket(relayUrl);

    ws.on("open", () => {
      relayConnected = true;
      console.log("🔗 Relay connected");

      ws.send(JSON.stringify({
        type: "register",
        agentId
      }));
    });

    ws.on("message", async raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // ---- HTTP proxy ----
      if (msg.type === "agent_http") {
        const url = `http://127.0.0.1:${PORT}/${String(msg.path || "").replace(/^\/+/, "")}`;

        try {
          const r = await axios({
            method: msg.method || "GET",
            url,
            data: msg.body,
            timeout: 8000,
            validateStatus: () => true
          });

          ws?.send(JSON.stringify({
            type: "agent_http_response",
            requestId: msg.requestId,
            status: r.status,
            body: r.data
          }));
        } catch (e) {
          ws?.send(JSON.stringify({
            type: "agent_http_response",
            requestId: msg.requestId,
            status: 500,
            body: { error: e.message }
          }));
        }
      }
    });

    // 🔥 CRITICAL: NEVER THROW
    ws.on("error", err => {
      relayConnected = false;
      console.error("❌ Relay socket error:", err.message);
      // DO NOT throw — close event will trigger reconnect
    });

    ws.on("close", () => {
      relayConnected = false;
      console.warn("⚠️ Relay disconnected");

      if (shuttingDown) return;
      scheduleReconnect();
    });

  } catch (err) {
    console.error("[RELAY] connect failed:", err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer || shuttingDown) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRelay();
  }, 5000); // retry every 5s
}

connectRelay();

// ========================= START =========================
app.listen(PORT, () => {
  console.log(`✅ Agent ${agentId} running on http://localhost:${PORT}`);
});


process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  shuttingDown = true;
  console.log("🛑 Shutting down agent");

  try { ws?.close(); } catch { }
  process.exit(0);
}