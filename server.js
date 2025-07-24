const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');
const axios = require('axios');
const SerialPort = require('serialport');
const Readline = require('@serialport/parser-readline');

const { execSync } = require('child_process');

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
let PRINTER_SHARE_NAME = 'TSC_TE200';
const DEFAULT_HPRT_IP = '192.168.1.88';

// ---------- WEBSOCKET CONFIG ----------
const AGENT_ID = 'warehouse-printer-001';
const RELAY_SERVER_WS = 'ws://ec2-43-216-11-51.ap-southeast-5.compute.amazonaws.com:8080';

// ---------- SCALE CONFIG ----------
const SCALE_PORT = process.env.SCALE_COM || 'COM7';
const SCALE_BAUD = parseInt(process.env.SCALE_BAUD || '1200', 10);
const MODE_AUTO = false; // Set to true if your scale is in AUTO stream mode

let latestRecord = null;

// ---------- SCALE SETUP ----------
const port = new SerialPort(SCALE_PORT, {
  baudRate: SCALE_BAUD,
  autoOpen: false,
});

const parser = port.pipe(new Readline({ delimiter: '\r\n' }));

port.open((err) => {
  if (err) {
    console.error('[SCALE] Failed to open port:', err.message);
    console.log('[SCALE] Scale functionality will be disabled');
    return;
  }
  console.log(`[SCALE] Port ${SCALE_PORT} opened at ${SCALE_BAUD} baud`);
});

let buffer = [];

parser.on('data', (line) => {
  if (MODE_AUTO) {
    // AUTO mode: each frame is one line
    const record = parseTicket([line]);
    if (record) {
      latestRecord = record;
      console.log('[SCALE] New record:', latestRecord);
    }
    return;
  }

  // MANU-P mode: build a 4/5-line ticket ending with 'PCS:'
  buffer.push(line);
  if (line.trim().startsWith('PCS:')) {
    const record = parseTicket(buffer);
    buffer = [];
    if (record) {
      latestRecord = record;
      console.log('[SCALE] New record:', latestRecord);
    }
  }
});

function parseTicket(lines) {
  const joined = lines.join('\n');
  const snMatch = /SN\.(\d+)/.exec(joined);
  const netMatch = /NET:\s*([-\d.]+)\s*kg/i.exec(joined);
  const uwMatch = /U\/W:\s*([-\d.]+)\s*g/i.exec(joined);
  const pcsMatch = /PCS:\s*(\d+)/i.exec(joined);

  if (!(snMatch && netMatch && uwMatch && pcsMatch)) {
    return null;
  }

  return {
    timestamp: new Date().toISOString(),
    serial_no: parseInt(snMatch[1], 10),
    net_kg: parseFloat(netMatch[1]),
    unit_weight_g: parseFloat(uwMatch[1]),
    pcs: parseInt(pcsMatch[1], 10),
  };
}

// Function to get the latest scale reading
async function getScaleReading() {
  if (!latestRecord) {
    throw new Error('No scale data available');
  }
  return latestRecord;
}

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
      fs.unlink(file, () => {});

      console.log('✅ TSC print job completed via WebSocket');
      return { success: true, message: 'TSC label sent to printer.' };
    }

    if (printerType === 'hprt') {
      PRINTER_SHARE_NAME = 'HPRT_TP805L';
      let finalData;

      if (labelData) {
        const imagePath = await generateLabelImageFromData(labelData);
        finalData = await convertImageToEscposRaster(imagePath);
        fs.unlink(imagePath, () => {});
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
        fs.unlink(file, () => {});
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
        console.log('📏 Getting scale reading via WebSocket');
        try {
          const reading = await getScaleReading();
          console.log('📏 Scale reading:', reading);
          ws.send(JSON.stringify({
            type: 'scale_reading',
            requestId: data.requestId,
            reading: reading
          }));
        } catch (err) {
          console.error('❌ Scale reading error:', err.message);
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

// ---------- HTTP ENDPOINTS (for backward compatibility) ----------
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
      fs.unlink(file, () => {});
      return res.json({ success: true, message: 'TSC label sent to printer.' });
    }

    if (printerType === 'hprt') {
      let finalData;
      PRINTER_SHARE_NAME = 'HPRT_TP805L';

      if (labelData) {
        const imagePath = await generateLabelImageFromData(labelData);
        finalData = await convertImageToEscposRaster(imagePath);
        fs.unlink(imagePath, () => {});
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
        fs.unlink(file, () => {});
        return res.json({ success: true, message: 'HPRT label sent to shared printer.' });
      }
    }

    return res.status(400).json({ success: false, error: 'Unknown printer type.' });
  } catch (err) {
    console.error('[Print ERROR]', err);
    return res.status(500).json({ success: false, error: 'Printing failed.' });
  }
});

// Local scale reading endpoint (for backward compatibility)
app.get('/get_weight', async (req, res) => {
  try {
    const reading = await getScaleReading();
    res.json(reading);
  } catch (err) {
    res.status(204).send(); // No content, same as Python service
  }
});

// ---------- SERVER ----------
const PORT = 9999;
app.listen(PORT, () => {
  console.log(`\n✅ Print agent running on http://localhost:${PORT}`);
  console.log('🔗 Connecting to relay server...');
  connectToRelay();
});