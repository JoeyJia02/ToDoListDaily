// Browser-only types mirror shared/model.ts. The editor has no runtime dependencies.
type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
type TaskPriority = 'low' | 'medium' | 'high';
interface Task {
  id: string; title: string; description: string; date: string;
  estimatedMinutes: number; actualMinutes: number | null; category: string;
  priority: TaskPriority; status: TaskStatus; order: number;
  createdAt: string; updatedAt: string;
}
interface Summary { total: number; completed: number; totalMinutes: number; completedMinutes: number; progress: number }
interface PlannerState { revision: number; timezone: string; today: string; tasks: Task[]; summary: Record<string, Summary> }
interface OperationResult { revision: number; changeId?: string; task?: Task }
interface Preview extends OperationResult {
  previewId: string; baseRevision: number; taskCount: number;
  importedTaskCount?: number; importSummary?: Record<string, Summary>;
  summary: Record<string, Summary>; changes: { created: number; updated: number; deleted: number };
}
type EditableTask = Pick<Task, 'title' | 'description' | 'date' | 'estimatedMinutes' | 'actualMinutes' | 'category' | 'priority' | 'status'>;
type ViewMode = 'day' | 'week';
type TaskDialogMode = 'view' | 'edit' | 'create';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};
const form = $<HTMLFormElement>('task-form');
const taskDialog = $<HTMLDialogElement>('task-dialog');
const taskDescription = $<HTMLTextAreaElement>('task-description');
const taskView = $('task-view');
const taskEditButton = $<HTMLButtonElement>('task-edit-button');
const importDialog = $<HTMLDialogElement>('import-dialog');
const statusNames: Record<TaskStatus, string> = { todo: '待做', in_progress: '进行中', done: '已完成', cancelled: '已取消' };
const priorityNames: Record<TaskPriority, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };
const escapeHTML = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
let state: PlannerState | null = null;
let selectedDate = '';
let view: ViewMode = 'day';
let editingId: string | null = null;
let formRevision = 0;
let formSnapshot: EditableTask | null = null;
let lastChange: { id: string; revision: number } | null = null;
let preview: Preview | null = null;
let importGeneration = 0;
let mutationPending = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let connected = false;
let loadedHashTask: string | null = null;
let lastInputWasKeyboard = false;
let taskDialogMode: TaskDialogMode = 'create';
let detailTask: Task | null = null;
let detailRevision = 0;

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

async function operation<T extends OperationResult = OperationResult>(name: string, args: unknown, revision?: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/operations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Daily-Planner': '1' },
      body: JSON.stringify({ operation: name, args, ...(revision !== undefined ? { expectedRevision: revision } : {}) }),
      signal: AbortSignal.timeout(15000)
    });
  } catch { throw new ApiError('无法连接本地服务。请启动 ToDoList 服务后重试，当前输入已保留。', 0, 'NETWORK'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error?.message || `请求未完成（${response.status}）`, response.status, body.error?.code || 'REQUEST');
  return body as T;
}

