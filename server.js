// server.js
// Servidor de biblioteca multimedia: sube, lista, transmite y borra
// videos, películas y música. Los archivos y su metadata se guardan
// en Cloudflare R2, así que persisten aunque el servidor se reinicie.

const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const LIBRARY_KEY = 'library.json';

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

async function readLibrary() {
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: LIBRARY_KEY }));
    const body = await streamToString(data.Body);
    return JSON.parse(body);
  } catch (e) {
    return [];
  }
}

async function writeLibrary(items) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: LIBRARY_KEY,
    Body: JSON.stringify(items, null, 2),
    ContentType: 'application/json',
  }));
}

const ALLOWED_MIME = /^(video|audio)\//;

const upload = multer({
  storage: multerS3({
    s3,
    bucket: R2_BUCKET_NAME,
    key: (req, file, cb) => {
      const id = crypto.randomUUID();
      const ext = path.extname(file.originalname);
      file.generatedId = id;
      cb(null, `files/${id}${ext}`);
    },
    contentType: multerS3.AUTO_CONTENT_TYPE,
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.test(file.mimetype)) {
      return cb(new Error('Solo se permiten archivos de video o audio'));
    }
    cb(null, true);
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Listar todo lo que hay en la biblioteca
app.get('/api/media', async (req, res) => {
  const items = await readLibrary();
  res.json(items.map(({ key, ...pub }) => pub));
});

// Subir un archivo
app.post('/api/media/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    const item = {
      id: req.file.generatedId,
      name: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
      key: req.file.key,
      uploadedAt: new Date().toISOString(),
    };

    const items = await readLibrary();
    items.push(item);
    await writeLibrary(items);

    const { key, ...pub } = item;
    res.status(201).json(pub);
  });
});

// Transmitir un archivo (con soporte de rango)
app.get('/api/media/:id/stream', async (req, res) => {
  const items = await readLibrary();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Archivo no encontrado' });

  const range = req.headers.range;
  try {
    const data = await s3.send(new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: item.key,
      Range: range || undefined,
    }));

    if (range && data.ContentRange) {
      res.writeHead(206, {
        'Content-Range': data.ContentRange,
        'Accept-Ranges': 'bytes',
        'Content-Length': data.ContentLength,
        'Content-Type': item.mime,
      });
    } else {
      res.writeHead(200, {
        'Content-Length': data.ContentLength,
        'Content-Type': item.mime,
        'Accept-Ranges': 'bytes',
      });
    }
    data.Body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: 'Error al transmitir el archivo' });
  }
});

// Borrar un archivo
app.delete('/api/media/:id', async (req, res) => {
  const items = await readLibrary();
  const idx = items.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Archivo no encontrado' });

  const [item] = items.splice(idx, 1);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: item.key }));
  } catch (e) {}
  await writeLibrary(items);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});