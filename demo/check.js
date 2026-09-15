'use strict';
/* Logs frames at a few key timestamps to sanity-check the layout. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEMO = __dirname;
const PAGE = 'file:///' + path.join(DEMO, 'demo.html').replace(/\\/g, '/');
const OUT = path.join(DEMO, 'check');
const PORT = 9231;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-check-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userData,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--window-size=1920,1080', PAGE,
  ], { stdio: 'ignore' });
  setTimeout(() => { try { chrome.kill(); } catch {} }, 90000).unref();

  let target;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
      if (target) break;
    } catch {}
    await sleep(150);
  }
  if (!target) throw new Error('page not found');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id; pend.set(i, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1.5, mobile: false });
  await send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', { expression: 'typeof window.CL === "object"', returnByValue: true });
    if (r.result?.value === true) break;
    await sleep(120);
  }
  await sleep(500);

  const times = [1.0, 2.8, 5.0, 8.4, 9.8, 11.4, 13.2, 14.1, 15.3, 16.6, 18.9, 21.0, 22.2, 23.4];
  for (const t of times) {
    await send('Runtime.evaluate', { expression: `window.CL.step(${t})` });
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, `t${String(t).padStart(4, '0').replace('.', '_')}.png`), Buffer.from(s.data, 'base64'));
    console.log('captured t=' + t);
  }
  ws.close(); chrome.kill();
}
main().catch((e) => { console.error(e); process.exit(1); });