async function loadState(silent = false): Promise<PlannerState> {
  try {
    const response = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`读取失败（${response.status}）`);
    const next = await response.json() as PlannerState;
    if (!state || next.revision >= state.revision) {
      const oldToday = state?.today;
      if (!selectedDate || (oldToday && selectedDate === oldToday && next.today !== oldToday)) selectedDate = next.today;
      state = next;
      $('global-error').hidden = true;
      connected = true;
      render();
      if (taskDialog.open && taskDialogMode === 'view' && detailTask && next.revision >= detailRevision) {
        detailTask = next.tasks.find(task => task.id === detailTask?.id) ?? detailTask;
        detailRevision = next.revision;
        renderTaskDetails();
      }
      if (preview && preview.baseRevision !== next.revision) invalidatePreview('计划已经更新，请重新预览后确认导入。');
      resolveHash();
    }
    return state!;
  } catch (error) {
    connected = false;
    renderConnection();
    if (!silent || !state) {
      $('global-error').textContent = '本地任务服务暂时不可用。请检查服务是否启动，再点击右上角刷新。已有数据仍保存在本机；当前编辑内容会保留。';
      $('global-error').hidden = false;
      if (!state) $('task-sections').innerHTML = '<div class="empty-state"><h3>等待本地服务</h3><p>启动 ToDoList 服务后，这里会显示你的计划。</p><button class="secondary-button" data-action="refresh">重新连接</button></div>';
    }
    throw error;
  }
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value < '1900-01-01' || value > '9999-12-31') return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
function dateLabel(value: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
}
function duration(minutes: number): string {
  if (minutes === 0) return '0 分钟';
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}` : `${minutes} 分钟`;
}
function summary(tasks: Task[]): Summary {
  const active = tasks.filter(task => task.status !== 'cancelled');
  const done = active.filter(task => task.status === 'done');
  return { total: active.length, completed: done.length, totalMinutes: active.reduce((n, t) => n + t.estimatedMinutes, 0), completedMinutes: done.reduce((n, t) => n + t.estimatedMinutes, 0), progress: active.length ? done.length / active.length : 0 };
}
function tasksOn(date: string): Task[] { return state!.tasks.filter(t => t.date === date).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)); }
function visibleDates(): string[] { return Array.from({ length: view === 'week' ? 7 : 1 }, (_, i) => addDays(selectedDate, i)); }

function renderConnection(): void {
  $('connection-dot').className = `status-dot ${connected ? 'online' : 'offline'}`;
  $('connection-label').textContent = connected ? '本地服务已连接' : '正在重新连接';
  if (state) {
    $('timezone-label').textContent = `仅保存在本机 · ${state.timezone}`;
    $('sync-label').textContent = connected ? `已同步 · 版本 ${state.revision} · ${state.timezone}` : '连接已断开 · 等待服务恢复';
  }
}

function render(): void {
  if (!state) return;
  const dates = visibleDates();
  const currentTasks = state.tasks.filter(t => dates.includes(t.date));
  const totals = summary(currentTasks);
  const isToday = selectedDate === state.today;
  const isWeek = view === 'week';
  $('nav-today').classList.toggle('active', !isWeek);
  $('nav-week').classList.toggle('active', isWeek);
  $('nav-today').setAttribute('aria-current', !isWeek ? 'page' : 'false');
  $('nav-week').setAttribute('aria-current', isWeek ? 'page' : 'false');
  $('today-count').textContent = String(summary(tasksOn(state.today)).total);
  $('view-label').textContent = isWeek ? '七日计划' : isToday ? '今日任务' : '每日任务';
  $('date-caption').textContent = isWeek ? `${dateLabel(dates[0], { month: 'long', day: 'numeric' })} — ${dateLabel(dates[6], { month: 'long', day: 'numeric' })} · ${selectedDate.slice(0, 4)}` : dateLabel(selectedDate, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('page-title').innerHTML = `${isWeek ? '给这一周，留个方向' : isToday ? '今天的计划' : dateLabel(selectedDate, { month: 'long', day: 'numeric' }) + '的计划'}<span class="heading-dot">.</span>`;
  $('page-subtitle').textContent = isWeek ? '看见接下来的节奏，也为变化留出空间。' : '把时间留给重要的事，一件一件完成。';
  $('stat-planned').innerHTML = durationHTML(totals.totalMinutes);
  $('stat-completed').innerHTML = durationHTML(totals.completedMinutes);
  $('stat-task-count').textContent = totals.total ? `${totals.total} 项任务，按自己的节奏来` : '还没有安排任务';
  const percent = Math.round(totals.progress * 100);
  $('stat-progress').innerHTML = `${percent}<small>%</small>`;
  $('stat-ratio').textContent = `${totals.completed} / ${totals.total}`;
  const progress = $<HTMLProgressElement>('progress-fill');
  progress.value = percent;
  progress.textContent = `${percent}%`;
  $('section-title').textContent = isWeek ? '七天的安排' : isToday ? '今天要做的事' : '这一天的安排';
  $<HTMLInputElement>('view-date').value = selectedDate;
  $('previous-button').setAttribute('aria-label', isWeek ? '前七天' : '前一天');
  $('next-button').setAttribute('aria-label', isWeek ? '后七天' : '后一天');
  $('week-strip').hidden = !isWeek;
  if (isWeek) $('week-strip').innerHTML = dates.map(date => {
    const day = summary(tasksOn(date));
    return `<button class="week-day${date === state!.today ? ' is-today' : ''}" data-action="open-day" data-date="${date}" aria-label="查看${date}任务"><small>${dateLabel(date, { weekday: 'short' })}</small><strong>${Number(date.slice(8))}</strong><span>${day.total ? duration(day.totalMinutes) : '留一点空白'}</span></button>`;
  }).join('');
  $('task-sections').innerHTML = isWeek ? dates.map(date => renderDay(date)).join('') : renderTaskList(selectedDate);
  renderUndo();
  renderConnection();
}

function durationHTML(minutes: number): string {
  return minutes < 60 ? `${minutes}<small>分钟</small>` : `${Math.floor(minutes / 60)}<small>小时</small>${minutes % 60 ? ` ${minutes % 60}<small>分钟</small>` : ''}`;
}
function renderDay(date: string): string {
  const day = summary(tasksOn(date));
  return `<section class="day-group" aria-label="${date}"><div class="day-heading"><h3>${dateLabel(date, { month: 'long', day: 'numeric', weekday: 'short' })}${date === state!.today ? '<span>今天</span>' : ''}</h3><span>${day.total} 项任务 · ${duration(day.totalMinutes)}</span></div>${renderTaskList(date, true)}</section>`;
}
function renderTaskList(date: string, compact = false): string {
  const tasks = tasksOn(date);
  if (!tasks.length) return compact ? `<div class="empty-state compact"><p>这一天还留着空白。</p><button class="text-button" data-action="create" data-date="${date}">+ 安排一件事</button></div>` : `<div class="empty-state"><div class="empty-illustration" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M7 33h34M13 28a11 11 0 0 1 22 0M24 5v5M8 13l4 4m28-4-4 4M4 26h5m30 0h5M13 40h22"/></svg></div><h3>今天，从一件小事开始</h3><p>把想做的事写下来，让每一天更有方向。<br>也可以导入你已经准备好的 JSON 计划。</p><button class="secondary-button" data-action="create" data-date="${date}">+ 安排第一件事</button><button class="text-button" data-action="import">导入已有计划 ↗</button></div>`;
  return `<div class="task-list">${tasks.map((task, i) => renderTask(task, i, tasks.length)).join('')}</div>`;
}
function renderTask(task: Task, index: number, length: number): string {
  const id = escapeHTML(task.id);
  const categoryColors: Record<string, string> = { '求职': 'c1', 'Coding': 'c2', '408': 'c3', '复盘': 'c4' };
  const done = task.status === 'done';
  return `<article class="task-card${done ? ' is-done' : ''}${task.status === 'cancelled' ? ' is-cancelled' : ''}" data-action="edit" data-id="${id}">
    <button class="task-check" data-action="toggle" data-id="${id}" role="checkbox" aria-checked="${done}" aria-label="${done ? '取消完成' : '完成任务'}：${escapeHTML(task.title)}"${mutationPending ? ' disabled' : ''}>${done ? '✓' : ''}</button>
    <div class="task-body"><button class="task-title-button" data-action="edit" data-id="${id}" title="查看或编辑任务"><span class="task-title">${escapeHTML(task.title)}</span></button>${task.description ? `<p class="task-description">${escapeHTML(task.description)}</p>` : ''}<div class="task-meta"><span class="category-badge ${categoryColors[task.category] || ''}">${escapeHTML(task.category || '未分类')}</span><span class="priority-tag ${task.priority}"><span class="priority-dot"></span>${priorityNames[task.priority]}</span>${task.status !== 'todo' ? `<span class="status-tag ${task.status === 'in_progress' ? 'in-progress' : ''}">${statusNames[task.status]}</span>` : ''}${task.actualMinutes !== null ? `<span class="status-tag">实际 ${task.actualMinutes} 分钟</span>` : ''}</div></div>
    <div class="task-right"><div class="task-duration"><strong>${task.estimatedMinutes}</strong> 分钟</div><div class="task-actions"><button class="icon-button" data-action="up" data-id="${id}" aria-label="上移：${escapeHTML(task.title)}" title="上移"${index === 0 || mutationPending ? ' disabled' : ''}>↑</button><button class="icon-button" data-action="down" data-id="${id}" aria-label="下移：${escapeHTML(task.title)}" title="下移"${index === length - 1 || mutationPending ? ' disabled' : ''}>↓</button><button class="icon-button edit-button" data-action="edit-form" data-id="${id}" aria-label="编辑：${escapeHTML(task.title)}" title="编辑"><svg viewBox="0 0 24 24"><path d="m16 4 4 4M4 20l4-1 12-12-3-3L5 16Z"/></svg></button><button class="icon-button delete-button" data-action="delete" data-id="${id}" aria-label="删除：${escapeHTML(task.title)}" title="删除，可撤销"${mutationPending ? ' disabled' : ''}><svg viewBox="0 0 24 24"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></svg></button></div></div>
  </article>`;
}

