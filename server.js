const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
const PRINTER_SHARE_NAME = 'TSC_TE200'; // <-- Update to your shared printer name
const SCALE_SCRIPT = path.join(__dirname, 'scale_service.py');
const VENV_DIR = path.join(__dirname, 'venv');
const REQUIREMENTS_FILE = path.join(__dirname, 'requirements.txt');

// ---------- PYTHON ENV SETUP ----------

// 1. Create virtual environment if not exists
if (!fs.existsSync(VENV_DIR)) {
  console.log('[Python] Creating virtual environment...');
  execSync(`python -m venv venv`, { cwd: __dirname, stdio: 'inherit' });
}

// 2. Install dependencies from requirements.txt
console.log('[Python] Installing dependencies...');
const pipCmd = process.platform === 'win32'
  ? path.join(VENV_DIR, 'Scripts', 'pip')
  : path.join(VENV_DIR, 'bin', 'pip');
execSync(`"${pipCmd}" install -r requirements.txt`, { cwd: __dirname, stdio: 'inherit' });

// 3. Start scale_service.py using the venv Python
console.log('[Scale] Starting scale_service.py...');
const pythonCmd = process.platform === 'win32'
  ? path.join(VENV_DIR, 'Scripts', 'python')
  : path.join(VENV_DIR, 'bin', 'python');

const scaleProcess = spawn(`"${pythonCmd}"`, [SCALE_SCRIPT], {
  cwd: __dirname,
  shell: true
});

scaleProcess.stdout.on('data', (data) => {
  console.log(`[Scale] ${data}`);
});
scaleProcess.stderr.on('data', (data) => {
  console.error(`[Scale ERROR] ${data}`);
});
scaleProcess.on('exit', (code) => {
  console.log(`[Scale] Python process exited with code ${code}`);
});

// ---------- PRINT API ----------
app.post('/print-label', async (req, res) => {
  const tspl = req.body.tspl;
  if (!tspl) return res.status(400).json({ success: false, error: 'Missing TSPL data.' });

  try {
    const uniqueFile = path.join(__dirname, `label_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    await fs.promises.writeFile(uniqueFile, tspl);

    const printCmd = `copy /b "${uniqueFile}" "\\\\localhost\\${PRINTER_SHARE_NAME}"`;
    console.log('[Print] Executing:', printCmd);

    execSync(printCmd, { stdio: 'inherit', shell: true });
    fs.unlink(uniqueFile, () => {}); // Clean up temp file

    res.json({ success: true, message: 'Label sent to printer.' });
  } catch (err) {
    console.error('[Print ERROR]', err);
    res.status(500).json({ success: false, error: 'Print failed. Check logs.' });
  }
});

// ---------- SERVER ----------
const PORT = 9999;
app.listen(PORT, () => {
  console.log(`\n✅ Print agent running on http://localhost:${PORT}`);
  console.log(`↪ Scale service available at http://localhost:8000/get_weight\n`);
});