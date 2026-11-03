import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { shellQuote, settings, createClient, formatMinutes, dateInTimezone, dateLabel, todayTasks, summarize, addCalendarDays, viewModel, updateView, codexUsageView, formatCodexReset, formatCodexCountdown, formatCodexWindowLabel, updateQuotaState, formatCodexUpdatedAt } from './src/client.js';

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

test('seven-day calendar arithmetic crosses months, years, leap days and DST without timezone shifts', () => {
  assert.equal(addCalendarDays('2026-10-30', 7), '2026-11-06');
  assert.equal(addCalendarDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addCalendarDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addCalendarDays('2026-03-07', 2), '2026-03-09');
});

const browsingData = {
  today: '2026-10-23', timezone: 'Asia/Shanghai', revision: 9,
  tasks: [
    {id: 'tomorrow-done', date: '2026-10-24', order: 2, status: 'done', estimatedMinutes: 60},
    {id: 'tomorrow-first', date: '2026-10-24', order: 1, status: 'todo', estimatedMinutes: 90},
    {id: 'cancelled', date: '2026-10-24', order: 0, status: 'cancelled', estimatedMinutes: 120},
    {id: 'last-day', date: '2026-10-30', order: 0, status: 'todo', estimatedMinutes: 50},
  ],
};

test('seven-day view separates weekly totals from selected date tasks and completion', () => {
  const state = updateView({type: 'PLANNER/DAY', date: '2026-10-24'}, {view: 'week', weekOffset: 0});
  const view = viewModel(browsingData, state);
  assert.deepEqual([view.start, view.end, view.date], ['2026-10-23', '2026-10-29', '2026-10-24']);
  assert.equal(view.days.length, 7);
  assert.deepEqual(view.tasks.map(task => task.id), ['tomorrow-first', 'tomorrow-done']);
  assert.equal(view.tasks[0], browsingData.tasks[1], 'checkbox receives real task id, never a date index');
  assert.deepEqual(view.weekSummary, {total: 2, completed: 1, totalMinutes: 150, completedMinutes: 60, progress: .5});
  assert.deepEqual(view.days[1], {date: '2026-10-24', day: 24, weekday: '六', total: 2, completed: 1, totalMinutes: 150, completedMinutes: 60, progress: .5});
  assert.equal(view.days[0].total, 0);
});

test('next and previous groups expose October 30 while keeping exactly seven dates visible', () => {
  let state = updateView({type: 'PLANNER/VIEW', view: 'week'}, {});
  state = updateView({type: 'PLANNER/WEEK', offset: 1}, state);
  let view = viewModel(browsingData, state);
  assert.deepEqual([view.start, view.end, view.date], ['2026-10-30', '2026-11-05', '2026-10-30']);
  assert.equal(view.weekSummary.totalMinutes, 50);
  assert.equal(view.tasks[0].id, 'last-day');
  state = updateView({type: 'PLANNER/WEEK', offset: -1}, state);
  view = viewModel(browsingData, state);
  assert.equal(view.date, '2026-10-23');
  assert.equal(view.days.length, 7);
});

test('Today clears a browsed future date and always follows server today', () => {
  const state = updateView({type: 'PLANNER/VIEW', view: 'today'}, {view: 'week', weekOffset: 1, selectedDate: '2026-10-30', busy: true});
  assert.deepEqual(state, {view: 'today', weekOffset: 0, selectedDate: null, busy: true});
  assert.equal(viewModel(browsingData, state).date, '2026-10-23');
  assert.equal(viewModel({...browsingData, today: '2026-10-24'}, state).date, '2026-10-24');
});

test('periodic snapshots preserve selection and show new totals; midnight keeps selection in range', () => {
  const state = {view: 'week', weekOffset: 0, selectedDate: '2026-10-24'};
  const refreshed = {...browsingData, revision: 10, tasks: browsingData.tasks.map(task => task.id === 'tomorrow-first' ? {...task, status: 'done'} : task)};
  const view = viewModel(refreshed, state);
  assert.equal(view.date, '2026-10-24');
  assert.equal(view.weekSummary.completedMinutes, 150);
  assert.equal(viewModel({...refreshed, today: '2026-10-24'}, state).date, '2026-10-24');
  assert.equal(viewModel({...refreshed, today: '2026-10-25'}, state).date, '2026-10-25');
});