function showToast(message: string, undo = false): void {
  clearTimeout(toastTimer);
  $('toast-message').textContent = message;
  $('toast-undo').hidden = !undo;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, undo ? 20000 : 6500);
  renderUndo();
}
function renderUndo(): void {
  const allowed = !!lastChange && lastChange.revision === state?.revision && !mutationPending;
  $<HTMLButtonElement>('undo-button').disabled = !allowed;
  $<HTMLButtonElement>('toast-undo').disabled = !allowed;
  $('undo-button').title = allowed ? '撤销最近一次更改' : '有后续更改时，无法撤销旧版本';
}
function setMutationPending(value: boolean): void {
  mutationPending = value;
  taskEditButton.disabled = value || !state?.tasks.some(task => task.id === detailTask?.id) || state.revision < detailRevision;
  $<HTMLButtonElement>('save-task-button').disabled = value;
  $<HTMLButtonElement>('preview-import-button').disabled = value;
  $<HTMLButtonElement>('apply-import-button').disabled = value || !preview || preview.baseRevision !== state?.revision;
  render();
}
async function saveOperation(name: string, args: unknown, message: string, revision = state?.revision): Promise<OperationResult> {
  if (mutationPending) throw new ApiError('正在保存上一项更改，请稍候。', 0, 'BUSY');
  if (revision === undefined) throw new ApiError('请等待本地服务连接后再保存。', 0, 'NOT_READY');
  setMutationPending(true);
  try {
    const result = await operation(name, args, revision);
    if (result.changeId) lastChange = { id: result.changeId, revision: result.revision };
    try { await loadState(true); } catch { /* The write succeeded; reconnecting keeps its durable result. */ }
    showToast(message, !!result.changeId);
    return result;
  } finally { setMutationPending(false); }
}
async function handleMutationError(error: unknown, target = 'global'): Promise<void> {
  const conflict = error instanceof ApiError && error.status === 409;
  if (conflict) { try { await loadState(true); } catch { /* Keep user input even if reconnection fails. */ } }
  const detail = error instanceof Error ? error.message : '操作未完成，请重试。';
  if (target === 'task') {
    const message = conflict ? '计划已被其他页面或桌面卡片修改。你的输入已保留，尚未保存。\n请核对最新计划后再次保存；如任务已被删除，请关闭编辑后重新新建。' : detail;
    $('task-error').textContent = message;
    $('task-error').hidden = false;
    if (conflict && state) {
      formRevision = state.revision;
      $('save-task-button').textContent = '核对后再次保存';
      if (editingId && !state.tasks.some(t => t.id === editingId)) $<HTMLButtonElement>('save-task-button').disabled = true;
    }
  } else if (target === 'import') {
    $('import-error').textContent = conflict ? '预览后计划有了新更改。尚未导入，请重新预览再确认。' : detail;
    $('import-error').hidden = false;
    if (conflict) invalidatePreview();
  } else showToast(conflict ? '其他地方已修改计划，最新内容已加载。请核对后重试。' : detail);
}

