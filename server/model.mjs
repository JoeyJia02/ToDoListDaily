import { randomUUID } from 'node:crypto';

export class PlannerError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const fail = (message, code = 'VALIDATION', status = 400) => { throw new PlannerError(code, message, status); };
export function object(value, label = '参数') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`);
  return value;
}
export function onlyKeys(value, keys) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`不支持的字段：${key}`);
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('日期必须为 YYYY-MM-DD');
  const parsed = new Date(`${value}T12:00:00Z`);
  if (value < '1900-01-01' || value > '9999-12-31' || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('日期无效');
  return value;
}
export function validId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) fail('任务 ID 必须为 UUID');
  return id.toLowerCase();
}
function str(value, field, max, nonempty = false) {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) || value.includes('\0')) fail(`${field}无效（最多 ${max} 字符）`);
  return value;
}
function integer(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${field}必须为 ${min}–${max} 的整数`);
  return value;
}
function choice(value, field, values) { if (!values.includes(value)) fail(`${field}无效`); return value; }
export function validTimestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${field}必须是 UTC ISO 时间`);
  return value;
}
export const editable = ['title', 'description', 'date', 'estimatedMinutes', 'actualMinutes', 'category', 'priority', 'status'];
export function validateFields(task) {
  str(task.title, '标题', 200, true);
  str(task.description, '说明', 5000);
  validDate(task.date);
  integer(task.estimatedMinutes, '预计分钟数', 1, 1440);
  if (task.actualMinutes !== null) integer(task.actualMinutes, '实际分钟数', 0, 10080);
  str(task.category, '类别', 60);
  choice(task.priority, '优先级', ['low', 'medium', 'high']);
  choice(task.status, '状态', ['todo', 'in_progress', 'done', 'cancelled']);
  integer(task.order, '排序', 0, 1000000);
  return task;
}
export function newTask(input, { now, order = 0, importing = false } = {}) {
  object(input, '任务');
  onlyKeys(input, importing ? [...editable, 'id', 'order', 'createdAt', 'updatedAt'] : editable);
  const task = {
    id: importing && input.id !== undefined ? validId(input.id) : randomUUID(),
    title: input.title, description: input.description ?? '', date: input.date,
    estimatedMinutes: input.estimatedMinutes, actualMinutes: input.actualMinutes ?? null,
    category: input.category ?? '项目', priority: input.priority ?? 'medium', status: input.status ?? 'todo',
    order: importing && input.order !== undefined ? input.order : order,
    createdAt: now, updatedAt: now,
  };
  if (importing) {
    for (const field of ['createdAt', 'updatedAt']) if (input[field] !== undefined) {
      task[field] = validTimestamp(input[field], field);
    }
    // Updated timestamps reflect the import operation while original creation time is preserved.
    task.updatedAt = now;
  }
  return validateFields(task);
}
export function sortTasks(tasks) { return tasks.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.id.localeCompare(b.id)); }
export function normalizeOrder(tasks) {
  const counts = new Map();
  for (const task of sortTasks(tasks)) { const count = counts.get(task.date) ?? 0; task.order = count; counts.set(task.date, count + 1); }
  return tasks;
}
export function summarize(tasks) {
  const result = {};
  for (const task of tasks) {
    const day = result[task.date] ??= { total: 0, completed: 0, totalMinutes: 0, completedMinutes: 0, progress: 0 };
    if (task.status === 'cancelled') continue;
    day.total++; day.totalMinutes += task.estimatedMinutes;
    if (task.status === 'done') { day.completed++; day.completedMinutes += task.estimatedMinutes; }
    day.progress = day.total ? day.completed / day.total : 0;
  }
  return result;
}
export function localDate(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const pick = (key) => parts.find((part) => part.type === key).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}
