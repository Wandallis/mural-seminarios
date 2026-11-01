import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import test from 'node:test';

const { Pool } = pg;
const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function readJson(response) {
  return response.json();
}

test('cadastra apresentadores, registra a presenca de cada um e apaga seminario e slides', async () => {
  if (process.env.NODE_ENV !== 'test' || !process.env.DATABASE_URL ||
      new URL(process.env.DATABASE_URL).pathname !== '/mural_test') {
    throw new Error('Defina NODE_ENV=test e DATABASE_URL para um banco dedicado chamado mural_test.');
  }

  const testDirectory = await mkdtemp(path.join(tmpdir(), 'mural-api-test-'));
  const port = await unusedPort();
  const database = new Pool({ connectionString: process.env.DATABASE_URL });
  let server;
  let logs = '';

  try {
    server = spawn(process.execPath, ['src/index.js'], {
      cwd: backendDirectory,
      env: {
        ...process.env,
        PORT: String(port),
        CLOUD_PROVIDER: 'local',
        LOCAL_STORAGE_DIR: testDirectory,
        DB_SSL: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
    server.stderr.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });

    const baseUrl = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (server.exitCode !== null) {
        throw new Error(`API encerrou durante a inicializacao.\n${logs}`);
      }
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) {
          await response.arrayBuffer();
          healthy = true;
          break;
        }
      } catch {
        await delay(250);
      }
    }
    assert.equal(healthy, true, `API nao ficou pronta.\n${logs}`);
    await database.query('TRUNCATE attendance, seminars RESTART IDENTITY CASCADE');

    const directUpload = await fetch(`${baseUrl}/api/slides/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'application/pdf', size: 20 })
    });
    assert.equal(directUpload.status, 404);

    const form = new FormData();
    form.set('title', 'Seminario de teste');
    form.append('presenters', 'Ana Pesquisadora');
    form.append('presenters', 'Bruno Pesquisador');
    form.set('location', 'Sala 1');
    form.set('startsAt', new Date(Date.now() + 60_000).toISOString());
    form.set('slides', new Blob(['%PDF-1.4\nconteudo de teste'], {
      type: 'application/pdf'
    }), 'slides.pdf');
    const createdResponse = await fetch(`${baseUrl}/api/seminars`, {
      method: 'POST',
      body: form
    });
    assert.equal(createdResponse.status, 201);
    const seminar = await readJson(createdResponse);
    assert.equal(seminar.title, 'Seminario de teste');
    assert.deepEqual(seminar.presenters, ['Ana Pesquisadora', 'Bruno Pesquisador']);
    assert.equal(seminar.has_slides, true);

    const slidesResponse = await fetch(`${baseUrl}/api/seminars/${seminar.id}/slides`);
    assert.equal(slidesResponse.status, 200);
    assert.match(await slidesResponse.text(), /^%PDF-/);

    const invalidFile = new FormData();
    invalidFile.set('title', 'Arquivo invalido');
    invalidFile.set('presenters', 'Pessoa');
    invalidFile.set('location', 'Sala');
    invalidFile.set('startsAt', new Date(Date.now() + 60_000).toISOString());
    invalidFile.set('slides', new Blob(['nao e pdf'], { type: 'application/pdf' }), 'fake.pdf');
    const rejectedUpload = await fetch(`${baseUrl}/api/seminars`, {
      method: 'POST',
      body: invalidFile
    });
    assert.equal(rejectedUpload.status, 400);

    const presenterResponse = await fetch(`${baseUrl}/api/seminars/${seminar.id}/presenters`);
    const seminarPresenters = await readJson(presenterResponse);
    assert.deepEqual(seminarPresenters.map(({ name, is_present }) => ({ name, is_present })), [
      { name: 'Ana Pesquisadora', is_present: false },
      { name: 'Bruno Pesquisador', is_present: false }
    ]);
    const presenter = seminarPresenters[0];

    const listResponse = await fetch(`${baseUrl}/api/seminars`);
    const seminars = await readJson(listResponse);
    assert.equal(seminars.length, 1);
    assert.equal(seminars[0].attendance_count, 0);

    const markResponse = await fetch(
      `${baseUrl}/api/seminars/${seminar.id}/presenters/${presenter.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPresent: true })
      }
    );
    assert.equal(markResponse.status, 200);
    assert.equal((await readJson(markResponse)).is_present, true);

    const updatedPresentersResponse = await fetch(`${baseUrl}/api/seminars/${seminar.id}/presenters`);
    const updatedPresenters = await readJson(updatedPresentersResponse);
    assert.equal(updatedPresenters[0].name, 'Ana Pesquisadora');
    assert.equal(updatedPresenters[0].is_present, true);

    const presentListResponse = await fetch(`${baseUrl}/api/seminars`);
    assert.equal((await readJson(presentListResponse))[0].attendance_count, 1);

    const unmarkResponse = await fetch(
      `${baseUrl}/api/seminars/${seminar.id}/presenters/${presenter.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPresent: false })
      }
    );
    assert.equal(unmarkResponse.status, 200);
    assert.equal((await readJson(unmarkResponse)).is_present, false);

    const absentListResponse = await fetch(`${baseUrl}/api/seminars`);
    assert.equal((await readJson(absentListResponse))[0].attendance_count, 0);

    const deleteResponse = await fetch(`${baseUrl}/api/seminars/${seminar.id}`, {
      method: 'DELETE'
    });
    assert.equal(deleteResponse.status, 204);
    const afterDeleteResponse = await fetch(`${baseUrl}/api/seminars`);
    assert.deepEqual(await readJson(afterDeleteResponse), []);

    const deletedSlidesResponse = await fetch(`${baseUrl}/api/seminars/${seminar.id}/slides`);
    assert.equal(deletedSlidesResponse.status, 404);
    assert.deepEqual(await readdir(testDirectory), []);
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        delay(5000).then(() => { throw new Error('Timeout ao encerrar a API de teste.'); })
      ]);
    }
    await database.end();
    await rm(testDirectory, { recursive: true, force: true });
  }
});
