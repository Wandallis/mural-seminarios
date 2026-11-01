import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { initializeDatabase, pool } from './db.js';
import { createStorage } from './storage.js';

const port = Number(process.env.PORT || 3000);
const maxUploadSize = Number(process.env.MAX_UPLOAD_SIZE_BYTES || 10 * 1024 * 1024);
const storage = createStorage();
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadSize, files: 1 },
  fileFilter(_request, file, callback) {
    if (file.mimetype !== 'application/pdf') {
      callback(new Error('Envie os slides em formato PDF.'));
      return;
    }
    callback(null, true);
  }
});

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT deve ser um numero entre 1 e 65535.');
}
if (!Number.isSafeInteger(maxUploadSize) || maxUploadSize <= 0) {
  throw new Error('MAX_UPLOAD_SIZE_BYTES deve ser um inteiro positivo.');
}

const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin || corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origem nao permitida pela politica CORS.'));
  }
});

app.use((request, response, next) => {
  const origin = request.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host === request.get('host')?.toLowerCase()) {
        next();
        return;
      }
    } catch {
      // Invalid origins are rejected by the CORS middleware.
    }
  }
  corsMiddleware(request, response, next);
});
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    response.json({ status: 'UP', database: 'UP', cloud: process.env.CLOUD_PROVIDER || 'aws' });
  } catch (error) {
    console.error('Verificacao de saude do banco falhou:', error);
    response.status(503).json({ status: 'DOWN', database: 'DOWN' });
  }
});

app.get('/api/seminars', async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.title,
             COALESCE(p.names, CASE WHEN s.presenter <> '' THEN ARRAY[s.presenter] ELSE s.presenters END) AS presenters,
             s.description, s.location, s.starts_at,
             s.slides_key IS NOT NULL AS has_slides, s.created_at,
             COALESCE(p.attendance_count, 0)::INTEGER AS attendance_count
      FROM seminars s
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(sp.name ORDER BY sp.id) AS names,
               COUNT(*) FILTER (WHERE sp.is_present)::INTEGER AS attendance_count
        FROM seminar_presenters sp
        WHERE sp.seminar_id = s.id
      ) p ON TRUE
      ORDER BY s.starts_at ASC, s.id ASC
    `);
    response.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/slides/uploads', async (request, response, next) => {
  if (typeof storage.createUploadUrl !== 'function') {
    response.status(404).json({ error: 'Upload direto para storage nao esta habilitado.' });
    return;
  }
  if (request.body?.contentType !== 'application/pdf' ||
      !Number.isSafeInteger(request.body?.size) ||
      request.body.size < 1 ||
      request.body.size > maxUploadSize) {
    response.status(400).json({ error: 'Envie um PDF valido dentro do limite de tamanho.' });
    return;
  }

  try {
    response.json(await storage.createUploadUrl(maxUploadSize));
  } catch (error) {
    next(error);
  }
});

app.get('/api/seminars/:id/presenters', async (request, response, next) => {
  if (!/^\d+$/.test(request.params.id)) {
    response.status(400).json({ error: 'Identificador de seminario invalido.' });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT id, name, is_present FROM seminar_presenters WHERE seminar_id = $1 ORDER BY LOWER(name), id',
      [request.params.id]
    );
    response.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/seminars/:id/presenters/:presenterId', async (request, response, next) => {
  if (!/^\d+$/.test(request.params.id) || !/^\d+$/.test(request.params.presenterId)) {
    response.status(400).json({ error: 'Identificador invalido.' });
    return;
  }
  if (typeof request.body?.isPresent !== 'boolean') {
    response.status(400).json({ error: 'Informe isPresent como verdadeiro ou falso.' });
    return;
  }

  try {
    const result = await pool.query(
      `UPDATE seminar_presenters SET is_present = $3
       WHERE seminar_id = $1 AND id = $2
       RETURNING id, name, is_present`,
      [request.params.id, request.params.presenterId, request.body.isPresent]
    );
    if (result.rowCount === 0) {
      response.status(404).json({ error: 'Apresentador nao encontrado neste seminario.' });
      return;
    }
    response.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/seminars', upload.single('slides'), async (request, response, next) => {
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body
    : {};
  const { title, description = '', location, startsAt } = body;
  const rawPresenters = Array.isArray(body.presenters) ? body.presenters : [body.presenters];
  const presenters = rawPresenters
    .filter((presenter) => typeof presenter === 'string')
    .map((presenter) => presenter.trim())
    .filter(Boolean);
  const fields = { title, location };

  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      response.status(400).json({ error: `O campo "${field}" e obrigatorio.` });
      return;
    }
  }
  if (typeof description !== 'string') {
    response.status(400).json({ error: 'O campo "description" deve ser um texto.' });
    return;
  }
  if (presenters.length === 0 || presenters.length > 10 ||
      presenters.some((presenter) => presenter.length > 200)) {
    response.status(400).json({ error: 'Informe de 1 a 10 apresentadores (ate 200 caracteres cada).' });
    return;
  }
  if (new Set(presenters.map((presenter) => presenter.toLocaleLowerCase('pt-BR'))).size !== presenters.length) {
    response.status(400).json({ error: 'Cada apresentador deve aparecer apenas uma vez.' });
    return;
  }
  if (title.trim().length > 200 ||
      location.trim().length > 200 || description.length > 5000) {
    response.status(400).json({ error: 'Revise o tamanho dos campos do seminario.' });
    return;
  }

  if (typeof startsAt !== 'string' || !Number.isFinite(new Date(startsAt).getTime())) {
    response.status(400).json({ error: 'Informe uma data e horario validos.' });
    return;
  }
  const parsedDate = new Date(startsAt);

  if (request.file && request.file.buffer.subarray(0, 5).toString() !== '%PDF-') {
    response.status(400).json({ error: 'O arquivo selecionado nao e um PDF valido.' });
    return;
  }

  const uploadedKey = body.slidesKey;
  if (uploadedKey !== undefined &&
      (typeof uploadedKey !== 'string' ||
       !/^pending\/[0-9a-f-]{36}\.pdf$/i.test(uploadedKey) ||
       typeof storage.validateUploadedFile !== 'function' ||
       typeof storage.finalizeUpload !== 'function')) {
    response.status(400).json({ error: 'Referencia de upload de slides invalida.' });
    return;
  }

  let slidesKey = uploadedKey;
  let client;
  try {
    if (request.file) {
      slidesKey = await storage.uploadFile(request.file.buffer);
    } else if (uploadedKey) {
      await storage.validateUploadedFile(uploadedKey, maxUploadSize);
      slidesKey = await storage.finalizeUpload(uploadedKey);
    }

    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO seminars (title, presenter, presenters, description, location, starts_at, slides_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, title, presenters, description, location, starts_at,
                 slides_key IS NOT NULL AS has_slides, created_at`,
      [
        title.trim(),
        presenters.join(', '),
        presenters,
        description.trim(),
        location.trim(),
        parsedDate.toISOString(),
        slidesKey || null
      ]
    );
    await client.query(
      `INSERT INTO seminar_presenters (seminar_id, name)
       SELECT $1, name FROM UNNEST($2::text[]) AS names(name)`,
      [result.rows[0].id, presenters]
    );
    await client.query('COMMIT');
    response.status(201).json({ ...result.rows[0], attendance_count: 0 });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Nao foi possivel reverter o cadastro do seminario:', rollbackError);
      }
    }
    if (slidesKey) {
      try {
        await storage.deleteFile(slidesKey);
      } catch (cleanupError) {
        console.error('Nao foi possivel remover o slide apos falha no cadastro:', cleanupError);
      }
    }
    next(error);
  } finally {
    client?.release();
  }
});

