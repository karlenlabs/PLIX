// One entry for the native DEV player and its browser tuning panel.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const base = 'http://127.0.0.1:5173';
const url = base + '/?window=visual-tuning';
async function probe() {
  try {
    const response = await fetch(base + '/__ympleer_dev_tuning', { signal: AbortSignal.timeout(700) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Port 5173 is occupied by another server.');
    const value = await response.json();
    if (value.project !== 'ympleer-v2' || value.version !== 2) throw new Error('Restart PLIX DEV to load the current tuning bridge.');
    return true;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'TimeoutError') return false;
    throw error;
  }
}
function openPanel() {
  console.log('Visual Tuning: ' + url);
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { windowsHide: true, stdio: 'ignore' })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => console.log('Open the URL above in your browser.'));
}
try {
  if (await probe()) openPanel();
  else {
    const child = spawn(process.execPath, [resolve('node_modules/@tauri-apps/cli/tauri.js'), 'dev'], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || resolve('cargo-check-target') },
    });
    let opened = false;
    const timer = setInterval(async () => {
      if (opened) return;
      try { if (await probe()) { if (opened) return; opened = true; clearInterval(timer); openPanel(); } }
      catch (error) { clearInterval(timer); console.error(error.message); }
    }, 700);
    child.on('exit', code => { clearInterval(timer); process.exitCode = code ?? 1; });
    child.on('error', error => { clearInterval(timer); console.error(error.message); process.exitCode = 1; });
    process.once('SIGINT', () => { clearInterval(timer); child.kill('SIGINT'); });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
