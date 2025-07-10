const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

// Use absolute path for the label file
const LABEL_FILE_PATH = path.join(__dirname, 'label.txt');
// Set your printer's name exactly as it appears in Windows
const PRINTER_NAME = 'TSC_TE200'; // <-- Change if your printer name is different

// app.post('/print-label', (req, res) => {
//   const tspl = req.body.tspl;

//   if (!tspl) {
//     return res.status(400).json({ success: false, error: 'Missing TSPL data in request body.' });
//   }

//   // Save TSPL file locally (on Windows PC)
//   fs.writeFileSync(LABEL_FILE_PATH, tspl);
//   const PRINTER_SHARE_NAME = 'TSC_TE200'; // Change to your share name!
//   // Command for local printing
//   const printCmd = `copy /b "${LABEL_FILE_PATH}" "\\\\localhost\\${PRINTER_SHARE_NAME}"`;
//   console.log('Executing print command:', printCmd);

//   exec(printCmd, (err, stdout, stderr) => {
//     if (err) {
//       console.error('Print error:', err, stderr);
//       return res.status(500).json({ success: false, error: 'Print failed: ' + stderr });
//     }
//     console.log('Print success:', stdout);
//     res.json({ success: true, message: 'Label sent to printer.' });
//   });
// });

app.post('/print-label', async (req, res) => {
  const tspl = req.body.tspl;

  if (!tspl) return res.status(400).json({ success: false, error: 'Missing TSPL data.' });

  try {
    const uniqueFile = path.join(__dirname, `label_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    await fs.promises.writeFile(uniqueFile, tspl);

    const printCmd = `copy /b "${uniqueFile}" "\\\\localhost\\${PRINTER_SHARE_NAME}"`;
    console.log('Executing print command:', printCmd);

    exec(printCmd, (err, stdout, stderr) => {
      fs.unlink(uniqueFile, () => {}); // Clean up
      if (err) {
        console.error('Print error:', err, stderr);
        return res.status(500).json({ success: false, error: 'Print failed: ' + stderr });
      }
      console.log('Print success:', stdout);
      res.json({ success: true, message: 'Label sent to printer.' });
    });
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ success: false, error: 'Internal error writing label.' });
  }
});

app.listen(9999, () => {
  console.log('Print agent running on port 9999');
  console.log('Waiting for print jobs...');
});