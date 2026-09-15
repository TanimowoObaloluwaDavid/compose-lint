'use strict';
/* Captures demo.html frame-by-frame via CDP. Resilient: restarts Chrome if it dies mid-run. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEMO = __dirname;
const PAGE = 'file:///' + path.join(DEMO, 'demo.html').replace(/\\/g, '/');
const FRAMES = path.join(DEMO, 'frames');
const PORT = 9229;
const FPS = 30;
const W = 1920, H = 1080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrome = null;
function killChrome() {
  if (chrome) { try { chrome.kill(); } catch {} chrome = null; }
}
process.on('exit', () => { killChrome(); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); killChrome(); process.exit(1); });
process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); killChrome(); process.exit(1); });

function startChrome(userData) {
  chrome = spawn(CHROME, [
    '--headless',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userData,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-logging=stderr --v=0',
    '--window-size=' + W + ',' + H,
    '--force-device-scale-factor=1',
    PAGE,
  ], { stdio: 'ignore' });
  return chrome;
}

async function findTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.startsWith('file:'));
      if (t) return t;
    } catch {}
    await sleep(150);
  }
  return null;
}

async function connectAgent() {
  const target = await findTarget();
  if (!target) throw new Error('page tab not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws open failed')); });
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pend.set(i, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error('timeout:' + method)); } }, 20000).unref();
  });
  const closeP = new Promise((resolve) => { ws.onclose = () => resolve(); });
  return { ws, send, closeP };
}

async function main() {
  if (!process.env.RESUME) fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });

  // discover duration from a first run, then capture
  let duration = 23.6;
  let first = true;
  let saving = false;
  let restarts = 0;

  while (true) {
    let nextMissing = -1;
    for (let i = 0; i <= Math.round(duration * FPS); i++) {
      if (!fs.existsSync(path.join(FRAMES, frameName(i)))) { nextMissing = i; break; }
    }
    if (nextMissing === -1) break;

    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-demo-'));
    startChrome(userData);
    let agent;
    try {
      agent = await connectAgent();
      const send = agent.send;
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

      if (first) {
        await send('Page.reload', { ignoreCache: true });
      }
      for (let i = 0; i < 120; i++) {
        const r = await send('Runtime.evaluate', {
          expression: 'typeof window.CL === "object" && typeof window.CL.end === "number"',
          returnByValue: true,
        });
        if (r.result?.value === true) break;
        await sleep(150);
      }
      if (first) {
        const dr = await send('Runtime.evaluate', { expression: 'window.CL.end', returnByValue: true });
        if (dr.result && typeof dr.result.value === 'number') duration = dr.result.value;
        console.log('timeline duration = ' + duration + 's (' + Math.round(duration * FPS) + ' frames)');
        first = false;
      }
      await sleep(500);

      const total = Math.round(duration * FPS);
      const t0 = Date.now();
      let ok = true;
      for (let i = nextMissing; i <= total; i++) {
        const t = i / FPS;
        try {
          await send('Runtime.evaluate', { expression: `window.CL.step(${t.toFixed(4)})`, returnByValue: true });
          const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          fs.writeFileSync(path.join(FRAMES, frameName(i)), Buffer.from(shot.data, 'base64'));
        } catch (e) {
          console.error('frame ' + i + ' failed: ' + e.message);
          ok = false;
          break;
        }
        if (i % 90 === 0) console.log(`frame ${i}/${total}  ${((Date.now()-t0)/1000).toFixed(1)}s`);
      }
      agent.ws.close();
      if (ok) break;
    } catch (e) {
      console.error('run error: ' + e.message);
    } finally {
      killChrome();
      agent?.ws.close?.();
    }
    restarts++;
    if (restarts > 8) throw new Error('too many restarts');
    console.log('restarting chrome... (' + restarts + ')');
    await sleep(1500);
  }

  console.log('done: frames in ' + FRAMES);
}

function frameName(i) { return 'frame-' + String(i).padStart(5, '0') + '.png'; }

main().catch((e) => { console.error(e); process.exit(1); });