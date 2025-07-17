const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');
const sharp = require('sharp');

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
// if (!fs.existsSync(VENV_DIR)) {
//   console.log('[Python] Creating virtual environment...');
//   execSync(`python -m venv venv`, { cwd: __dirname, stdio: 'inherit' });
// }

// console.log('[Python] Installing dependencies...');
// const pipCmd = process.platform === 'win32'
//   ? path.join(VENV_DIR, 'Scripts', 'pip')
//   : path.join(VENV_DIR, 'bin', 'pip');
// execSync(`"${pipCmd}" install -r requirements.txt`, { cwd: __dirname, stdio: 'inherit' });

// console.log('[Scale] Starting scale_service.py...');
// const pythonCmd = process.platform === 'win32'
//   ? path.join(VENV_DIR, 'Scripts', 'python')
//   : path.join(VENV_DIR, 'bin', 'python');
// const scaleProcess = spawn(`"${pythonCmd}"`, [SCALE_SCRIPT], {
//   cwd: __dirname,
//   shell: true
// });
// scaleProcess.stdout.on('data', (data) => console.log(`[Scale] ${data}`));
// scaleProcess.stderr.on('data', (data) => console.error(`[Scale ERROR] ${data}`));
// scaleProcess.on('exit', (code) => console.log(`[Scale] Python process exited with code ${code}`));



// ---------- UTILITY: Generate dummy label image (replace with dynamic layout if needed) ----------
// async function generateLabelImageFromData(labelData) {
//   const outputPath = path.join(__dirname, `label_${Date.now()}.png`);
// const svg = `
//     <svg width="576" height="560" xmlns="http://www.w3.org/2000/svg">
//       <style>
//         text { font-family: Helvetica, sans-serif; font-size: 6px; }
//         .header { font-size: 6px; font-weight: bold; text-anchor: middle; }
//         .label { font-size: 8px; font-weight: bold; text-decoration: underline; }
//         .value { font-size: 10px; }
//       </style>

//       <rect x="0" y="0" width="576" height="560" fill="white" stroke="black" stroke-width="1"/>
//       <text class="header" x="288" y="24">WORK ORDER LABEL</text>

//       <!-- Row 1 -->
//       <rect x="0" y="40" width="172.8" height="40" stroke="black" fill="none"/>
//       <text class="label" x="4" y="52">W.O. NO. :</text>
//       <text class="value" x="4" y="72">${labelData.coNumber}</text>

//       <rect x="172.8" y="40" width="403.2" height="40" stroke="black" fill="none"/>
//       <text class="label" x="176.8" y="52">PART NAME :</text>
//       <text class="value" x="176.8" y="72">${labelData.partName}</text>

//       <!-- Row 2 -->
//       <rect x="0" y="80" width="172.8" height="40" stroke="black" fill="none"/>
//       <text class="label" x="4" y="92">DATE ISSUE :</text>
//       <text class="value" x="4" y="112">${labelData.dateIssue}</text>

//       <rect x="172.8" y="80" width="172.8" height="40" stroke="black" fill="none"/>
//       <text class="label" x="176.8" y="92">STOCK CODE :</text>
//       <text class="value" x="176.8" y="112">${labelData.stockCode}</text>

//       <rect x="345.6" y="80" width="230.4" height="40" stroke="black" fill="none"/>
//       <text class="label" x="349.6" y="92">PROCESS CODE / NO. :</text>
//       <text class="value" x="349.6" y="112">${labelData.processCode}</text>

//       <!-- Row 3 -->
//       <rect x="0" y="120" width="172.8" height="40" stroke="black" fill="none"/>
//       <text class="label" x="4" y="132">EMP. NO. :</text>
//       <text class="value" x="4" y="152">${labelData.empNo}</text>

//       <rect x="172.8" y="120" width="403.2" height="40" stroke="black" fill="none"/>
//       <text class="label" x="176.8" y="132">QTY :</text>
//       <text class="value" x="176.8" y="152">${labelData.qty}</text>

//       <!-- Row 4 (Remarks full width) -->
//       <rect x="0" y="160" width="576" height="80" stroke="black" fill="none"/>
//       <text class="label" x="4" y="172">REMARKS :</text>
//       <text class="value" x="4" y="192">${labelData.remarks}</text>
//     </svg>
//   `;

//   await sharp(Buffer.from(svg), { density: 203 })
//   .resize(576, 560, {
//     fit: 'contain',
//     background: '#FFFFFF',
//   })
//   .png()
//   .toFile(outputPath);
//   return outputPath;
// }
const { createCanvas, loadImage } = require('canvas');


async function generateLabelImageFromData(labelData) {
  const width = 576;
  const height = 560;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 背景白
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // 标题
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 18px Arial';
  ctx.fillText('WORK ORDER LABEL', 180, 30);

  // 内容
  ctx.font = '10px Arial';

  ctx.fillText(`W.O. NO.: ${labelData.coNumber}`, 10, 70);
  ctx.fillText(`PART NAME: ${labelData.partName}`, 290, 70);
  ctx.fillText(`DATE ISSUE: ${labelData.dateIssue}`, 10, 110);
  ctx.fillText(`STOCK CODE: ${labelData.stockCode}`, 10, 150);
  ctx.fillText(`PROCESS CODE: ${labelData.processCode}`, 290, 150);
  ctx.fillText(`EMP. NO.: ${labelData.empNo}`, 10, 190);
  ctx.fillText(`QTY: ${labelData.qty}`, 290, 190);
  ctx.fillText(`REMARKS: ${labelData.remarks}`, 10, 230);

  // 可选：加边框线
  ctx.strokeRect(0, 0, width, height);

  const filePath = path.join(__dirname, `label_${Date.now()}.png`);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ---------- UTILITY: Convert PNG to ESC/POS Raster ----------
async function convertImageToEscposRaster(imagePath) {
  const ESC = '\x1B';
  const GS = '\x1D';
  const { data, info } = await sharp(imagePath)
    .resize(576, 560, { fit: 'contain' })         // 强制输出 576×560 px
    .threshold(180)                            // 更明确的黑白转换阈值
    .flatten({ background: '#FFFFFF' })        // 避免透明像素导致锯齿
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const bytesPerRow = Math.ceil(width / 8);

  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;
  const yL = height & 0xff;
  const yH = (height >> 8) & 0xff;

  let raster = Buffer.concat([
    Buffer.from(GS + 'v0' + '\x00' + String.fromCharCode(xL, xH, yL, yH), 'binary'),
    Buffer.alloc(bytesPerRow * height)
  ]);

  for (let y = 0; y < height; y++) {
    for (let xByte = 0; xByte < bytesPerRow; xByte++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = xByte * 8 + bit;
        if (x < width && data[y * width + x] === 0) {
          byte |= (1 << (7 - bit));
        }
      }
      raster[(bytesPerRow * y) + xByte + 8] = byte;
    }
  }

  raster = Buffer.concat([raster, Buffer.from(GS + 'V' + '\x01', 'binary')]);
  return raster;
}

app.post('/print-label', async (req, res) => {
  const { printerType = 'hprt', tspl, escpos, printerIP, labelData } = req.body;

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