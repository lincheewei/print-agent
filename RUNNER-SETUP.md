# Auto-deploy print agents on push (self-hosted runners)

Every push to `main` (or the **Run workflow** button in the Actions tab) makes
each terminal pull the latest code and hard-restart its agent — via a GitHub
Actions **self-hosted runner** installed on each terminal. Runners connect
*outbound* to GitHub, so no firewall/port changes are needed on the plant LAN.

Do this **once per terminal** (warehouse-terminal-001 … 004).

## 1. Install the runner on a terminal

On the terminal PC (PowerShell **as Administrator**):

1. In the browser: GitHub → `lincheewei/print-agent` → **Settings → Actions →
   Runners → New self-hosted runner → Windows**. It shows a download block and a
   `config.cmd` line with a one-time **token**.
2. Run the download commands it gives you (into e.g. `C:\actions-runner`).
3. Configure it with a label matching this terminal's id:
   ```powershell
   cd C:\actions-runner
   .\config.cmd --url https://github.com/lincheewei/print-agent `
     --token <TOKEN_FROM_GITHUB> `
     --labels warehouse-terminal-002 `
     --unattended
   ```
   Use the correct label per box: `warehouse-terminal-001` / `-002` / `-003` / `-004`.
4. Install + start it as a **service** so it runs on boot, headless:
   ```powershell
   .\svc.cmd install
   .\svc.cmd start
   ```

Repeat on each terminal with its own label. Confirm all show **Idle** under
Settings → Actions → Runners.

## 2. Git auth for the runner

The workflow runs `git fetch/reset` in `C:\print-agent`. That needs git to
authenticate as the runner's service account:

- If `lincheewei/print-agent` is **public** → nothing to do.
- If **private** → make sure the box's git has cached credentials the service
  account can use. Easiest: run the runner service as the same Windows user who
  already does `git pull` there, **or** store a PAT once:
  ```powershell
  cd C:\print-agent
  git remote set-url origin https://<GITHUB_USERNAME>:<PAT>@github.com/lincheewei/print-agent.git
  ```
  (PAT with `repo` read scope.)

## 3. Requirements per terminal (already true on your boxes)

- `C:\print-agent` is a git clone of this repo (you already `git pull` there).
- `config.json` exists (gitignored — holds `agentId`, `relayUrl`, scale/printer).
  `reset --hard` never touches it (untracked).
- The **"Start Print Agent"** scheduled task exists (the workflow calls
  `schtasks /Run` to relaunch).

## 4. How it runs

Push to `main` → GitHub fans out one job per terminal to its labelled runner →
each runner locally does: `git reset --hard origin/main` → `taskkill node` →
`schtasks /Run "Start Print Agent"`. Watch progress + per-terminal pass/fail in
the repo's **Actions** tab. `fail-fast: false` means a powered-off terminal won't
block the others.

## 5. Adding a terminal later

Install a runner on it with label `warehouse-terminal-00N`, then add that label
to the `matrix.terminal` list in `.github/workflows/deploy-agents.yml`.
