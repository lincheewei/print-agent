const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');


const { spawn, execSync } = require('child_process');

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
// const PRINTER_SHARE_NAME = 'TSC_TE200'; // <-- Update if needed
const PRINTER_SHARE_NAME = 'HPRT_TP805L'; // <-- Update if needed
const DEFAULT_HPRT_IP = '192.168.1.88'; // Optional: default wireless printer IP
const SCALE_SCRIPT = path.join(__dirname, 'scale_service.py');
const VENV_DIR = path.join(__dirname, 'venv');
const REQUIREMENTS_FILE = path.join(__dirname, 'requirements.txt');

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




app.post('/print-label', async (req, res) => {
  const { printerType, tspl, escpos, printerIP, labelData } = req.body;

  console.log("Printing" + printerType);
  try {
    if (printerType === 'tsc') {
      if (!tspl) return res.status(400).json({ success: false, error: 'Missing TSPL data.' });

      const file = path.join(__dirname, `tsc_${Date.now()}.txt`);
      await fs.promises.writeFile(file, tspl, 'ascii');
      const printCmd = `copy /b "${file}" \\\\localhost\\${PRINTER_SHARE_NAME}`;
      execSync(printCmd, { stdio: 'inherit', shell: true });
      fs.unlink(file, () => { });
      return res.json({ success: true, message: 'TSC label sent to printer.' });
    }

    if (printerType === 'hprt') {
      let finalData;

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
        await fs.promises.writeFile(file, finalData); // ⛔ 不要加编码
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
  // console.log(`↪ Scale service available at http://localhost:8000/get_weight\n`);
});