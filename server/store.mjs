import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PlannerError, fail, object, onlyKeys, validDate, validId, validTimestamp, editable, validateFields, newTask, sortTasks, normalizeOrder, summarize, localDate } from './model.mjs';

const clone = (value) => structuredClone(value);
const writes = ['createTask', 'updateTask', 'moveTask', 'deleteTask', 'reorderTasks'];
const MAX_TASKS = 10000;
export class PlannerStore {
  constructor({ dataDir, timezone = 'Asia/Shanghai', now = () => new Date() }) {
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { fail('DAILY_PLANNER_TIMEZONE 不是有效 IANA 时区'); }
    this.dataDir = dataDir; this.timezone = timezone; this.now = now; this.previews = new Map();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.backupDir = join(dataDir, 'backups');
    mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    try {
      this.db = new DatabaseSync(join(dataDir, 'planner.sqlite'));
      chmodSync(join(dataDir, 'planner.sqlite'), 0o600);
      this.db.exec('PRAGMA busy_timeout=3000;');
      const check = this.db.prepare('PRAGMA quick_check').get();
      if (Object.values(check)[0] !== 'ok') throw new Error('SQLite integrity check failed');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, revision INTEGER UNIQUE NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL, created_at TEXT NOT NULL);`);
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('revision', '0')").run();
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('timezone', ?)").run(timezone);
      const savedTimezone = this.db.prepare("SELECT value FROM metadata WHERE key='timezone'").get().value;
      if (savedTimezone !== timezone) throw new PlannerError('TIMEZONE_MISMATCH', `数据库时区为 ${savedTimezone}，请使用相同 DAILY_PLANNER_TIMEZONE 启动`, 500);
      chmodSync(join(dataDir, 'planner.sqlite'), 0o600);
      // Validate persisted application data as well as SQLite's physical integrity.
      for (const task of this.readTasks()) {
        object(task); onlyKeys(task, [...editable, 'id', 'order', 'createdAt', 'updatedAt']);
        validId(task.id); validateFields(task); validTimestamp(task.createdAt, 'createdAt'); validTimestamp(task.updatedAt, 'updatedAt');
      }
    } catch (error) {
      this.db?.close();
      if (error instanceof PlannerError && error.code === 'TIMEZONE_MISMATCH') throw error;
      throw new PlannerError('STORAGE_UNAVAILABLE', '数据库无法打开或校验失败，原文件已保留；请查看故障排查文档并从备份恢复', 500);
    }
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
  revision() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='revision'").get().value); }
  readTasks() { return sortTasks(this.db.prepare('SELECT id, document FROM tasks').all().map((row) => { const task = JSON.parse(row.document); if (task?.id !== row.id) fail('任务 ID 与数据库索引不一致'); return task; })); }
  state() {
    // A read transaction gives all fields the same view even if another local process writes.
    this.db.exec('BEGIN');
    try { const tasks = this.readTasks(); const revision = this.revision(); this.db.exec('COMMIT'); return { revision, timezone: this.timezone, today: localDate(this.now(), this.timezone), tasks, summary: summarize(tasks) }; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  find(tasks, id) { id = validId(id); const task = tasks.find((item) => item.id === id); if (!task) fail('任务不存在', 'NOT_FOUND', 404); return task; }
  mutate(tasks, operation, args, timestamp) {
    object(args);
    if (operation === 'createTask') {
      onlyKeys(args, ['task']);
      if (tasks.length >= MAX_TASKS) fail('任务数量超出上限');
      const task = newTask(args.task, { now: timestamp, order: tasks.filter((item) => item.date === args.task?.date).length });
      tasks.push(task); return { task };
    }
    if (operation === 'updateTask') {
      onlyKeys(args, ['id', 'patch']); object(args.patch, 'patch'); onlyKeys(args.patch, editable);
      if (!Object.keys(args.patch).length) fail('patch 不能为空');
      const task = this.find(tasks, args.id); const beforeDate = task.date;
      Object.assign(task, args.patch); validateFields(task);
      if (task.date !== beforeDate) task.order = tasks.filter((item) => item.id !== task.id && item.date === task.date).length;
      task.updatedAt = timestamp; normalizeOrder(tasks); return { task };
    }
    if (operation === 'moveTask') { onlyKeys(args, ['id', 'date']); validDate(args.date); return this.mutate(tasks, 'updateTask', { id: args.id, patch: { date: args.date } }, timestamp); }
    if (operation === 'deleteTask') { onlyKeys(args, ['id']); const task = this.find(tasks, args.id); tasks.splice(tasks.indexOf(task), 1); normalizeOrder(tasks); return {}; }
    if (operation === 'reorderTasks') {
      onlyKeys(args, ['date', 'ids']); validDate(args.date);
      if (!Array.isArray(args.ids) || args.ids.length > MAX_TASKS) fail('ids 必须为 UUID 数组');
      const ids = args.ids.map(validId); const day = tasks.filter((task) => task.date === args.date);
      if (new Set(ids).size !== ids.length || ids.length !== day.length || day.some((task) => !ids.includes(task.id))) fail('排序必须包含当天全部且不重复的任务 ID');
      day.forEach((task) => { task.order = ids.indexOf(task.id); task.updatedAt = timestamp; }); sortTasks(tasks); return {};
    }
    fail('批量操作仅支持任务新增、修改、移动、删除和排序');
  }
  importPlan(tasks, spec, timestamp) {
    object(spec, 'import'); onlyKeys(spec, ['plan', 'mode']); const mode = spec.mode ?? 'append';
    if (!['append', 'merge', 'replace'].includes(mode)) fail('导入模式无效');
    const plan = object(spec.plan, 'plan'); onlyKeys(plan, ['schemaVersion', 'timezone', 'tasks', 'revision']);
    if (plan.schemaVersion !== 1) fail('schemaVersion 必须为 1');
    if (plan.revision !== undefined && (!Number.isSafeInteger(plan.revision) || plan.revision < 0)) fail('备份 revision 无效');
    if (plan.timezone !== undefined && plan.timezone !== this.timezone) fail(`计划时区必须为 ${this.timezone}，请先确认日期并转换计划时区`);
    if (!Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > MAX_TASKS) fail('导入任务必须为非空数组，最多 10000 条');
    // Validate the entire plan before touching even the simulated task list.
    const imported = sortTasks(plan.tasks.map((task, order) => newTask(task, { now: timestamp, order, importing: true })));
    if (new Set(imported.map((task) => task.id)).size !== imported.length) fail('导入计划存在重复 ID');
    if (mode === 'replace') {
      const dates = new Set(imported.map((task) => task.date));
      for (let index = tasks.length - 1; index >= 0; index--) if (dates.has(tasks[index].date)) tasks.splice(index, 1);
    }
    for (const task of imported) {
      const existing = tasks.findIndex((item) => item.id === task.id);
      if (existing !== -1) {
        if (mode !== 'merge') fail('导入 ID 与已有任务冲突；追加不会覆盖，请改用合并模式或新 ID');
        const createdAt = tasks[existing].createdAt; tasks[existing] = { ...task, createdAt };
      } else {
        task.order = tasks.filter((item) => item.date === task.date).length; tasks.push(task);
      }
    }
    if (tasks.length > MAX_TASKS) fail('导入后任务数量超出上限');
    normalizeOrder(tasks);
  }
  preview(args) {
    object(args); onlyKeys(args, ['operations', 'import']);
    const now = this.now();
    for (const [id, preview] of this.previews) if (preview.expires <= now.getTime()) this.previews.delete(id);
    if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value);
    const state = this.state(); const tasks = clone(state.tasks); const timestamp = now.toISOString();
    const operations = args.operations ?? [];
    if (!Array.isArray(operations) || operations.length > 1000) fail('operations 必须为数组，最多 1000 项');
    if (!operations.length && !args.import) fail('预览不能为空');
    if (args.import) this.importPlan(tasks, args.import, timestamp);
    for (const operation of operations) { object(operation); onlyKeys(operation, ['operation', 'args']); this.mutate(tasks, operation.operation, operation.args, timestamp); }
    const old = new Map(state.tasks.map((task) => [task.id, task])); const next = new Map(tasks.map((task) => [task.id, task]));
    const changes = { created: tasks.filter((task) => !old.has(task.id)).length, updated: tasks.filter((task) => old.has(task.id) && JSON.stringify(old.get(task.id)) !== JSON.stringify(task)).length, deleted: state.tasks.filter((task) => !next.has(task.id)).length };
    const details = [...tasks.filter((task) => !old.has(task.id)).map((task) => ({ type: 'create', id: task.id, after: task })),
      ...tasks.filter((task) => old.has(task.id) && JSON.stringify(old.get(task.id)) !== JSON.stringify(task)).map((task) => ({ type: 'update', id: task.id, before: old.get(task.id), after: task })),
      ...state.tasks.filter((task) => !next.has(task.id)).map((task) => ({ type: 'delete', id: task.id, before: task }))];
    const previewId = randomUUID();
    this.previews.set(previewId, { tasks, baseRevision: state.revision, expires: now.getTime() + 15 * 60000 });
    return { revision: state.revision, previewId, baseRevision: state.revision, taskCount: tasks.length, summary: summarize(tasks), changes, details,
      ...(args.import ? { importedTaskCount: args.import.plan.tasks.length, importSummary: summarize(args.import.plan.tasks) } : {}) };
  }
  backup(tasks, revision) {
    const file = join(this.backupDir, `${String(revision).padStart(12, '0')}-${randomUUID()}.json`);
    const temporary = `${file}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, timezone: this.timezone, revision, tasks }), { mode: 0o600, flag: 'wx' });
      const descriptor = openSync(temporary, 'r'); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, file);
      const directory = openSync(this.backupDir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) { try { unlinkSync(temporary); } catch {} throw new PlannerError('BACKUP_FAILED', '备份写入失败，本次修改未保存', 500); }
    // Old backups are expendable; failure to prune must never invalidate a completed backup.
    try { const files = readdirSync(this.backupDir).filter((name) => /^\d{12}-.*\.json$/.test(name)).sort(); for (const name of files.slice(0, -30)) unlinkSync(join(this.backupDir, name)); } catch {}
  }
  operation(operation, args = {}, expectedRevision) {
    if (operation === 'previewChanges') return this.preview(args);
    if (operation === 'listTasks') {
      object(args); onlyKeys(args, ['date', 'from', 'to']);
      for (const key of ['date', 'from', 'to']) if (args[key] !== undefined) validDate(args[key]);
      if (args.from && args.to && args.from > args.to) fail('起始日期不能晚于结束日期');
      const state = this.state(); return { revision: state.revision, tasks: state.tasks.filter((task) => (!args.date || task.date === args.date) && (!args.from || task.date >= args.from) && (!args.to || task.date <= args.to)) };
    }
    if (operation === 'getTask') { object(args); onlyKeys(args, ['id']); const state = this.state(); return { revision: state.revision, task: this.find(state.tasks, args.id) }; }
    if (![...writes, 'applyChanges', 'undoChanges'].includes(operation)) fail('未知操作');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('写入必须提供 expectedRevision');
    object(args);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const revision = this.revision();
      if (expectedRevision !== revision) fail('计划已被其他编辑更新，请刷新后重新提交；未保存的表单可保留', 'REVISION_CONFLICT', 409);
      const before = this.readTasks(); let tasks = clone(before); let result = {}; let previewId;
      const timestamp = this.now().toISOString();
      if (operation === 'applyChanges') {
        onlyKeys(args, ['previewId']); previewId = validId(args.previewId); const preview = this.previews.get(previewId);
        if (!preview || preview.expires <= this.now().getTime()) fail('预览已过期或服务已重启，请重新预览', 'PREVIEW_EXPIRED', 409);
        if (preview.baseRevision !== revision) fail('预览之后计划已改变，请重新预览', 'REVISION_CONFLICT', 409);
        tasks = clone(preview.tasks);
      } else if (operation === 'undoChanges') {
        onlyKeys(args, ['changeId']); validId(args.changeId);
        const history = this.db.prepare('SELECT * FROM history WHERE id=?').get(args.changeId);
        if (!history) fail('撤销记录不存在或已超过保留数量', 'NOT_FOUND', 404);
        if (history.revision !== revision) fail('该修改后已有其他操作，不能覆盖后续修改；请手动调整', 'UNDO_CONFLICT', 409);
        tasks = JSON.parse(history.before_state);
      } else result = this.mutate(tasks, operation, args, timestamp);
      const changeId = randomUUID(); const nextRevision = revision + 1;
      this.backup(before, revision);
      this.db.exec('DELETE FROM tasks');
      const insert = this.db.prepare('INSERT INTO tasks(id,document) VALUES (?,?)');
      for (const task of sortTasks(tasks)) insert.run(task.id, JSON.stringify(task));
      this.db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(nextRevision));
      this.db.prepare('INSERT INTO history VALUES (?,?,?,?,?)').run(changeId, nextRevision, JSON.stringify(before), JSON.stringify(tasks), timestamp);
      this.db.prepare('DELETE FROM history WHERE revision <= ?').run(nextRevision - 100);
      this.db.exec('COMMIT');
      if (previewId) this.previews.delete(previewId);
      return { revision: nextRevision, ...result, changeId };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
