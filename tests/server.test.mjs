import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { PlannerStore } from '../server/store.mjs';
import { createServer } from '../server/index.mjs';

const day = '2026-10-23';
const task = (title = 'Python Coding', date = day, estimatedMinutes = 60) => ({ title, date, estimatedMinutes });
const plan = (tasks) => ({ schemaVersion: 1, timezone: 'Asia/Shanghai', tasks });
function setup(t, extra = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'daily-planner-test-'));
  const store = new PlannerStore({ dataDir, ...extra });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { store, dataDir };
}
function write(store, operation, args, revision = store.revision()) { return store.operation(operation, args, revision); }
function throwsCode(fn, code, status) { assert.throws(fn, (error) => error.code === code && (status === undefined || error.status === status)); }

test('CRUD: stable UUID, editable fields, reorder, move, status, summaries, delete and durable undo', (t) => {
  const { store, dataDir } = setup(t);
  assert.deepEqual(store.state().tasks, []);
  const a = write(store, 'createTask', { task: task() }).task;
  const b = write(store, 'createTask', { task: task('AI 筛选投递', day, 30) }).task;
  const c = write(store, 'createTask', { task: { ...task('休息', day, 20), status: 'cancelled' } }).task;
  assert.match(a.id, /^[a-f\d-]{36}$/); assert.equal(a.status, 'todo'); assert.equal(a.order, 0); assert.equal(b.order, 1);
  write(store, 'reorderTasks', { date: day, ids: [c.id, b.id, a.id] });
  assert.deepEqual(store.state().tasks.map((item) => item.id), [c.id, b.id, a.id]);
  write(store, 'updateTask', { id: a.id, patch: { title: 'Python', description: '练习', status: 'done', actualMinutes: 75, priority: 'high', category: 'Coding' } });
  assert.deepEqual(store.state().summary[day], { total: 2, completed: 1, totalMinutes: 90, completedMinutes: 60, progress: 0.5 });
  write(store, 'moveTask', { id: b.id, date: '2026-10-24' });
  assert.equal(store.state().summary[day].progress, 1);
  assert.equal(store.operation('getTask', { id: b.id }).task.date, '2026-10-24');
  assert.equal(store.operation('listTasks', { from: '2026-10-24', to: '2026-10-30' }).tasks.length, 1);
  const deleted = write(store, 'deleteTask', { id: a.id });
  assert.equal(store.state().summary[day].total, 0);
  // History survives closing and opening the actual SQLite store.
  store.close(); const reopened = new PlannerStore({ dataDir });
  t.after(() => reopened.close());
  write(reopened, 'undoChanges', { changeId: deleted.changeId });
  assert.equal(reopened.operation('getTask', { id: a.id }).task.actualMinutes, 75);
  assert.equal(reopened.state().summary[day].completedMinutes, 60);
});

test('validation rejects invalid dates, durations, fields, order, IDs and immutable patches atomically', (t) => {
  const { store } = setup(t);
  const cases = [
    { date: '2026-02-29' }, { date: '2026-99-01' }, { date: '2026-2-01' }, { date: '2026-04-31' },
    { estimatedMinutes: 0 }, { estimatedMinutes: 1.5 }, { estimatedMinutes: 1441 }, { actualMinutes: -1 },
    { actualMinutes: 10081 }, { status: 'finished' }, { priority: 'urgent' }, { title: '  ' },
    { title: 'x'.repeat(201) }, { category: 'x'.repeat(61) }, { id: randomUUID() }, { order: 4 },
  ];
  for (const patch of cases) throwsCode(() => write(store, 'createTask', { task: { ...task(), ...patch } }), 'VALIDATION');
  assert.equal(store.revision(), 0); assert.equal(store.state().tasks.length, 0);
  const created = write(store, 'createTask', { task: task() }).task;
  throwsCode(() => write(store, 'updateTask', { id: created.id, patch: { id: randomUUID() } }), 'VALIDATION');
  throwsCode(() => write(store, 'updateTask', { id: created.id, patch: { status: 'done', estimatedMinutes: -3 } }), 'VALIDATION');
  assert.equal(store.operation('getTask', { id: created.id }).task.status, 'todo');
  throwsCode(() => write(store, 'reorderTasks', { date: day, ids: [] }), 'VALIDATION');
  throwsCode(() => write(store, 'reorderTasks', { date: day, ids: [created.id, created.id] }), 'VALIDATION');
  throwsCode(() => store.operation('getTask', { id: '0' }), 'VALIDATION');
  throwsCode(() => store.operation('listTasks', { from: '2026-10-24', to: day }), 'VALIDATION');
  throwsCode(() => store.operation('getTask', { id: randomUUID() }), 'NOT_FOUND', 404);
  throwsCode(() => store.operation('createTask', { task: task() }), 'VALIDATION');
});