function taskValues(task: Task): EditableTask {
  const { title, description, date, estimatedMinutes, actualMinutes, category, priority, status } = task;
  return { title, description, date, estimatedMinutes, actualMinutes, category, priority, status };
}
function resizeTaskDescription(): void {
  if (!taskDialog.open || form.hidden) return;
  const scrollTop = taskDialog.scrollTop;
  taskDescription.style.height = 'auto';
  const style = getComputedStyle(taskDescription);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  taskDescription.style.height = `${taskDescription.scrollHeight + border}px`;
  taskDialog.scrollTop = scrollTop;
}
function renderTaskDetails(): void {
  if (!detailTask) return;
  $('task-view-title').textContent = detailTask.title;
  $('task-view-description').textContent = detailTask.description || '暂无详细说明';
  $('task-view-date').textContent = dateLabel(detailTask.date, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('task-view-estimate').textContent = duration(detailTask.estimatedMinutes);
  $('task-view-category').textContent = detailTask.category || '未分类';
  $('task-view-priority').textContent = priorityNames[detailTask.priority];
  $('task-view-status').textContent = statusNames[detailTask.status];
  $('task-view-actual').textContent = detailTask.actualMinutes === null ? '尚未记录' : duration(detailTask.actualMinutes);
  const deleted = !state?.tasks.some(task => task.id === detailTask?.id);
  const awaitingRefresh = !state || state.revision < detailRevision;
  taskEditButton.disabled = mutationPending || deleted || awaitingRefresh;
  $('task-error').hidden = !deleted && !awaitingRefresh;
  if (deleted) $('task-error').textContent = '这项任务已被删除。请关闭详情查看最新计划。';
  else if (awaitingRefresh) $('task-error').textContent = '更改已保存。重新连接后可以继续编辑。';
}
function showTaskMode(mode: TaskDialogMode): void {
  taskDialogMode = mode;
  taskView.hidden = mode !== 'view';
  form.hidden = mode === 'view';
  $('task-dialog-title').textContent = mode === 'view' ? '任务详情' : mode === 'edit' ? '编辑任务' : '安排一件事';
  if (!taskDialog.open) taskDialog.showModal();
  taskDialog.scrollTop = 0;
  resizeTaskDescription();
  requestAnimationFrame(() => {
    if (taskDialog.open && taskDialogMode === mode) {
      $(mode === 'create' ? 'task-title' : 'task-dialog-title').focus({ preventScroll: true });
    }
  });
}
function showTaskDetails(task: Task, revision = state?.revision ?? 0): void {
  detailTask = task;
  detailRevision = revision;
  editingId = task.id;
  renderTaskDetails();
  showTaskMode('view');
}
function fillTaskForm(task?: Task, date = selectedDate): void {
  editingId = task?.id ?? null;
  formRevision = state!.revision;
  formSnapshot = task ? taskValues(task) : null;
  form.reset();
  const values = task ? taskValues(task) : { title: '', description: '', date, estimatedMinutes: 30, actualMinutes: null, category: '项目', priority: 'medium', status: 'todo' };
  for (const [key, value] of Object.entries(values)) {
    const element = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    element.value = value === null ? '' : String(value);
  }
  $('save-task-button').textContent = task ? '保存更改' : '创建任务';
  $<HTMLButtonElement>('save-task-button').disabled = mutationPending;
  $('task-error').hidden = true;
  $('task-meta').textContent = task ? `修改日期即可移动任务 · 版本 ${formRevision}` : '保存后会同步到桌面卡片';
  showTaskMode(task ? 'edit' : 'create');
}
function openTask(task?: Task, date = selectedDate): void {
  if (!state) { showToast('请先连接本地服务。'); return; }
  if (mutationPending) return;
  if (task) showTaskDetails(task);
  else { detailTask = null; fillTaskForm(undefined, date); }
}
function editTaskDetails(): void {
  if (!state || !detailTask || mutationPending) return;
  if (state.revision < detailRevision) return;
  const current = state.tasks.find(task => task.id === detailTask?.id);
  if (!current) { renderTaskDetails(); return; }
  detailTask = current;
  fillTaskForm(current);
}
function cancelTaskEdit(): void {
  if (mutationPending) return;
  if (taskDialogMode === 'edit' && detailTask) {
    showTaskDetails(state?.tasks.find(task => task.id === detailTask?.id) ?? detailTask);
  } else taskDialog.close();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (taskDialogMode === 'view' || !form.reportValidity() || mutationPending) return;
  const values = new FormData(form);
  const task: EditableTask = {
    title: String(values.get('title')).trim(), description: String(values.get('description')).trim(),
    date: String(values.get('date')), estimatedMinutes: Number(values.get('estimatedMinutes')),
    actualMinutes: values.get('actualMinutes') === '' ? null : Number(values.get('actualMinutes')),
    category: String(values.get('category')).trim(), priority: values.get('priority') as TaskPriority, status: values.get('status') as TaskStatus
  };
  if (!task.title) { $('task-error').textContent = '请填写任务名称。'; $('task-error').hidden = false; return; }
  $('task-error').hidden = true;
  // Sending only intentionally changed fields protects unrelated concurrent edits after review.
  const patch = formSnapshot ? Object.fromEntries(Object.entries(task).filter(([key, value]) => value !== formSnapshot![key as keyof EditableTask])) : task;
  try {
    if (editingId && Object.keys(patch).length === 0) { cancelTaskEdit(); return; }
    const savedId = editingId;
    const result = await saveOperation(savedId ? 'updateTask' : 'createTask', savedId ? { id: savedId, patch } : { task }, savedId ? '任务已更新，桌面卡片会同步。' : '新任务已安排。', formRevision);
    if (savedId) {
      const saved = state && state.revision >= result.revision ? state.tasks.find(item => item.id === savedId) : result.task;
      if (saved) showTaskDetails(saved, Math.max(state?.revision ?? 0, result.revision));
      else taskDialog.close();
    } else taskDialog.close();
    if (view === 'day' && task.date !== selectedDate) { selectedDate = task.date; render(); }
  } catch (error) { await handleMutationError(error, 'task'); }
});