test('empty/offline state and out-of-range date selection remain bounded with no reads or writes', () => {
  const state = {view: 'week', selectedDate: '2030-01-01'};
  const view = viewModel(null, state, '2026-10-23');
  assert.equal(view.date, '2026-10-23');
  assert.equal(view.days.length, 7);
  assert.deepEqual(view.tasks, []);
  assert.equal(view.weekSummary.total, 0);
  assert.equal(updateView({type: 'PLANNER/UNKNOWN'}, state), state);
  assert.equal(updateView({type: 'PLANNER/WEEK', offset: 500}, state), state);
});


test('Codex quota windows show remaining percentages and Beijing reset times without guessing missing values', () => {
  const usage = codexUsageView({available: true, stale: false, windows: [
    {label: 'codex', windowDurationMins: 300, remainingPercent: 58.4, resetsAt: Date.parse('2026-11-02T12:05:00Z') / 1000},
    {label: 'codex', windowDurationMins: 10080, remainingPercent: null, resetsAt: null},
  ]});
  assert.equal(usage.available, true);
  assert.equal(usage.stale, false);
  assert.equal(usage.windows[0].label, '5 小时');
  assert.equal(usage.windows[1].label, '7 天');
  assert.equal(usage.windows[0].remaining, '58%');
  assert.match(usage.windows[0].reset, /11\/2.*20:05/);
  assert.equal(usage.windows[1].remaining, '未知');
  assert.equal(usage.windows[1].reset, '重置时间未知');
  assert.equal(formatCodexReset(NaN), '重置时间未知');
  assert.equal(codexUsageView({available: false, stale: true, windows: []}).available, false);
  assert.equal(codexUsageView(null).available, false);
  assert.equal(codexUsageView({available: true, windows: [null]}).available, false);
  assert.equal(codexUsageView({available: true, stale: true, windows: [{label: '周', remainingPercent: 0, resetsAt: 1}]}).stale, true);
});

test('Codex reset countdown handles days, hours, minutes and elapsed or missing timestamps', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  const at = (milliseconds) => (now + milliseconds) / 1000;
  assert.equal(formatCodexCountdown(at((2 * 1440 + 3 * 60 + 4) * 60000), now), '距重置还剩 2 天 3 小时 4 分钟');
  assert.equal(formatCodexCountdown(at(24 * 60 * 60000), now), '距重置还剩 1 天');
  assert.equal(formatCodexCountdown(at(90 * 60000), now), '距重置还剩 1 小时 30 分钟');
  assert.equal(formatCodexCountdown(at(45 * 1000), now), '距重置不足 1 分钟');
  assert.equal(formatCodexCountdown(at(0), now), '已到预计重置时间，等待更新');
  assert.equal(formatCodexCountdown(at(-60000), now), '已到预计重置时间，等待更新');
  assert.equal(formatCodexCountdown(null, now), '重置倒计时未知');
  assert.equal(formatCodexCountdown(Infinity, now), '重置倒计时未知');
  assert.equal(codexUsageView({available: true, windows: [{resetsAt: at(60000)}]}, now).windows[0].countdown, '距重置还剩 1 分钟');
});

test('Codex quota lookup is independent of task reads and validates service response', async () => {
  let command = '';
  const client = createClient(async value => {command = value; return JSON.stringify({available:true, stale:false, updatedAt:null, windows:[]});}, 43117);
  assert.equal((await client.readCodexUsage()).available, true);
  assert.match(command, /127\.0\.0\.1:43117\/api\/codex-usage/);
  await assert.rejects(() => createClient(async () => '{}', 43117).readCodexUsage(), /额度数据格式不正确/);
});


test('Codex quota labels distinguish window length and other buckets with missing duration', () => {
  assert.equal(formatCodexWindowLabel('codex', 10080), '7 天');
  assert.equal(formatCodexWindowLabel('codex', 300), '5 小时');
  assert.equal(formatCodexWindowLabel('other-model', 60), 'other-model · 1 小时');
  assert.equal(formatCodexWindowLabel('other-model', null), 'other-model · 周期未知');
  assert.equal(formatCodexWindowLabel('codex', null), '周期未知');
  assert.equal(formatCodexWindowLabel(null, 45), '45 分钟');
  assert.equal(formatCodexWindowLabel('', NaN), '周期未知');
});