test('simultaneous editors and separate local stores cannot silently overwrite; stale undo refuses', (t) => {
  const { store, dataDir } = setup(t); const other = new PlannerStore({ dataDir }); t.after(() => other.close());
  const revision = other.state().revision;
  const a = write(store, 'createTask', { task: task() }, revision);
  throwsCode(() => write(other, 'createTask', { task: task('stale') }, revision), 'REVISION_CONFLICT', 409);
  assert.equal(other.state().tasks.length, 1);
  write(other, 'createTask', { task: task('second') });
  throwsCode(() => write(store, 'undoChanges', { changeId: a.changeId }), 'UNDO_CONFLICT', 409);
  assert.equal(store.state().tasks.length, 2);
});

test('import defaults to append; invalid import and duplicate IDs leave original data and revision intact', (t) => {
  const { store } = setup(t);
  const a = write(store, 'createTask', { task: task() }).task;
  const before = store.state();
  const invalid = [
    plan([task('ok'), task('bad', '2026-02-30')]), plan([{ ...task(), estimatedMinutes: '60' }]),
    plan([{ ...task(), id: a.id }, { ...task(), id: a.id }]), { ...plan([task()]), schemaVersion: 2 },
    { ...plan([task()]), timezone: 'America/New_York' }, plan([]), plan([{ ...task(), id: 'index-0' }]),
    plan([{ ...task(), createdAt: 'yesterday' }]),
  ];
  for (const bad of invalid) throwsCode(() => store.operation('previewChanges', { import: { plan: bad } }), 'VALIDATION');
  throwsCode(() => store.operation('previewChanges', { import: { plan: plan([a]) } }), 'VALIDATION');
  assert.deepEqual(store.state(), before);
  const preview = store.operation('previewChanges', { import: { plan: plan([task('408', '2026-10-24', 45)]) } });
  assert.equal(preview.taskCount, 2); assert.equal(preview.importedTaskCount, 1); assert.equal(preview.importSummary['2026-10-24'].totalMinutes, 45);
  assert.equal(store.revision(), before.revision); assert.equal(store.state().tasks.length, 1);
  write(store, 'applyChanges', { previewId: preview.previewId });
  assert.equal(store.state().tasks.length, 2); assert.equal(store.operation('getTask', { id: a.id }).task.title, a.title);
});

test('merge matches stable IDs and replace touches only imported dates; import itself can be undone', (t) => {
  const { store } = setup(t);
  const a = write(store, 'createTask', { task: task() }).task;
  const b = write(store, 'createTask', { task: task('next day', '2026-10-24', 30) }).task;
  let preview = store.operation('previewChanges', { import: { plan: plan([{ ...a, title: 'merged', estimatedMinutes: 90 }]), mode: 'merge' } });
  assert.equal(preview.changes.updated, 1);
  write(store, 'applyChanges', { previewId: preview.previewId });
  assert.equal(store.operation('getTask', { id: a.id }).task.title, 'merged');
  preview = store.operation('previewChanges', { import: { plan: plan([task('replacement', day, 15)]), mode: 'replace' } });
  assert.equal(preview.changes.deleted, 1);
  const applied = write(store, 'applyChanges', { previewId: preview.previewId });
  throwsCode(() => store.operation('getTask', { id: a.id }), 'NOT_FOUND');
  assert.deepEqual(store.operation('getTask', { id: b.id }).task, b);
  write(store, 'undoChanges', { changeId: applied.changeId });
  assert.equal(store.operation('getTask', { id: a.id }).task.title, 'merged');
});

test('import honors explicit order even when input array is unsorted', (t) => {
  const { store } = setup(t);
  const preview = store.operation('previewChanges', { import: { plan: plan([{ ...task('third'), order: 20 }, { ...task('first'), order: 0 }, { ...task('second'), order: 10 }]) } });
  write(store, 'applyChanges', { previewId: preview.previewId });
  assert.deepEqual(store.state().tasks.map((task) => task.title), ['first', 'second', 'third']);
  assert.deepEqual(store.state().tasks.map((task) => task.order), [0, 1, 2]);
});

test('startup rejects corrupted persisted timestamps while retaining existing records', (t) => {
  const { store, dataDir } = setup(t);
  const created = write(store, 'createTask', { task: task() }).task; store.close();
  const db = new DatabaseSync(join(dataDir, 'planner.sqlite'));
  db.prepare('UPDATE tasks SET document=? WHERE id=?').run(JSON.stringify({ ...created, createdAt: 'broken' }), created.id); db.close();
  throwsCode(() => new PlannerStore({ dataDir }), 'STORAGE_UNAVAILABLE');
  const inspect = new DatabaseSync(join(dataDir, 'planner.sqlite'));
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM tasks').get().n, 1); inspect.close();
});

