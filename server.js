const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');

const { spawn, execSync } = require('child_process');

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
let PRINTER_SHARE_NAME = 'TSC_TE200'; // <-- Update if needed
// const PRINTER_SHARE_NAME = 'HPRT_TP805L'; // <-- Update if needed
const DEFAULT_HPRT_IP = '192.168.1.88'; // Optional: default wireless printer IP
const SCALE_SCRIPT = path.join(__dirname, 'scale_service.py');
const VENV_DIR = path.join(__dirname, 'venv');
const REQUIREMENTS_FILE = path.join(__dirname, 'requirements.txt');

// ---------- WEBSOCKET CONFIG ----------
const AGENT_ID = 'warehouse-printer-001'; // Unique ID for this agent
const RELAY_SERVER_WS = 'ws://ec2-43-216-11-51.ap-southeast-5.compute.amazonaws.com:8080';

// ---------- PYTHON ENV SETUP ----------
if (!fs.existsSync(VENV_DIR)) {
  console.log('[Python] Creating virtual environment...');
  execSync(`python -m venv venv`, { cwd: __dirname, stdio: 'inherit' });
}

console.log('[Python] Installing dependencies...');
const pipCmd = process.platform === 'win32'
  ? path.join(VENV_DIR, 'Scripts', 'pip')
  : path.join(VENV_DIR, 'bin', 'pip');
execSync(`"${pipCmd}" install -r requirements.txt`, { cwd: __dirname, stdio: 'inherit' });

console.log('[Scale] Starting scale_service.py...');
const pythonCmd = process.platform === 'win32'
  ? path.join(VENV_DIR, 'Scripts', 'python')
  : path.join(VENV_DIR, 'bin', 'python');
const scaleProcess = spawn(`"${pythonCmd}"`, [SCALE_SCRIPT], {
  cwd: __dirname,
  shell: true
});
scaleProcess.stdout.on('data', (data) => console.log(`[Scale] ${data}`));
scaleProcess.stderr.on('data', (data) => console.error(`[Scale ERROR] ${data}`));
scaleProcess.on('exit', (code) => console.log(`[Scale] Python process exited with code ${code}`));

// ---------- WEBSOCKET PRINT HANDLER ----------
async function handleWebSocketPrintJob(printData) {
  const { printerType, tspl, escpos, printerIP, labelData } = printData;

  console.log(`📄 Received WebSocket print job: ${printerType}`);

  try {
    if (printerType === 'tsc') {
      PRINTER_SHARE_NAME = 'TSC_TE200';

      if (!labelData) throw new Error('Missing TSPL data');

      const file = path.join(__dirname, `tsc_${Date.now()}.txt`);
      await fs.promises.writeFile(file, labelData, 'ascii');
      const printCmd = `copy /b "${file}" \\\\localhost\\${PRINTER_SHARE_NAME}`;
      execSync(printCmd, { stdio: 'inherit', shell: true });
      fs.unlink(file, () => { });

      console.log('✅ TSC print job completed via WebSocket');
      return { success: true, message: 'TSC label sent to printer.' };
    }

    if (printerType === 'hprt') {
      PRINTER_SHARE_NAME = 'HPRT_TP805L';
      let finalData;

      if (labelData) {
        const imagePath = await generateLabelImageFromData(labelData);
        finalData = await convertImageToEscposRaster(imagePath);
        fs.unlink(imagePath, () => { });
      } else if (escpos) {
        finalData = Buffer.isBuffer(escpos) ? escpos : Buffer.from(escpos, 'binary');
      } else {
        throw new Error('Missing ESC/POS or labelData');
      }

      if (printerIP) {
        const client = new net.Socket();
        client.connect(9100, printerIP, () => {
          client.write(finalData);
          client.end();
        });
        client.on('error', (err) => {
          throw new Error(`TCP print failed: ${err.message}`);
        });
      } else {
        const file = path.join(__dirname, `hprt_${Date.now()}.bin`);
        await fs.promises.writeFile(file, finalData);
        const printCmd = `copy /b "${file}" \\\\localhost\\${PRINTER_SHARE_NAME}`;
        execSync(printCmd, { stdio: 'inherit', shell: true });
        fs.unlink(file, () => { });
      }

      console.log('✅ HPRT print job completed via WebSocket');
      return { success: true, message: 'HPRT label sent to printer.' };
    }

    throw new Error('Unknown printer type');

  } catch (error) {
    console.error('❌ WebSocket print job failed:', error);
    return { success: false, error: error.message };
  }
}

