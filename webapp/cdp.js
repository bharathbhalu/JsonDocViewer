/* Temporary CDP harness for export verification. Delete when done. */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + path, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({
      events,
      send(method, params) {
        const n = ++id;
        return new Promise((res, rej) => {
          pending.set(n, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: n, method, params: params || {} }));
        });
      },
      close() { ws.close(); },
    }));
    ws.addEventListener('error', reject);
  });
}

async function session(opts) {
  const port = opts.port || 9350;
  const profile = opts.profile || '/tmp/cdp-profile';
  const downloads = opts.downloads || '/tmp/cdp-downloads';
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(downloads, { recursive: true, force: true });
  fs.mkdirSync(downloads, { recursive: true });
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--window-size=' + (opts.size || '1440,900'),
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await httpGet(port, '/json/version'); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 150)); }
  }
  const list = JSON.parse(await httpGet(port, '/json/list'));
  const page = list.find((t) => t.type === 'page');
  const client = await connect(page.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable').catch(() => {});
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  return {
    client,
    downloads,
    async goto(url) {
      await client.send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, 400));
    },
    async eval(expression, awaitPromise) {
      const res = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
      if (res.exceptionDetails) return { error: JSON.stringify(res.exceptionDetails).slice(0, 600) };
      return { value: res.result.value };
    },
    async waitFor(expression, tries) {
      for (let i = 0; i < (tries || 60); i++) {
        const r = await this.eval(expression);
        if (r.value) return true;
        await new Promise((res) => setTimeout(res, 200));
      }
      return false;
    },
    async screenshot(file) {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return file;
    },
    consoleErrors() {
      return client.events
        .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
        .map((e) => JSON.stringify(e.params).slice(0, 300));
    },
    downloadState() {
      return client.events
        .filter((e) => e.method === 'Browser.downloadProgress' || e.method === 'Browser.downloadWillBegin')
        .map((e) => e.method + ' ' + JSON.stringify(e.params));
    },
    files() {
      return fs.readdirSync(downloads).map((n) => ({ name: n, size: fs.statSync(downloads + '/' + n).size }));
    },
    stop() {
      client.close();
      chrome.kill('SIGKILL');
    },
  };
}

module.exports = { session };