test('batch preview/apply is atomic, optimistic, single-use, expiring and transient across restarts', (t) => {
  let now = new Date('2026-10-23T12:00:00.000Z'); const { store, dataDir } = setup(t, { now: () => now });
  throwsCode(() => store.operation('previewChanges', { operations: [ { operation: 'createTask', args: { task: task() } }, { operation: 'createTask', args: { task: task('bad', day, -1) } } ] }), 'VALIDATION');
  assert.equal(store.state().tasks.length, 0);
  const p = store.operation('previewChanges', { operations: [{ operation: 'createTask', args: { task: task() } }] });
  write(store, 'createTask', { task: task('intervening') });
  throwsCode(() => write(store, 'applyChanges', { previewId: p.previewId }), 'REVISION_CONFLICT');
  const expired = store.operation('previewChanges', { import: { plan: plan([task()]) } });
  now = new Date(now.getTime() + 15 * 60000);
  throwsCode(() => write(store, 'applyChanges', { previewId: expired.previewId }), 'PREVIEW_EXPIRED');
  const current = store.operation('previewChanges', { import: { plan: plan([task()]) } });
  const applied = write(store, 'applyChanges', { previewId: current.previewId });
  throwsCode(() => write(store, 'applyChanges', { previewId: current.previewId }), 'PREVIEW_EXPIRED');
  assert.equal(applied.revision, 2);
  const transient = store.operation('previewChanges', { import: { plan: plan([task()]) } });
  store.close(); const reopened = new PlannerStore({ dataDir }); t.after(() => reopened.close());
  throwsCode(() => write(reopened, 'applyChanges', { previewId: transient.previewId }), 'PREVIEW_EXPIRED');
});

test('explicit timezone handles midnight and DST independently of machine timezone', (t) => {
  let now = new Date('2026-10-23T15:59:59Z'); const { store } = setup(t, { now: () => now });
  assert.equal(store.state().today, '2026-10-23'); now = new Date('2026-10-23T16:00:00Z'); assert.equal(store.state().today, '2026-10-24');
  let dst = new Date('2026-11-01T05:59:59Z'); const { store: ny } = setup(t, { timezone: 'America/New_York', now: () => dst });
  assert.equal(ny.state().today, '2026-11-01'); dst = new Date('2026-11-01T06:00:00Z'); assert.equal(ny.state().today, '2026-11-01');
  dst = new Date('2026-11-02T05:00:00Z'); assert.equal(ny.state().today, '2026-11-02');
});

test('backups are recoverable JSON and bounded; backup failure aborts writes; corrupt DB is retained', (t) => {
  const { store, dataDir } = setup(t);
  for (let i = 0; i < 32; i++) write(store, 'createTask', { task: task(`task ${i}`) });
  const files = readdirSync(join(dataDir, 'backups'));
  assert.equal(files.length, 30);
  const snapshot = JSON.parse(readFileSync(join(dataDir, 'backups', files.sort().at(-1)), 'utf8'));
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.tasks.length, 31); assert.equal(snapshot.revision, 31);
  const recovery = store.operation('previewChanges', { import: { plan: snapshot, mode: 'replace' } });
  assert.equal(recovery.taskCount, 31); assert.equal(recovery.changes.deleted, 1);
  const before = store.state();
  renameSync(join(dataDir, 'backups'), join(dataDir, 'backups-safe')); writeFileSync(join(dataDir, 'backups'), 'blocked');
  throwsCode(() => write(store, 'createTask', { task: task('unsaved') }), 'BACKUP_FAILED', 500);
  assert.deepEqual(store.state(), before);
  rmSync(join(dataDir, 'backups')); renameSync(join(dataDir, 'backups-safe'), join(dataDir, 'backups'));
  store.close();
  throwsCode(() => new PlannerStore({ dataDir, timezone: 'UTC' }), 'TIMEZONE_MISMATCH');
  const badDir = join(dataDir, 'corrupt'); mkdirSync(badDir); const bad = Buffer.from('This is not a SQLite database');
  writeFileSync(join(badDir, 'planner.sqlite'), bad);
  throwsCode(() => new PlannerStore({ dataDir: badDir }), 'STORAGE_UNAVAILABLE');
  assert.deepEqual(readFileSync(join(badDir, 'planner.sqlite')), bad);
});