test('manual quota refresh uses POST with bounded timeout and recognises response status', async () => {
  let command = '';
  const client = createClient(async value => {command = value; return JSON.stringify({available: true, stale: false, updatedAt: '2026-11-03T01:00:00Z', windows: [], refreshStatus: 'updated'});}, 43117);
  const quota = await client.refreshCodexUsage();
  assert.equal(quota.refreshStatus, 'updated');
  assert.match(command, /--max-time 25/);
  assert.match(command, /--request POST/);
  assert.match(command, /X-Daily-Planner: 1/);
  assert.match(command, /--data-binary '\{\}'/);
  assert.match(command, /\/api\/codex-usage\/refresh/);
  await assert.rejects(() => createClient(async () => JSON.stringify({available:true, stale:false, windows:[], refreshStatus:'unknown'}), 43117).refreshCodexUsage(), /格式/);
});

test('manual quota refresh protects latest results and distinguishes failure, throttling and stale data', () => {
  const fresh = {available: true, stale: false, updatedAt:'2026-11-03T01:00:00Z', windows:[{remainingPercent: 45}]};
  let state = {quota: fresh, quotaEpoch: 0, quotaMessage: '', quotaRefreshing: false};
  state = updateQuotaState({type:'QUOTA/BEGIN', epoch:1}, state);
  assert.equal(state.quotaRefreshing, true);
  assert.equal(state.quotaMessage, '额度更新中…');
  assert.equal(updateQuotaState({type:'QUOTA/READ', quota:{...fresh, windows:[]}, epoch:0}, state), state);
  state = updateQuotaState({type:'QUOTA/FINISH', epoch:2, quota:{...fresh, refreshStatus:'failed', stale:true}}, state);
  assert.equal(state.quotaMessage, '额度更新失败');
  assert.equal(state.quota.stale, true);
  assert.equal(state.quotaRefreshing, false);
  assert.equal(updateQuotaState({type:'QUOTA/READ', quota:fresh, epoch:1}, state), state);
  state = updateQuotaState({type:'QUOTA/BEGIN', epoch:3}, state);
  state = updateQuotaState({type:'QUOTA/FINISH', epoch:4, quota:{...fresh, refreshStatus:'throttled', retryAfterSeconds:8}}, state);
  assert.match(state.quotaMessage, /8 秒后/);
  assert.equal(state.quota.stale, false);
  state = updateQuotaState({type:'QUOTA/BEGIN', epoch:5}, state);
  state = updateQuotaState({type:'QUOTA/FINISH', epoch:6, quota:{...fresh, refreshStatus:'updated'}}, state);
  assert.equal(state.quotaMessage, '额度已更新');
  assert.equal(state.quota.stale, false);
  state = updateQuotaState({type:'QUOTA/READ', epoch:6, quota:{...fresh, stale:true}}, state);
  assert.equal(state.quotaMessage, '');
  state = updateQuotaState({type:'QUOTA/BEGIN', epoch:7}, state);
  state = updateQuotaState({type:'QUOTA/FINISH', epoch:8, quota:null}, state);
  assert.equal(state.quotaMessage, '额度更新失败');
  assert.equal(state.quota.stale, true);
  state = updateQuotaState({type:'QUOTA/READ', epoch:8, quota:{...fresh, updatedAt:'2026-11-03T02:00:00Z'}}, state);
  assert.equal(state.quotaMessage, '');
  assert.equal(state.quota.stale, false);
});

test('quota update timestamp is distinct and displayed in Beijing time', () => {
  assert.match(formatCodexUpdatedAt('2026-11-03T01:05:00Z'), /11\/3.*09:05.*北京时间/);
  assert.equal(formatCodexUpdatedAt(null), '额度更新时间未知');
  assert.equal(formatCodexUpdatedAt('invalid'), '额度更新时间未知');
});