async function changeTask(action: string, id: string): Promise<void> {
  if (!state || mutationPending) return;
  const task = state.tasks.find(t => t.id === id);
  if (!task) { showToast('该任务已不存在，请刷新计划。'); return; }
  if (action === 'edit') { openTask(task); return; }
  if (action === 'edit-form') { detailTask = task; fillTaskForm(task); return; }
  try {
    if (action === 'toggle') await saveOperation('updateTask', { id, patch: { status: task.status === 'done' ? 'todo' : 'done' } }, task.status === 'done' ? '已取消完成。' : '又完成了一件事。');
    else if (action === 'delete') await saveOperation('deleteTask', { id }, `已删除「${task.title}」。可撤销最近一次更改。`);
    else if (action === 'up' || action === 'down') {
      const ids = tasksOn(task.date).map(t => t.id);
      const index = ids.indexOf(id), target = index + (action === 'up' ? -1 : 1);
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      await saveOperation('reorderTasks', { date: task.date, ids }, '任务顺序已调整。');
    }
  } catch (error) { await handleMutationError(error); }
}

function openImport(): void {
  if (!state) { showToast('请先连接本地服务。'); return; }
  const append = document.querySelector<HTMLInputElement>('[name="import-mode"][value="append"]')!;
  append.checked = true;
  invalidatePreview();
  $('import-error').hidden = true;
  $('import-status').textContent = '当前计划不会自动被覆盖';
  importDialog.showModal();
}
function invalidatePreview(message?: string): void {
  preview = null;
  importGeneration++;
  $('import-preview').hidden = true;
  $<HTMLButtonElement>('apply-import-button').disabled = true;
  if (message && importDialog.open) { $('import-error').textContent = message; $('import-error').hidden = false; }
}
$<HTMLInputElement>('import-file').addEventListener('change', async event => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  invalidatePreview();
  $<HTMLTextAreaElement>('import-json').value = '';
  $('import-file-label').textContent = file.name;
  if (file.size > 2 * 1024 * 1024) { $('import-error').textContent = '文件超过 2 MB，请拆分为较小的计划文件。'; $('import-error').hidden = false; return; }
  const generation = importGeneration;
  try {
    const text = await file.text();
    if (generation !== importGeneration) return;
    $<HTMLTextAreaElement>('import-json').value = text;
    $('import-file-label').textContent = file.name;
    $('import-error').hidden = true;
  } catch { $('import-error').textContent = '无法读取这个文件，请重新选择。'; $('import-error').hidden = false; }
});
$('import-json').addEventListener('input', () => invalidatePreview());
document.querySelectorAll<HTMLInputElement>('[name="import-mode"]').forEach(input => input.addEventListener('change', () => invalidatePreview()));

