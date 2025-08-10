// server.js - Node.js 20, Docker-based sandboxing
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import AdmZip from 'adm-zip';
import fs from 'fs-extra';
import path from 'path';
import { nanoid } from 'nanoid';
import { WebSocketServer } from 'ws';
import bodyParser from 'body-parser';
import mime from 'mime-types';
import Docker from 'dockerode';

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.resolve('./data/bots');
const UPLOAD_DIR = path.resolve('./data/uploads');

await fs.ensureDir(DATA_DIR);
await fs.ensureDir(UPLOAD_DIR);

const docker = new Docker(); // connect to local Docker socket

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// Map: botId -> { container, logs:[], listeners:Set() }
const bots = new Map();

async function listBots() {
  const names = await fs.readdir(DATA_DIR);
  const botsList = [];
  for (const name of names) {
    const full = path.join(DATA_DIR, name);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      const entry = bots.get(name);
      botsList.push({ id: name, path: full, running: !!(entry && entry.container) });
    }
  }
  return botsList;
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const id = nanoid(10);
    const destDir = path.join(DATA_DIR, id);
    await fs.ensureDir(destDir);

    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(destDir, true);
    await fs.remove(req.file.path);

    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/bots', async (req, res) => {
  const list = await listBots();
  res.json(list);
});

app.delete('/api/bots/:id', async (req, res) => {
  const id = req.params.id;
  if (bots.has(id)) {
    await stopBot(id);
  }
  const dir = path.join(DATA_DIR, id);
  await fs.remove(dir);
  res.json({ ok: true });
});

app.get('/api/bots/:id/files', async (req, res) => {
  const id = req.params.id;
  const dir = path.join(DATA_DIR, id);
  if (!await fs.pathExists(dir)) return res.status(404).json({ error: 'Bot not found' });
  const files = [];
  async function walk(base) {
    const entries = await fs.readdir(base);
    for (const e of entries) {
      const full = path.join(base, e);
      const rel = path.relative(dir, full);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) await walk(full);
      else files.push({ path: rel, size: stat.size });
    }
  }
  await walk(dir);
  res.json(files);
});

app.get('/api/bots/:id/file', async (req, res) => {
  const { id } = req.params;
  const { path: rel } = req.query;
  if (!rel) return res.status(400).json({ error: 'Missing file path' });
  const filePath = path.join(DATA_DIR, id, rel);
  if (!filePath.startsWith(path.join(DATA_DIR, id))) return res.status(400).json({ error: 'Invalid path' });
  if (!await fs.pathExists(filePath)) return res.status(404).json({ error: 'File not found' });
  const content = await fs.readFile(filePath, 'utf8');
  res.json({ content, mime: mime.lookup(filePath) || 'text/plain' });
});

app.put('/api/bots/:id/file', async (req, res) => {
  const { id } = req.params;
  const { path: rel, content } = req.body;
  if (!rel) return res.status(400).json({ error: 'Missing file path' });
  const filePath = path.join(DATA_DIR, id, rel);
  if (!filePath.startsWith(path.join(DATA_DIR, id))) return res.status(400).json({ error: 'Invalid path' });
  await fs.outputFile(filePath, content, 'utf8');
  res.json({ ok: true });
});

app.post('/api/bots/:id/start', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await startBot(id);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/bots/:id/stop', async (req, res) => {
  const id = req.params.id;
  try {
    await stopBot(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/bots/:id/restart', async (req, res) => {
  const id = req.params.id;
  try {
    await stopBot(id);
    await startBot(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/bots/:id/status', async (req, res) => {
  const id = req.params.id;
  const entry = bots.get(id);
  res.json({ running: !!(entry && entry.container), containerId: entry?.container?.id || null });
});

const server = app.listen(PORT, () => console.log(`Server listening at http://localhost:${PORT}`));
const wss = new WebSocketServer({ server, path: '/ws/logs' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const botId = url.searchParams.get('botId');
  if (!botId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing botId' }));
    ws.close();
    return;
  }

  const entry = bots.get(botId);
  if (entry && entry.logs) ws.send(JSON.stringify({ type: 'history', logs: entry.logs.slice(-200) }));

  const onLog = (msg) => { try { ws.send(JSON.stringify({ type: 'log', message: msg })); } catch (e) {} };
  ws._onLog = onLog;
  if (entry) entry.listeners = entry.listeners || new Set();
  entry?.listeners?.add(onLog);

  ws.on('close', () => { entry?.listeners?.delete(onLog); });
});

async function startBot(id) {
  const dir = path.join(DATA_DIR, id);
  if (!await fs.pathExists(dir)) throw new Error('Bot not found');
  if (bots.has(id) && bots.get(id).container) return { message: 'already running', containerId: bots.get(id).container.id };

  // discover entry point
  const candidates = ['index.js', 'app.js', 'server.js'];
  let entryPoint = null;
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (await fs.pathExists(p)) { entryPoint = `/bot/${c}`; break; }
  }
  if (!entryPoint) {
    const pkgPath = path.join(dir, 'package.json');
    if (await fs.pathExists(pkgPath)) {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      if (pkg.main) entryPoint = `/bot/${pkg.main}`;
    }
  }
  if (!entryPoint) throw new Error('No entry point found (index.js/app.js/server.js or package.json main)');

  // create container
  const image = process.env.SANDBOX_IMAGE || 'node:20-slim';
  // Ensure unique name
  const containerName = `bot_${id}`;

  const binds = [`${dir}:/bot:rw`]; // host_dir : container_dir

  const container = await docker.createContainer({
    Image: image,
    Cmd: ['node', entryPoint.replace('/bot/', '')],
    Tty: false,
    HostConfig: {
      Binds: binds,
      AutoRemove: false,
      NetworkMode: 'none',
      Memory: 256 * 1024 * 1024, // 256MB
      PidsLimit: 100
    },
    WorkingDir: '/bot',
    name: containerName
  });

  await container.start();

  const entry = { container, logs: [], listeners: new Set() };
  bots.set(id, entry);

  // attach log stream
  const logStream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 100 });
  logStream.on('data', (chunk) => {
    const msg = `[${new Date().toISOString()}] ${chunk.toString()}`;
    entry.logs.push(msg);
    if (entry.logs.length > 2000) entry.logs.shift();
    for (const l of entry.listeners) {
      try { l(msg); } catch (e) {}
    }
  });

  // cleanup on exit
  container.wait().then((res) => {
    const msg = `[${new Date().toISOString()}] container exited ${JSON.stringify(res)}`;
    entry.logs.push(msg);
    for (const l of entry.listeners) try { l(msg); } catch (e) {}
    bots.delete(id);
  }).catch(e => console.log('wait err', e));

  return { containerId: container.id };
}

async function stopBot(id) {
  const entry = bots.get(id);
  if (!entry || !entry.container) return;
  try {
    await entry.container.stop({ t: 5 });
  } catch (e) { console.warn('stop err', e); }
  bots.delete(id);
}