// ---------- WEBSOCKET CONNECTION ----------
let ws;

function connectToRelay() {
  ws = new WebSocket(RELAY_SERVER_WS);

  ws.on('open', () => {
    console.log('🔗 Connected to relay server');
    // Register this agent
    ws.send(JSON.stringify({
      type: 'register',
      agentId: AGENT_ID
    }));
  });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'registered') {
        console.log(`✅ Successfully registered as: ${data.agentId}`);
      }

      if (data.type === 'print') {
        const result = await handleWebSocketPrintJob(data.printData);
        ws.send(JSON.stringify({
          type: 'print_result',
          success: result.success,
          message: result.message,
          error: result.error
        }));
      }

      if (data.type === 'get_scale' && data.requestId) {
        console.log("getting scale ws")
        try {
          const weight = await getScaleReading();
          console.log(weight);
          ws.send(JSON.stringify({
            type: 'scale_reading',
            requestId: data.requestId,
            reading: weight
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'scale_reading',
            requestId: data.requestId,
            error: err.message
          }));
        }
      }

    } catch (error) {
      console.error('❌ WebSocket message error:', error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          error: error.message
        }));
      }
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket disconnected, reconnecting in 5s...');
    setTimeout(connectToRelay, 5000);
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
}

// ---------- HTTP ENDPOINT (OPTIONAL - for backward compatibility) ----------
app.post('/print-label', async (req, res) => {
  const { printerType, tspl, escpos, printerIP, labelData } = req.body;

  console.log("Printing via HTTP: " + printerType);
  try {
    if (printerType === 'tsc') {
      PRINTER_SHARE_NAME = 'TSC_TE200';

      if (!labelData) return res.status(400).json({ success: false, error: 'Missing TSPL data.' });

      const file = path.join(__dirname, `tsc_${Date.now()}.txt`);
      await fs.promises.writeFile(file, labelData, 'ascii');
      const printCmd = `copy /b "${file}" \\\\localhost\\${PRINTER_SHARE_NAME}`;
      execSync(printCmd, { stdio: 'inherit', shell: true });
      fs.unlink(file, () => { });
      return res.json({ success: true, message: 'TSC label sent to printer.' });
    }

    if (printerType === 'hprt') {
      let finalData;
      PRINTER_SHARE_NAME = 'HPRT_TP805L';

      if (labelData) {
        const imagePath = await generateLabelImageFromData(labelData);
        finalData = await convertImageToEscposRaster(imagePath);
        fs.unlink(imagePath, () => { });
      } else if (escpos) {
        finalData = Buffer.isBuffer(escpos) ? escpos : Buffer.from(escpos, 'binary');
      } else {
        return res.status(400).json({ success: false, error: 'Missing ESC/POS or labelData.' });
      }

      if (printerIP) {
        const client = new net.Socket();
        client.connect(9100, printerIP, () => {
          client.write(finalData);
          client.end();
        });
        client.on('error', (err) => {
          console.error('[Print ERROR] TCP:', err);
          return res.status(500).json({ success: false, error: 'TCP print failed' });
        });
        return res.json({ success: true, message: 'HPRT label sent via TCP.' });
      } else {
        const file = path.join(__dirname, `hprt_${Date.now()}.bin`);
        await fs.promises.writeFile(file, finalData);
        const printCmd = `copy /b "${file}" \\\\localhost\\${PRINTER_SHARE_NAME}`;
        execSync(printCmd, { stdio: 'inherit', shell: true });
        fs.unlink(file, () => { });
        return res.json({ success: true, message: 'HPRT label sent to shared printer.' });
      }
    }

    return res.status(400).json({ success: false, error: 'Unknown printer type.' });
  } catch (err) {
    console.error('[Print ERROR]', err);
    return res.status(500).json({ success: false, error: 'Printing failed.' });
  }
});

// ---------- SERVER ----------
const PORT = 9999;
app.listen(PORT, () => {
  console.log(`\n✅ Print agent running on http://localhost:${PORT}`);
  console.log('🔗 Connecting to relay server...');
  connectToRelay();
});