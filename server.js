// server.js
// Servidor de biblioteca multimedia: sube, lista, transmite y borra
// videos, películas y música. Guarda los archivos en disco (./uploads)
// y su metadata en un archivo JSON (./data/library.json).

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'library.json');

// ---------- preparar carpetas y "base de datos" ----------
for (const dir of [UPLOAD_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]', 'utf-8');

function readLibrary() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}
function writeLibrary(items) {
  fs.writeFileSync(DB_FILE, JSON.stringify(items, null, 2), 'utf-8');
}

// ---------- multer: dónde y cómo guardar los archivos subidos ----------
const ALLOWED_MIME = /^(video|audio)\//;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname);
    file.generatedId = id; // lo recuperamos después en la ruta
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GB por archivo, ajusta a tu gusto
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.test(file.mimetype)) {
      return cb(new Error('Solo se permiten archivos de video o audio'));
    }
    cb(null, true);
  },
});

app.use(express.json());

// ---------- servir el frontend (carpeta public) ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API ----------

// Listar todo lo que hay en la biblioteca
app.get('/api/media', (req, res) => {
  const items = readLibrary().map(({ filename, ...publicFields }) => publicFields);
  res.json(items);
});

// Subir un archivo
app.post('/api/media/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }

    const id = path.parse(req.file.filename).name;
    const item = {
      id,
      name: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
      filename: req.file.filename,
      uploadedAt: new Date().toISOString(),
    };

    const items = readLibrary();
    items.push(item);
    writeLibrary(items);

    const { filename, ...publicFields } = item;
    res.status(201).json(publicFields);
  });
});

// Transmitir un archivo (con soporte de rango para que el video/audio
// se pueda adelantar/retroceder sin descargarlo completo primero)
app.get('/api/media/:id/stream', (req, res) => {
  const items = readLibrary();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Archivo no encontrado' });

  const filePath = path.join(UPLOAD_DIR, item.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado en disco' });

  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': item.mime,
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(startStr, 10);
  const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
  const chunkSize = end - start + 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': item.mime,
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

// Borrar un archivo
app.delete('/api/media/:id', (req, res) => {
  const items = readLibrary();
  const idx = items.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Archivo no encontrado' });

  const [item] = items.splice(idx, 1);
  const filePath = path.join(UPLOAD_DIR, item.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  writeLibrary(items);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});