async function httpSetup(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'daily-planner-http-'));
  const server = createServer({ dataDir }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); });
  const rpc = async (operation, args, expectedRevision, headers = {}) => fetch(`${url}/api/operations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-daily-planner': '1', ...headers }, body: JSON.stringify({ operation, args, expectedRevision }) });
  return { server, url, rpc, dataDir };
}

test('HTTP service close and new server instance reopen the same durable tasks', async (t) => {
  const { server, rpc, dataDir } = await httpSetup(t);
  const created = await (await rpc('createTask', { task: task('persist across HTTP restart') }, 0)).json();
  await new Promise((resolveClose) => server.close(resolveClose));
  const reopened = createServer({ dataDir }); reopened.listen(0, '127.0.0.1'); await once(reopened, 'listening');
  t.after(() => new Promise((resolveClose) => reopened.close(resolveClose)));
  const state = await (await fetch(`http://127.0.0.1:${reopened.address().port}/api/state`)).json();
  assert.equal(state.revision, 1); assert.equal(state.tasks[0].id, created.task.id); assert.equal(state.tasks[0].title, created.task.title);
});

test('HTTP: loopback, health identity, CRUD, SSE, export and state survive editor disconnect', async (t) => {
  const { server, url, rpc } = await httpSetup(t);
  assert.equal(server.address().address, '127.0.0.1');
  const health = await (await fetch(`${url}/health`)).json(); assert.equal(health.ok, true); assert.equal(health.app, 'daily-planner'); assert.equal(health.pid, process.pid); assert.match(health.instanceId, /^[a-f\d-]{36}$/);
  const abort = new AbortController(); const eventResponse = await fetch(`${url}/api/events`, { signal: abort.signal });
  const reader = eventResponse.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /event: change/);
  const response = await rpc('createTask', { task: task() }, 0); assert.equal(response.status, 200); const created = await response.json();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"revision":1/);
  await reader.cancel(); abort.abort();
  const state = await (await fetch(`${url}/api/state`)).json(); assert.equal(state.tasks[0].id, created.task.id);
  const exported = await fetch(`${url}/api/export`); assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.deepEqual((await exported.json()).tasks, state.tasks);
  assert.equal((await rpc('updateTask', { id: created.task.id, patch: { status: 'done' } }, 0)).status, 409);
  assert.equal((await rpc('updateTask', { id: created.task.id, patch: { status: 'done' } }, 1)).status, 200);
});

test('HTTP rejects hostile Origin, null Origin, rebinding Host, cross-site, missing header, malformed JSON and path traversal', async (t) => {
  const { url, rpc } = await httpSetup(t);
  const payload = { task: task() };
  for (const origin of ['http://evil.test', 'null', 'http://localhost:43117', `${url}.evil.test`]) {
    const response = await rpc('createTask', payload, 0, { origin }); assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await rpc('createTask', payload, 0, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${url}/health`, { headers: { host: 'evil.test' } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHostStatus, 403);
  const missing = await fetch(`${url}/api/operations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(missing.status, 403);
  const badJson = await fetch(`${url}/api/operations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-daily-planner': '1' }, body: '{bad' }); assert.equal(badJson.status, 400);
  const badType = await rpc('listTasks', {}, undefined, { 'content-type': 'text/plain' }); assert.equal(badType.status, 415);
  assert.equal((await fetch(`${url}/server/store.mjs`)).status, 404);
  assert.equal((await fetch(`${url}/%2e%2e%2fCONTRACT.md`)).status, 404);
  assert.equal((await fetch(`${url}/api/operations`, { method: 'OPTIONS' })).status, 404);
  assert.equal((await rpc('createTask', payload, 0, { origin: url })).status, 200);
  assert.equal((await (await fetch(`${url}/api/state`)).json()).tasks.length, 1);
});

test('HTTP concurrent writes from the same base revision produce exactly one commit', async (t) => {
  const { rpc, url } = await httpSetup(t);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => rpc('createTask', { task: task(`task ${index}`) }, 0)));
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 7);
  assert.equal((await (await fetch(`${url}/api/state`)).json()).tasks.length, 1);
});

test('HTTP oversized JSON receives clean 413 without writing or breaking subsequent reads', async (t) => {
  const { url } = await httpSetup(t);
  const response = await fetch(`${url}/api/operations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-daily-planner': '1' }, body: JSON.stringify({ operation: 'createTask', args: { task: { ...task(), description: 'x'.repeat(4 * 1024 * 1024) } }, expectedRevision: 0 }) });
  assert.equal(response.status, 413); assert.equal((await response.json()).error.code, 'BODY_TOO_LARGE');
  const chunked = await new Promise((resolveResponse, reject) => {
    const req = request(`${url}/api/operations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-daily-planner': '1' } }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolveResponse({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.write('x'.repeat(4 * 1024 * 1024)); req.end('x');
  });
  assert.equal(chunked.status, 413); assert.equal(chunked.body.error.code, 'BODY_TOO_LARGE');
  assert.equal((await (await fetch(`${url}/api/state`)).json()).revision, 0);
});
