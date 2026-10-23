import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { shellQuote, settings, createClient, formatMinutes, dateInTimezone, dateLabel, todayTasks, summarize } from './src/client.js';

test('native bridge quotes task text as a literal shell argument', () => {
  const text = "quote' $HOME $(printf injected) `printf bad`\n中文";
  const result = spawnSync('/bin/sh', ['-c', 'printf %s ' + shellQuote(text)], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, text);
});

test('calendar dates change at midnight in the configured timezone', () => {
  assert.equal(dateInTimezone('Asia/Shanghai', new Date('2026-10-23T15:59:59Z')), '2026-10-23');
  assert.equal(dateInTimezone('Asia/Shanghai', new Date('2026-10-23T16:00:00Z')), '2026-10-24');
  assert.equal(dateInTimezone('America/Los_Angeles', new Date('2026-10-23T16:00:00Z')), '2026-10-23');
  assert.match(dateLabel('2026-10-23'), /星期五/);
});

test('count progress and planned minutes exclude cancelled tasks', () => {
  const tasks = [
    { id: 'b', date: '2026-10-23', order: 2, status: 'todo', estimatedMinutes: 30 },
    { id: 'a', date: '2026-10-23', order: 1, status: 'done', estimatedMinutes: 60 },
    { id: 'c', date: '2026-10-23', order: 0, status: 'cancelled', estimatedMinutes: 90 },
  ];
  assert.deepEqual(todayTasks({ today: '2026-10-23', tasks }).map(task => task.id), ['a', 'b']);
  assert.deepEqual(summarize(tasks), { total: 2, completed: 1, totalMinutes: 90, completedMinutes: 60, progress: .5 });
  assert.equal(formatMinutes(90), '1 小时 30 分');
  assert.deepEqual(summarize([]), { total: 0, completed: 0, totalMinutes: 0, completedMinutes: 0, progress: 0 });
});

test('configuration bounds limit polling and task count', () => {
  assert.equal(settings({ refreshSeconds: 1 }).refreshSeconds, 15);
  assert.equal(settings({ port: 'invalid' }).port, 43117);
  assert.equal(settings({ maxTasks: 100 }).maxTasks, 7);
  assert.equal(settings({ scale: -1 }).scale, .6);
});

test('native client sends revision and write header, opens encoded local URL, exposes API errors', async () => {
  let command = '';
  const client = createClient(async value => { command = value; return JSON.stringify({ revision: 1, today: '2026-10-23', tasks: [] }); }, 43117);
  await client.write('updateTask', { id: 'stable-id', patch: { status: 'done' } }, 7);
  assert.match(command, /X-Daily-Planner: 1/);
  assert.match(command, /"expectedRevision":7/);
  assert.match(command, /--noproxy/);
  assert.equal((await client.read()).revision, 1);
  await client.open("apostrophe'and space");
  assert.match(command, /\/usr\/bin\/open/);
  assert.match(command, /127\.0\.0\.1:43117\/#task=/);
  await assert.rejects(() => createClient(async () => '{"error":{"code":"REVISION_CONFLICT","message":"changed"}}', 43117).write('updateTask', {}, 1), error => error.code === 'REVISION_CONFLICT' && error.message === 'changed');
  await assert.rejects(() => createClient(async () => 'bad json', 43117).read(), /无法连接/);
});
