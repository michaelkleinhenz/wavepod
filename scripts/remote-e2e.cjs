// End-to-end check of remote guests: WavePod (simulated audio) as host and a headless Chromium as
// guest, through a local LiveKit server. Not part of `npm test` (it needs the server binary).
//
//   livekit-server --dev --bind 127.0.0.1          (dev keys: devkey / secret)
//   node scripts/build-guest.mjs && node scripts/build.mjs
//   xvfb-run -a node scripts/remote-e2e.cjs <voice.wav> [<out dir>]
//
// The guest's fake microphone plays <voice.wav> (48 kHz mono, speech-like). The script invites a
// guest, lets them in, records a take, kills the guest page mid-take and reopens it (what was kept
// arrives anyway, the rest of the take comes as a second part), and waits until both parts of the
// guest's raw recording are on their track, lined up with the call audio.
const { _electron: electron, chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const voice = path.resolve(process.argv[2] ?? 'voice.wav');
const out = path.resolve(process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wp-remote-')));
const root = path.resolve(__dirname, '..');
const RECORD_SECONDS = Number(process.env.RECORD_SECONDS ?? 20);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(250);
  }
}

function serveSite() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    const p = path.join(root, 'site', decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
    if (!file.startsWith(path.join(root, 'site')) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function main() {
  const server = await serveSite();
  const pageUrl = `http://127.0.0.1:${server.address().port}/join/v1/`;
  const config = path.join(out, 'config');
  const projects = path.join(out, 'projects');
  fs.mkdirSync(path.join(config, 'WavePod'), { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(config, 'WavePod', 'settings.json'), JSON.stringify({ betaNoticeSeen: true, remote: { guestPageUrl: pageUrl } }));

  const app = await electron.launch({
    executablePath: require(path.join(root, 'node_modules', 'electron')),
    args: [root, '--no-sandbox'],
    env: { ...process.env, WAVEPOD_SIMULATED: '1', XDG_CONFIG_HOME: config, WAVEPOD_PROJECT_ROOT: projects, LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' },
  });
  app.process().stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const host = await app.firstWindow();
  await host.waitForLoadState('domcontentloaded');
  await wait(2000);
  // the first-start beta notice
  const ok = host.getByRole('button', { name: 'I understand' });
  if (await ok.isVisible().catch(() => false)) await ok.click();

  // open the panel, start the session, invite a guest
  await host.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('wavepod:menu', 'remote-guests'));
  await host.locator('.remote-panel').waitFor();
  await host.getByRole('button', { name: 'Open Session' }).click();
  await host.getByText('Session open').waitFor({ timeout: 20000 });
  const { trackId, link } = await host.evaluate(() => window.wavepod.remoteInvite('Alex'));
  console.log('invite link:', link.slice(0, 80) + '…');

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${voice}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  let guest = await ctx.newPage();
  guest.on('console', (m) => m.type() === 'error' && console.log(`[guest] ${m.text()}`));
  const join = async (page) => {
    await page.goto(link);
    await page.getByRole('button', { name: 'Set up microphone' }).click();
    await page.getByRole('button', { name: 'Join' }).click();
  };
  await join(guest);
  await guest.getByText('Waiting for the host').waitFor();
  await host.getByRole('button', { name: 'Let In' }).click();
  await guest.getByText('Not recording').waitFor({ timeout: 20000 });
  console.log('guest is live');

  await wait(3000);

  // record; drop the guest mid-take and bring them back
  await host.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {});
  await host.keyboard.press('r');
  await wait(1500);
  console.log('host toast:', await host.evaluate(() => document.getElementById('toast')?.textContent ?? ''));
  await host.screenshot({ path: path.join(out, 'host-rec.png') });
  await until('recording', () => guest.locator('.rec').isVisible());
  console.log('recording');
  await wait((RECORD_SECONDS / 2) * 1000);
  await guest.close();
  console.log('guest tab closed mid-take');
  await wait(3000);
  guest = await ctx.newPage();
  await join(guest);
  await until('guest back', () => guest.getByText(/Recording|Not recording/).first().isVisible(), 30000);
  console.log('guest back');
  await wait((RECORD_SECONDS / 2) * 1000);
  await host.keyboard.press(' ');
  // a stop confirmation may come up
  const confirm = host.getByRole('button', { name: /Stop recording/i });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  console.log('stopped');

  const takes = await until(
    'placed takes',
    async () => {
      const t = await host.evaluate(() => window.wavepod.remoteTakes());
      return t.length && t.every((x) => x.state === 'placed') ? t : null;
    },
    90000,
  );
  console.log('takes:', JSON.stringify(takes, null, 1));
  const project = JSON.parse(fs.readFileSync(path.join(projects, fs.readdirSync(projects)[0], 'project.json'), 'utf8'));
  const track = project.tracks.find((t) => t.remote);
  console.log('guest track clips:', JSON.stringify(track.clips.map((c) => ({ file: c.file, start: c.start, offset: c.offset, length: c.length, takeId: c.takeId }))));
  console.log('guest track takes:', (track.takes ?? []).length);
  await host.screenshot({ path: path.join(out, 'host.png') });
  await guest.screenshot({ path: path.join(out, 'guest.png') });
  await browser.close();
  await app.close();
  server.close();
  console.log('output in', out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
