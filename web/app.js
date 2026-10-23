"use strict";
const $ = (id) => {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Missing element: ${id}`);
    return element;
};
const form = $('task-form');
const taskDialog = $('task-dialog');
const importDialog = $('import-dialog');
const statusNames = { todo: '待做', in_progress: '进行中', done: '已完成', cancelled: '已取消' };
const priorityNames = { high: '高优先级', medium: '中优先级', low: '低优先级' };
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null;
let selectedDate = '';
let view = 'day';
let editingId = null;
let formRevision = 0;
let formSnapshot = null;
let lastChange = null;
let preview = null;
let importGeneration = 0;
let mutationPending = false;
let toastTimer;
let connected = false;
let loadedHashTask = null;
class ApiError extends Error {
    status;
    code;
    constructor(message, status, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
async function operation(name, args, revision) {
    let response;
    try {
        response = await fetch('/api/operations', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Daily-Planner': '1' },
            body: JSON.stringify({ operation: name, args, ...(revision !== undefined ? { expectedRevision: revision } : {}) }),
            signal: AbortSignal.timeout(15000)
        });
    }
    catch {
        throw new ApiError('无法连接本地服务。请启动 Daily Planner 服务后重试，当前输入已保留。', 0, 'NETWORK');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new ApiError(body.error?.message || `请求未完成（${response.status}）`, response.status, body.error?.code || 'REQUEST');
    return body;
}
async function loadState(silent = false) {
    try {
        const response = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok)
            throw new Error(`读取失败（${response.status}）`);
        const next = await response.json();
        if (!state || next.revision >= state.revision) {
            const oldToday = state?.today;
            if (!selectedDate || (oldToday && selectedDate === oldToday && next.today !== oldToday))
                selectedDate = next.today;
            state = next;
            $('global-error').hidden = true;
            connected = true;
            render();
            if (preview && preview.baseRevision !== next.revision)
                invalidatePreview('计划已经更新，请重新预览后确认导入。');
            resolveHash();
        }
        return state;
    }
    catch (error) {
        connected = false;
        renderConnection();
        if (!silent || !state) {
            $('global-error').textContent = '本地任务服务暂时不可用。请检查服务是否启动，再点击右上角刷新。已有数据仍保存在本机；当前编辑内容会保留。';
            $('global-error').hidden = false;
            if (!state)
                $('task-sections').innerHTML = '<div class="empty-state"><h3>等待本地服务</h3><p>启动 Daily Planner 服务后，这里会显示你的计划。</p><button class="secondary-button" data-action="refresh">重新连接</button></div>';
        }
        throw error;
    }
}
function validDate(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    if (value < '1900-01-01' || value > '9999-12-31')
        return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function addDays(value, amount) {
    const date = new Date(`${value}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
}
function dateLabel(value, options) {
    return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
}
function duration(minutes) {
    if (minutes === 0)
        return '0 分钟';
    return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}` : `${minutes} 分钟`;
}
function summary(tasks) {
    const active = tasks.filter(task => task.status !== 'cancelled');
    const done = active.filter(task => task.status === 'done');
    return { total: active.length, completed: done.length, totalMinutes: active.reduce((n, t) => n + t.estimatedMinutes, 0), completedMinutes: done.reduce((n, t) => n + t.estimatedMinutes, 0), progress: active.length ? done.length / active.length : 0 };
}
function tasksOn(date) { return state.tasks.filter(t => t.date === date).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)); }
function visibleDates() { return Array.from({ length: view === 'week' ? 7 : 1 }, (_, i) => addDays(selectedDate, i)); }
function renderConnection() {
    $('connection-dot').className = `status-dot ${connected ? 'online' : 'offline'}`;
    $('connection-label').textContent = connected ? '本地服务已连接' : '正在重新连接';
    if (state) {
        $('timezone-label').textContent = `仅保存在本机 · ${state.timezone}`;
        $('sync-label').textContent = connected ? `已同步 · 版本 ${state.revision} · ${state.timezone}` : '连接已断开 · 等待服务恢复';
    }
}
function render() {
    if (!state)
        return;
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
    const progress = $('progress-fill');
    progress.value = percent;
    progress.textContent = `${percent}%`;
    $('section-title').textContent = isWeek ? '七天的安排' : isToday ? '今天要做的事' : '这一天的安排';
    $('view-date').value = selectedDate;
    $('previous-button').setAttribute('aria-label', isWeek ? '前七天' : '前一天');
    $('next-button').setAttribute('aria-label', isWeek ? '后七天' : '后一天');
    $('week-strip').hidden = !isWeek;
    if (isWeek)
        $('week-strip').innerHTML = dates.map(date => {
            const day = summary(tasksOn(date));
            return `<button class="week-day${date === state.today ? ' is-today' : ''}" data-action="open-day" data-date="${date}" aria-label="查看${date}任务"><small>${dateLabel(date, { weekday: 'short' })}</small><strong>${Number(date.slice(8))}</strong><span>${day.total ? duration(day.totalMinutes) : '留一点空白'}</span></button>`;
        }).join('');
    $('task-sections').innerHTML = isWeek ? dates.map(date => renderDay(date)).join('') : renderTaskList(selectedDate);
    renderUndo();
    renderConnection();
}
function durationHTML(minutes) {
    return minutes < 60 ? `${minutes}<small>分钟</small>` : `${Math.floor(minutes / 60)}<small>小时</small>${minutes % 60 ? ` ${minutes % 60}<small>分钟</small>` : ''}`;
}
function renderDay(date) {
    const day = summary(tasksOn(date));
    return `<section class="day-group" aria-label="${date}"><div class="day-heading"><h3>${dateLabel(date, { month: 'long', day: 'numeric', weekday: 'short' })}${date === state.today ? '<span>今天</span>' : ''}</h3><span>${day.total} 项任务 · ${duration(day.totalMinutes)}</span></div>${renderTaskList(date, true)}</section>`;
}
function renderTaskList(date, compact = false) {
    const tasks = tasksOn(date);
    if (!tasks.length)
        return compact ? `<div class="empty-state compact"><p>这一天还留着空白。</p><button class="text-button" data-action="create" data-date="${date}">+ 安排一件事</button></div>` : `<div class="empty-state"><div class="empty-illustration" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M7 33h34M13 28a11 11 0 0 1 22 0M24 5v5M8 13l4 4m28-4-4 4M4 26h5m30 0h5M13 40h22"/></svg></div><h3>今天，从一件小事开始</h3><p>把想做的事写下来，让每一天更有方向。<br>也可以导入你已经准备好的 JSON 计划。</p><button class="secondary-button" data-action="create" data-date="${date}">+ 安排第一件事</button><button class="text-button" data-action="import">导入已有计划 ↗</button></div>`;
    return `<div class="task-list">${tasks.map((task, i) => renderTask(task, i, tasks.length)).join('')}</div>`;
}
function renderTask(task, index, length) {
    const id = escapeHTML(task.id);
    const categoryColors = { '求职': 'c1', 'Coding': 'c2', '408': 'c3', '复盘': 'c4' };
    const done = task.status === 'done';
    return `<article class="task-card${done ? ' is-done' : ''}${task.status === 'cancelled' ? ' is-cancelled' : ''}">
    <button class="task-check" data-action="toggle" data-id="${id}" role="checkbox" aria-checked="${done}" aria-label="${done ? '取消完成' : '完成任务'}：${escapeHTML(task.title)}"${mutationPending ? ' disabled' : ''}>${done ? '✓' : ''}</button>
    <div class="task-body"><button class="task-title-button" data-action="edit" data-id="${id}" title="查看或编辑任务"><span class="task-title">${escapeHTML(task.title)}</span></button>${task.description ? `<p class="task-description">${escapeHTML(task.description)}</p>` : ''}<div class="task-meta"><span class="category-badge ${categoryColors[task.category] || ''}">${escapeHTML(task.category || '未分类')}</span><span class="priority-tag ${task.priority}"><span class="priority-dot"></span>${priorityNames[task.priority]}</span>${task.status !== 'todo' ? `<span class="status-tag ${task.status === 'in_progress' ? 'in-progress' : ''}">${statusNames[task.status]}</span>` : ''}${task.actualMinutes !== null ? `<span class="status-tag">实际 ${task.actualMinutes} 分钟</span>` : ''}</div></div>
    <div class="task-right"><div class="task-duration"><strong>${task.estimatedMinutes}</strong> 分钟</div><div class="task-actions"><button class="icon-button" data-action="up" data-id="${id}" aria-label="上移：${escapeHTML(task.title)}" title="上移"${index === 0 || mutationPending ? ' disabled' : ''}>↑</button><button class="icon-button" data-action="down" data-id="${id}" aria-label="下移：${escapeHTML(task.title)}" title="下移"${index === length - 1 || mutationPending ? ' disabled' : ''}>↓</button><button class="icon-button edit-button" data-action="edit" data-id="${id}" aria-label="编辑：${escapeHTML(task.title)}" title="编辑"><svg viewBox="0 0 24 24"><path d="m16 4 4 4M4 20l4-1 12-12-3-3L5 16Z"/></svg></button><button class="icon-button delete-button" data-action="delete" data-id="${id}" aria-label="删除：${escapeHTML(task.title)}" title="删除，可撤销"${mutationPending ? ' disabled' : ''}><svg viewBox="0 0 24 24"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></svg></button></div></div>
  </article>`;
}
function showToast(message, undo = false) {
    clearTimeout(toastTimer);
    $('toast-message').textContent = message;
    $('toast-undo').hidden = !undo;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, undo ? 20000 : 6500);
    renderUndo();
}
function renderUndo() {
    const allowed = !!lastChange && lastChange.revision === state?.revision && !mutationPending;
    $('undo-button').disabled = !allowed;
    $('toast-undo').disabled = !allowed;
    $('undo-button').title = allowed ? '撤销最近一次更改' : '有后续更改时，无法撤销旧版本';
}
function setMutationPending(value) {
    mutationPending = value;
    $('save-task-button').disabled = value;
    $('preview-import-button').disabled = value;
    $('apply-import-button').disabled = value || !preview || preview.baseRevision !== state?.revision;
    render();
}
async function saveOperation(name, args, message, revision = state?.revision) {
    if (mutationPending)
        throw new ApiError('正在保存上一项更改，请稍候。', 0, 'BUSY');
    if (revision === undefined)
        throw new ApiError('请等待本地服务连接后再保存。', 0, 'NOT_READY');
    setMutationPending(true);
    try {
        const result = await operation(name, args, revision);
        if (result.changeId)
            lastChange = { id: result.changeId, revision: result.revision };
        try {
            await loadState(true);
        }
        catch { /* The write succeeded; reconnecting keeps its durable result. */ }
        showToast(message, !!result.changeId);
        return result;
    }
    finally {
        setMutationPending(false);
    }
}
async function handleMutationError(error, target = 'global') {
    const conflict = error instanceof ApiError && error.status === 409;
    if (conflict) {
        try {
            await loadState(true);
        }
        catch { /* Keep user input even if reconnection fails. */ }
    }
    const detail = error instanceof Error ? error.message : '操作未完成，请重试。';
    if (target === 'task') {
        const message = conflict ? '计划已被其他页面或桌面卡片修改。你的输入已保留，尚未保存。\n请核对最新计划后再次保存；如任务已被删除，请关闭编辑后重新新建。' : detail;
        $('task-error').textContent = message;
        $('task-error').hidden = false;
        if (conflict && state) {
            formRevision = state.revision;
            $('save-task-button').textContent = '核对后再次保存';
            if (editingId && !state.tasks.some(t => t.id === editingId))
                $('save-task-button').disabled = true;
        }
    }
    else if (target === 'import') {
        $('import-error').textContent = conflict ? '预览后计划有了新更改。尚未导入，请重新预览再确认。' : detail;
        $('import-error').hidden = false;
        if (conflict)
            invalidatePreview();
    }
    else
        showToast(conflict ? '其他地方已修改计划，最新内容已加载。请核对后重试。' : detail);
}
function taskValues(task) {
    const { title, description, date, estimatedMinutes, actualMinutes, category, priority, status } = task;
    return { title, description, date, estimatedMinutes, actualMinutes, category, priority, status };
}
function openTask(task, date = selectedDate) {
    if (!state) {
        showToast('请先连接本地服务。');
        return;
    }
    editingId = task?.id ?? null;
    formRevision = state.revision;
    formSnapshot = task ? taskValues(task) : null;
    form.reset();
    const values = task ? taskValues(task) : { title: '', description: '', date, estimatedMinutes: 30, actualMinutes: null, category: '项目', priority: 'medium', status: 'todo' };
    for (const [key, value] of Object.entries(values)) {
        const element = form.elements.namedItem(key);
        element.value = value === null ? '' : String(value);
    }
    $('task-dialog-title').textContent = task ? '编辑任务' : '安排一件事';
    $('save-task-button').textContent = task ? '保存更改' : '创建任务';
    $('save-task-button').disabled = mutationPending;
    $('task-error').hidden = true;
    $('task-meta').textContent = task ? `修改日期即可移动任务 · 版本 ${formRevision}` : '保存后会同步到桌面卡片';
    if (!taskDialog.open)
        taskDialog.showModal();
    requestAnimationFrame(() => $('task-title').focus());
}
form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity() || mutationPending)
        return;
    const values = new FormData(form);
    const task = {
        title: String(values.get('title')).trim(), description: String(values.get('description')).trim(),
        date: String(values.get('date')), estimatedMinutes: Number(values.get('estimatedMinutes')),
        actualMinutes: values.get('actualMinutes') === '' ? null : Number(values.get('actualMinutes')),
        category: String(values.get('category')).trim(), priority: values.get('priority'), status: values.get('status')
    };
    if (!task.title) {
        $('task-error').textContent = '请填写任务名称。';
        $('task-error').hidden = false;
        return;
    }
    $('task-error').hidden = true;
    // Sending only intentionally changed fields protects unrelated concurrent edits after review.
    const patch = formSnapshot ? Object.fromEntries(Object.entries(task).filter(([key, value]) => value !== formSnapshot[key])) : task;
    try {
        if (editingId && Object.keys(patch).length === 0) {
            taskDialog.close();
            return;
        }
        await saveOperation(editingId ? 'updateTask' : 'createTask', editingId ? { id: editingId, patch } : { task }, editingId ? '任务已更新，桌面卡片会同步。' : '新任务已安排。', formRevision);
        taskDialog.close();
        if (view === 'day' && task.date !== selectedDate) {
            selectedDate = task.date;
            render();
        }
    }
    catch (error) {
        await handleMutationError(error, 'task');
    }
});
async function changeTask(action, id) {
    if (!state || mutationPending)
        return;
    const task = state.tasks.find(t => t.id === id);
    if (!task) {
        showToast('该任务已不存在，请刷新计划。');
        return;
    }
    if (action === 'edit') {
        openTask(task);
        return;
    }
    try {
        if (action === 'toggle')
            await saveOperation('updateTask', { id, patch: { status: task.status === 'done' ? 'todo' : 'done' } }, task.status === 'done' ? '已取消完成。' : '又完成了一件事。');
        else if (action === 'delete')
            await saveOperation('deleteTask', { id }, `已删除「${task.title}」。可撤销最近一次更改。`);
        else if (action === 'up' || action === 'down') {
            const ids = tasksOn(task.date).map(t => t.id);
            const index = ids.indexOf(id), target = index + (action === 'up' ? -1 : 1);
            if (target < 0 || target >= ids.length)
                return;
            [ids[index], ids[target]] = [ids[target], ids[index]];
            await saveOperation('reorderTasks', { date: task.date, ids }, '任务顺序已调整。');
        }
    }
    catch (error) {
        await handleMutationError(error);
    }
}
function openImport() {
    if (!state) {
        showToast('请先连接本地服务。');
        return;
    }
    const append = document.querySelector('[name="import-mode"][value="append"]');
    append.checked = true;
    invalidatePreview();
    $('import-error').hidden = true;
    $('import-status').textContent = '当前计划不会自动被覆盖';
    importDialog.showModal();
}
function invalidatePreview(message) {
    preview = null;
    importGeneration++;
    $('import-preview').hidden = true;
    $('apply-import-button').disabled = true;
    if (message && importDialog.open) {
        $('import-error').textContent = message;
        $('import-error').hidden = false;
    }
}
$('import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file)
        return;
    invalidatePreview();
    $('import-json').value = '';
    $('import-file-label').textContent = file.name;
    if (file.size > 2 * 1024 * 1024) {
        $('import-error').textContent = '文件超过 2 MB，请拆分为较小的计划文件。';
        $('import-error').hidden = false;
        return;
    }
    const generation = importGeneration;
    try {
        const text = await file.text();
        if (generation !== importGeneration)
            return;
        $('import-json').value = text;
        $('import-file-label').textContent = file.name;
        $('import-error').hidden = true;
    }
    catch {
        $('import-error').textContent = '无法读取这个文件，请重新选择。';
        $('import-error').hidden = false;
    }
});
$('import-json').addEventListener('input', () => invalidatePreview());
document.querySelectorAll('[name="import-mode"]').forEach(input => input.addEventListener('change', () => invalidatePreview()));
async function previewImport() {
    if (mutationPending)
        return;
    const raw = $('import-json').value.trim();
    $('import-error').hidden = true;
    invalidatePreview();
    if (!raw) {
        $('import-error').textContent = '请先选择文件，或粘贴 JSON 计划。';
        $('import-error').hidden = false;
        return;
    }
    let plan;
    try {
        plan = JSON.parse(raw);
    }
    catch {
        $('import-error').textContent = 'JSON 格式有误，请检查逗号、引号和括号。现有计划没有被更改。';
        $('import-error').hidden = false;
        return;
    }
    const mode = document.querySelector('[name="import-mode"]:checked').value;
    const generation = importGeneration;
    $('preview-import-button').disabled = true;
    $('preview-import-button').textContent = '验证中…';
    try {
        const result = await operation('previewChanges', { import: { plan, mode } });
        if (generation !== importGeneration)
            return;
        if (result.baseRevision !== state?.revision) {
            await loadState(true);
            if (result.baseRevision !== state?.revision)
                throw new ApiError('计划已更新，请重新预览。', 409, 'STALE');
        }
        if (generation !== importGeneration)
            return;
        preview = result;
        const imported = result.importedTaskCount ?? ((plan && typeof plan === 'object' && 'tasks' in plan && Array.isArray(plan.tasks)) ? plan.tasks.length : 0);
        const importSummary = result.importSummary ?? result.summary;
        const dates = Object.keys(importSummary).sort();
        const modeLabel = mode === 'replace' ? '覆盖导入日期' : mode === 'merge' ? '合并任务' : '追加任务';
        $('import-preview').innerHTML = `<h3>预览通过 · ${imported} 项导入任务</h3><p>${escapeHTML(modeLabel)}：新增 ${result.changes.created} 项 · 更新 ${result.changes.updated} 项 · 删除 ${result.changes.deleted} 项。${mode === 'replace' ? '确认后将替换下列日期的全部现有任务。' : '现有的其他任务会保留。'}</p><table class="preview-table"><thead><tr><th>导入日期</th><th>任务数</th><th>预计时长</th></tr></thead><tbody>${dates.map(date => `<tr><td>${escapeHTML(date)}</td><td>${importSummary[date].total}</td><td>${duration(importSummary[date].totalMinutes)}</td></tr>`).join('')}</tbody></table><p>导入后全部计划共 ${result.taskCount} 项任务。预览有效期 15 分钟。</p>`;
        $('import-preview').hidden = false;
        $('import-status').textContent = '请核对预览，再确认导入';
        $('apply-import-button').disabled = mutationPending;
    }
    catch (error) {
        await handleMutationError(error, 'import');
    }
    finally {
        $('preview-import-button').disabled = mutationPending;
        $('preview-import-button').textContent = '预览计划';
    }
}
async function applyImport() {
    if (!preview || mutationPending)
        return;
    const targetPreview = preview;
    try {
        await saveOperation('applyChanges', { previewId: targetPreview.previewId }, '计划已导入。可撤销最近一次更改。', targetPreview.baseRevision);
        importDialog.close();
        invalidatePreview();
    }
    catch (error) {
        await handleMutationError(error, 'import');
    }
}
async function undo() {
    if (!lastChange || mutationPending)
        return;
    if (lastChange.revision !== state?.revision) {
        showToast('计划已有后续更改，无法撤销旧版本。');
        return;
    }
    try {
        await saveOperation('undoChanges', { changeId: lastChange.id }, '最近一次更改已撤销。');
        lastChange = null;
        $('toast-undo').hidden = true;
        renderUndo();
    }
    catch (error) {
        await handleMutationError(error);
    }
}
async function exportPlan() {
    try {
        const response = await fetch('/api/export', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
        if (!response.ok)
            throw new Error('导出失败，请确认本地服务已连接。');
        const blob = new Blob([JSON.stringify(await response.json(), null, 2)], { type: 'application/json' });
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = `daily-planner-${state?.today || 'export'}.json`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(href), 5000);
        showToast('全部计划已导出为 JSON 文件。');
    }
    catch (error) {
        await handleMutationError(error);
    }
}
function changeView(nextView, date = selectedDate) {
    if (!validDate(date) || (nextView === 'week' && !validDate(addDays(date, 6)))) {
        showToast('请选择 1900 年至 9999 年范围内的日期。');
        return;
    }
    view = nextView;
    selectedDate = date;
    if (validDate(date))
        history.replaceState(null, '', `#date=${date}&view=${nextView}`);
    render();
}
function resolveHash() {
    if (!state)
        return;
    const params = new URLSearchParams(location.hash.slice(1));
    const id = params.get('task');
    if (id && id !== loadedHashTask) {
        const task = state.tasks.find(t => t.id === id);
        loadedHashTask = id;
        if (task) {
            selectedDate = task.date;
            view = 'day';
            render();
            openTask(task);
        }
        else
            showToast('该任务已不存在，已打开当前计划。');
    }
}
document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || (target instanceof HTMLButtonElement && target.disabled))
        return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (id) {
        void changeTask(action, id);
        return;
    }
    switch (action) {
        case 'today':
            if (state)
                changeView('day', state.today);
            break;
        case 'week':
            if (state)
                changeView('week', state.today);
            break;
        case 'previous':
            if (state)
                changeView(view, addDays(selectedDate, view === 'week' ? -7 : -1));
            break;
        case 'next':
            if (state)
                changeView(view, addDays(selectedDate, view === 'week' ? 7 : 1));
            break;
        case 'open-day':
            changeView('day', target.dataset.date);
            break;
        case 'create':
            openTask(undefined, target.dataset.date || selectedDate);
            break;
        case 'close-task':
            if (!mutationPending)
                taskDialog.close();
            break;
        case 'refresh':
            void loadState().then(() => showToast('已读取最新计划。')).catch(() => { });
            break;
        case 'import':
            openImport();
            break;
        case 'close-import':
            if (!mutationPending)
                importDialog.close();
            break;
        case 'preview-import':
            void previewImport();
            break;
        case 'apply-import':
            void applyImport();
            break;
        case 'export':
            void exportPlan();
            break;
        case 'undo':
            void undo();
            break;
        case 'close-toast':
            $('toast').hidden = true;
            break;
    }
});
$('view-date').addEventListener('change', event => {
    const value = event.target.value;
    if (validDate(value))
        changeView(view, value);
});
taskDialog.addEventListener('cancel', event => { if (mutationPending)
    event.preventDefault(); });