app.get('/api/seminars/:id/slides', async (request, response, next) => {
  if (!/^\d+$/.test(request.params.id)) {
    response.status(400).json({ error: 'Identificador de seminario invalido.' });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT slides_key FROM seminars WHERE id = $1',
      [request.params.id]
    );
    if (result.rowCount === 0) {
      response.status(404).json({ error: 'Seminario nao encontrado.' });
      return;
    }
    if (!result.rows[0].slides_key) {
      response.status(404).json({ error: 'Este seminario ainda nao possui slides.' });
      return;
    }

    if (typeof storage.createDownloadUrl === 'function') {
      response.redirect(302, await storage.createDownloadUrl(result.rows[0].slides_key));
      return;
    }

    const slides = await storage.downloadFile(result.rows[0].slides_key);
    response
      .type('application/pdf')
      .set('Content-Disposition', 'attachment; filename="slides.pdf"')
      .send(slides);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/seminars/:id', async (request, response, next) => {
  if (!/^\d+$/.test(request.params.id)) {
    response.status(400).json({ error: 'Identificador de seminario invalido.' });
    return;
  }

  try {
    const result = await pool.query(
      'DELETE FROM seminars WHERE id = $1 RETURNING slides_key',
      [request.params.id]
    );
    if (result.rowCount === 0) {
      response.status(404).json({ error: 'Seminario nao encontrado.' });
      return;
    }

    const { slides_key: slidesKey } = result.rows[0];
    if (slidesKey) {
      try {
        await storage.deleteFile(slidesKey);
      } catch (error) {
        console.error(`Seminario ${request.params.id} excluido, mas o PDF ${slidesKey} nao foi removido:`, error);
        response.status(500).json({
          error: 'Seminario excluido, mas nao foi possivel remover o PDF do armazenamento.'
        });
        return;
      }
    }
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((_request, response) => {
  response.status(404).json({ error: 'Rota nao encontrada.' });
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    response.status(status).json({ error: status === 413 ? 'PDF excede o limite de tamanho.' : error.message });
    return;
  }
  if (error.message.startsWith('Envie os slides em formato PDF.')) {
    response.status(400).json({ error: error.message });
    return;
  }
  if (error.message.startsWith('Origem nao permitida')) {
    response.status(403).json({ error: error.message });
    return;
  }
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    response.status(error.status).json({ error: error.message });
    return;
  }

  console.error('Erro ao processar requisicao:', error);
  response.status(500).json({ error: 'Erro interno ao processar a requisicao.' });
});

let server;

async function start() {
  await initializeDatabase();
  server = app.listen(port, () => {
    console.log(`API rodando na porta ${port}`);
  });
}

async function shutdown(signal) {
  console.log(`Recebido ${signal}; encerrando a API.`);
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  await pool.end();
}

process.on('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
  console.error('Erro ao encerrar a aplicacao:', error);
  process.exitCode = 1;
}));
process.on('SIGINT', () => shutdown('SIGINT').catch((error) => {
  console.error('Erro ao encerrar a aplicacao:', error);
  process.exitCode = 1;
}));

start().catch((error) => {
  console.error('Nao foi possivel iniciar a aplicacao:', error);
  process.exitCode = 1;
});

export { app };