async function previewImport(): Promise<void> {
  if (mutationPending) return;
  const raw = $<HTMLTextAreaElement>('import-json').value.trim();
  $('import-error').hidden = true;
  invalidatePreview();
  if (!raw) { $('import-error').textContent = '请先选择文件，或粘贴 JSON 计划。'; $('import-error').hidden = false; return; }
  let plan: unknown;
  try { plan = JSON.parse(raw); } catch { $('import-error').textContent = 'JSON 格式有误，请检查逗号、引号和括号。现有计划没有被更改。'; $('import-error').hidden = false; return; }
  const mode = document.querySelector<HTMLInputElement>('[name="import-mode"]:checked')!.value;
  const generation = importGeneration;
  $<HTMLButtonElement>('preview-import-button').disabled = true;
  $('preview-import-button').textContent = '验证中…';
  try {
    const result = await operation<Preview>('previewChanges', { import: { plan, mode } });
    if (generation !== importGeneration) return;
    if (result.baseRevision !== state?.revision) {
      await loadState(true);
      if (result.baseRevision !== state?.revision) throw new ApiError('计划已更新，请重新预览。', 409, 'STALE');
    }
    if (generation !== importGeneration) return;
    preview = result;
    const imported = result.importedTaskCount ?? ((plan && typeof plan === 'object' && 'tasks' in plan && Array.isArray(plan.tasks)) ? plan.tasks.length : 0);
    const importSummary = result.importSummary ?? result.summary;
    const dates = Object.keys(importSummary).sort();
    const modeLabel = mode === 'replace' ? '覆盖导入日期' : mode === 'merge' ? '合并任务' : '追加任务';
    $('import-preview').innerHTML = `<h3>预览通过 · ${imported} 项导入任务</h3><p>${escapeHTML(modeLabel)}：新增 ${result.changes.created} 项 · 更新 ${result.changes.updated} 项 · 删除 ${result.changes.deleted} 项。${mode === 'replace' ? '确认后将替换下列日期的全部现有任务。' : '现有的其他任务会保留。'}</p><table class="preview-table"><thead><tr><th>导入日期</th><th>任务数</th><th>预计时长</th></tr></thead><tbody>${dates.map(date => `<tr><td>${escapeHTML(date)}</td><td>${importSummary[date].total}</td><td>${duration(importSummary[date].totalMinutes)}</td></tr>`).join('')}</tbody></table><p>导入后全部计划共 ${result.taskCount} 项任务。预览有效期 15 分钟。</p>`;
    $('import-preview').hidden = false;
    $('import-status').textContent = '请核对预览，再确认导入';
    $<HTMLButtonElement>('apply-import-button').disabled = mutationPending;
  } catch (error) { await handleMutationError(error, 'import'); }
  finally { $<HTMLButtonElement>('preview-import-button').disabled = mutationPending; $('preview-import-button').textContent = '预览计划'; }
}
async function applyImport(): Promise<void> {
  if (!preview || mutationPending) return;
  const targetPreview = preview;
  try {
    await saveOperation('applyChanges', { previewId: targetPreview.previewId }, '计划已导入。可撤销最近一次更改。', targetPreview.baseRevision);
    importDialog.close();
    invalidatePreview();
  } catch (error) { await handleMutationError(error, 'import'); }
}
async function undo(): Promise<void> {
  if (!lastChange || mutationPending) return;
  if (lastChange.revision !== state?.revision) { showToast('计划已有后续更改，无法撤销旧版本。'); return; }
  try {
    await saveOperation('undoChanges', { changeId: lastChange.id }, '最近一次更改已撤销。');
    lastChange = null;
    $('toast-undo').hidden = true;
    renderUndo();
  } catch (error) { await handleMutationError(error); }
}
async function exportPlan(): Promise<void> {
  try {
    const response = await fetch('/api/export', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (!response.ok) throw new Error('导出失败，请确认本地服务已连接。');
    const blob = new Blob([JSON.stringify(await response.json(), null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `todolist-${state?.today || 'export'}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 5000);
    showToast('全部计划已导出为 JSON 文件。');
  } catch (error) { await handleMutationError(error); }
}

function changeView(nextView: ViewMode, date = selectedDate): void {
  if (!validDate(date) || (nextView === 'week' && !validDate(addDays(date, 6)))) { showToast('请选择 1900 年至 9999 年范围内的日期。'); return; }
  view = nextView;
  selectedDate = date;
  if (validDate(date)) history.replaceState(null, '', `#date=${date}&view=${nextView}`);
  render();
}
function resolveHash(): void {
  if (!state) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get('task');
  if (id && id !== loadedHashTask) {
    const task = state.tasks.find(t => t.id === id);
    loadedHashTask = id;
    if (task) { selectedDate = task.date; view = 'day'; render(); openTask(task); }
    else showToast('该任务已不存在，已打开当前计划。');
  }
}

document.addEventListener('pointerdown', () => { lastInputWasKeyboard = false; }, { capture: true });
document.addEventListener('keydown', () => { lastInputWasKeyboard = true; }, { capture: true });
document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null;
  if (!target || (target instanceof HTMLButtonElement && target.disabled)) return;
  if (target.classList.contains('task-card')) {
    // Selecting task text should allow copying it without opening the editor.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.containsNode(target, true)) return;
    // Let the dialog return keyboard focus to the task when it closes.
    target.querySelector<HTMLButtonElement>('.task-title-button')?.focus({ preventScroll: true });
  }
  const action = target.dataset.action!;
  const id = target.dataset.id;
  if (id) { void changeTask(action, id); return; }
  switch (action) {
    case 'today': if (state) changeView('day', state.today); break;
    case 'week': if (state) changeView('week', state.today); break;
    case 'previous': if (state) changeView(view, addDays(selectedDate, view === 'week' ? -7 : -1)); break;
    case 'next': if (state) changeView(view, addDays(selectedDate, view === 'week' ? 7 : 1)); break;
    case 'open-day': changeView('day', target.dataset.date!); break;
    case 'create': openTask(undefined, target.dataset.date || selectedDate); break;
    case 'close-task': if (!mutationPending) taskDialog.close(); break;
    case 'edit-task': editTaskDetails(); break;
    case 'cancel-task-edit': cancelTaskEdit(); break;
    case 'refresh': void loadState().then(() => showToast('已读取最新计划。')).catch(() => {}); break;
    case 'import': openImport(); break;
    case 'close-import': if (!mutationPending) importDialog.close(); break;
    case 'preview-import': void previewImport(); break;
    case 'apply-import': void applyImport(); break;
    case 'export': void exportPlan(); break;
    case 'undo': void undo(); break;
    case 'close-toast': $('toast').hidden = true; break;
  }
});
$<HTMLInputElement>('view-date').addEventListener('change', event => {
  const value = (event.target as HTMLInputElement).value;
  if (validDate(value)) changeView(view, value);
});
taskDialog.addEventListener('cancel', event => {
  if (mutationPending) event.preventDefault();
  else if (taskDialogMode === 'edit') { event.preventDefault(); cancelTaskEdit(); }
});
taskDialog.addEventListener('close', () => {
  // Mouse/touch dismissal should not leave a selection-like frame on the task.
  if (!lastInputWasKeyboard) {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest('.task-card')) focused.blur();
  }
});
taskDescription.addEventListener('input', resizeTaskDescription);
window.addEventListener('resize', resizeTaskDescription);
importDialog.addEventListener('cancel', event => { if (mutationPending) event.preventDefault(); });
window.addEventListener('hashchange', () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const date = params.get('date');
  if (validDate(date)) { selectedDate = date; view = params.get('view') === 'week' && validDate(addDays(date, 6)) ? 'week' : 'day'; render(); }
  resolveHash();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void loadState(true).catch(() => {}); });

// SSE pushes edits immediately. One low-frequency timer also handles midnight and recovery.
const events = new EventSource('/api/events');
events.addEventListener('open', () => { connected = true; renderConnection(); void loadState(true).catch(() => {}); });
events.addEventListener('change', () => { void loadState(true).catch(() => {}); });
events.addEventListener('error', () => { connected = false; renderConnection(); });
setInterval(() => { if (document.visibilityState === 'visible') void loadState(true).catch(() => {}); }, 60000);
const initialHash = new URLSearchParams(location.hash.slice(1));
const initialDate = initialHash.get('date');
if (validDate(initialDate)) selectedDate = initialDate;
if (initialHash.get('view') === 'week' && (!selectedDate || validDate(addDays(selectedDate, 6)))) view = 'week';
void loadState().catch(() => {});