importDialog.addEventListener('cancel', event => { if (mutationPending)
    event.preventDefault(); });
window.addEventListener('hashchange', () => {
    const params = new URLSearchParams(location.hash.slice(1));
    const date = params.get('date');
    if (validDate(date)) {
        selectedDate = date;
        view = params.get('view') === 'week' && validDate(addDays(date, 6)) ? 'week' : 'day';
        render();
    }
    resolveHash();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible')
    void loadState(true).catch(() => { }); });
// SSE pushes edits immediately. One low-frequency timer also handles midnight and recovery.
const events = new EventSource('/api/events');
events.addEventListener('open', () => { connected = true; renderConnection(); void loadState(true).catch(() => { }); });
events.addEventListener('change', () => { void loadState(true).catch(() => { }); });
events.addEventListener('error', () => { connected = false; renderConnection(); });
setInterval(() => { if (document.visibilityState === 'visible')
    void loadState(true).catch(() => { }); }, 60000);
const initialHash = new URLSearchParams(location.hash.slice(1));
const initialDate = initialHash.get('date');
if (validDate(initialDate))
    selectedDate = initialDate;
if (initialHash.get('view') === 'week' && (!selectedDate || validDate(addDays(selectedDate, 6))))
    view = 'week';
void loadState().catch(() => { });
