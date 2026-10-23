import {run} from 'uebersicht';
import config from './src/config';
import port from './src/connection';
import {settings, createClient, formatMinutes, dateInTimezone, dateLabel, todayTasks, summarize} from './src/client';

const options = settings({...config, port});
const client = createClient(run, options.port);
let pendingRead = null;
let mutationPending = false;

// Übersicht's scheduler owns this timer. No extra interval or background loop.
export const refreshFrequency = options.refreshSeconds * 1000;
export const initialState = {data: null, offline: false, error: '', busy: false, checkedAt: null};

async function refresh(dispatch) {
  if (!pendingRead) {
    pendingRead = client.read().then(data => ({data, checkedAt: Date.now()})).catch(error => ({readError: error.message}));
  }
  const result = await pendingRead;
  pendingRead = null;
  dispatch({type: 'PLANNER/READ', ...result});
}

export const command = dispatch => refresh(dispatch);

export function updateState(event, state) {
  if (event.type === 'PLANNER/READ') {
    if (event.readError) return {...state, offline: true, error: event.readError};
    // A periodic read started before a write must never undo the newer view.
    if (state.data && event.data.revision < state.data.revision) return state;
    return {...state, data: event.data, offline: false, error: '', checkedAt: event.checkedAt};
  }
  if (event.type === 'PLANNER/BUSY') return {...state, busy: event.busy};
  if (event.type === 'PLANNER/ERROR') return {...state, error: event.error};
  // The command function dispatches its parsed data; its undefined return value
  // produces UB/COMMAND_RAN and must not replace our state.
  return state;
}

async function toggle(task, state, dispatch) {
  if (mutationPending || state.offline || !state.data) return;
  mutationPending = true;
  dispatch({type: 'PLANNER/BUSY', busy: true});
  let writeError = '';
  try {
    await client.write('updateTask', {id: task.id, patch: {status: task.status === 'done' ? 'todo' : 'done'}}, state.data.revision);
  } catch (error) {
    writeError = /conflict|revision|stale/i.test(error.code || '')
      ? '计划刚刚有更新，本次勾选未保存。请确认刷新后的任务再操作。'
      : error.message;
  }
  // Wait for a read that may have begun before the write, then fetch current
  // data so a successful toggle always appears immediately.
  if (pendingRead) await pendingRead;
  pendingRead = null;
  await refresh(dispatch);
  mutationPending = false;
  dispatch({type: 'PLANNER/BUSY', busy: false});
  if (writeError) dispatch({type: 'PLANNER/ERROR', error: writeError});
}

function openEditor(dispatch, id) {
  client.open(id).catch(() => dispatch({type: 'PLANNER/ERROR', error: '无法打开浏览器，请访问 http://127.0.0.1:' + options.port}));
}

export const className = `
  top: ${options.top}px;
  right: ${options.right}px;
  width: ${options.width}px;
  transform: scale(${options.scale});
  transform-origin: top right;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
  color: #f2f4f8;
  * { box-sizing: border-box; }
  button { font: inherit; cursor: pointer; }
  button:disabled { cursor: default; opacity: .45; }
  button:focus-visible { outline: 2px solid #7d9dff; outline-offset: 3px; }
  .planner {
    --text: #f2f4f8;
    --muted: #aeb6c5;
    --line: rgba(255,255,255,.10);
    --hover: rgba(255,255,255,.055);
    --accent: #98abff;
    color: var(--text);
    background: rgba(27,31,40,.91);
    border: 1px solid rgba(255,255,255,.16);
    border-radius: 22px;
    box-shadow: 0 16px 50px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08);
    padding: 23px 21px 15px;
    -webkit-backdrop-filter: blur(24px);
    backdrop-filter: blur(24px);
    overflow: hidden;
    max-height: calc(${100 / options.scale}vh - ${(options.top + 24) / options.scale}px);
    display: flex;
    flex-direction: column;
    > * { flex-shrink: 0; }
  }
  .planner.light {
    --text: #242936;
    --muted: #697283;
    --line: rgba(42,50,70,.11);
    --hover: rgba(42,50,70,.045);
    --accent: #4d65ce;
    background: rgba(250,251,253,.94);
    border-color: rgba(255,255,255,.85);
  }
  @media (prefers-color-scheme: light) {
    .planner.auto {
      --text: #242936; --muted: #697283; --line: rgba(42,50,70,.11);
      --hover: rgba(42,50,70,.045); --accent: #4d65ce;
      background: rgba(250,251,253,.94); border-color: rgba(255,255,255,.85);
    }
  }
  .topline { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .eyebrow { font-size: 10px; letter-spacing: .18em; font-weight: 650; color: var(--muted); }
  .icon { color: var(--muted); border: 0; background: transparent; padding: 3px 6px; border-radius: 6px; font-size: 20px; line-height: 1; }
  .icon:hover, .editor:hover { color: var(--text); background: var(--hover); }
  .date { font-size: 22px; font-weight: 650; letter-spacing: -.6px; line-height: 1.3; margin: 8px 0 17px; }
  .summary { display: flex; align-items: baseline; gap: 5px; }
  .count { font-size: 29px; line-height: 1; font-weight: 650; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
  .unit { color: var(--muted); font-size: 12px; }
  .percentage { margin-left: auto; font-size: 12px; color: var(--accent); font-weight: 600; font-variant-numeric: tabular-nums; }
  .progress { height: 5px; border-radius: 5px; background: var(--line); overflow: hidden; margin: 11px 0 10px; }
  .fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #7183d7, #a1b0f1); }
  .time { display: flex; justify-content: space-between; gap: 10px; font-size: 10px; line-height: 1.6; color: var(--muted); }
  .tasks { border-top: 1px solid var(--line); margin-top: 17px; padding-top: 5px; min-height: 36px; flex-shrink: 1; overflow-y: auto; overscroll-behavior: contain; }
  .task { display: flex; align-items: flex-start; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  .task:last-child { border-bottom: 0; }
  .check { appearance: none; -webkit-appearance: none; width: 19px; height: 19px; flex: 0 0 19px; margin: 2px 0 0; border: 1.3px solid var(--muted); border-radius: 6px; cursor: pointer; position: relative; }
  .check:checked { background: #798edb; border-color: #798edb; }
  .check:checked::after { content: ''; position: absolute; width: 8px; height: 4px; border-left: 1.8px solid #fff; border-bottom: 1.8px solid #fff; transform: rotate(-45deg); left: 4px; top: 4px; }
  .check:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .check:disabled { cursor: default; opacity: .4; }
  .detail { flex: 1; min-width: 0; text-align: left; color: inherit; background: transparent; border: 0; padding: 0; border-radius: 4px; }
  .titleline { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .title { font-size: 13px; line-height: 1.5; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .duration { font-size: 10px; white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; }
  .description { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; font-size: 11px; color: var(--muted); line-height: 1.5; margin-top: 3px; overflow-wrap: anywhere; }
  .meta { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: 5px; font-size: 9px; line-height: 1.4; color: var(--muted); }
  .category { max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .priority { font-size: 8px; }
  .priority.high { color: #e4a58f; }
  .priority.medium { color: #c4bc98; }
  .running { color: var(--accent); }
  .done .title { text-decoration: line-through; color: var(--muted); }
  .done .description, .done .meta { opacity: .65; }
  .empty { padding: 30px 10px; text-align: center; color: var(--muted); font-size: 12px; line-height: 1.8; }
  .empty strong { display: block; color: var(--text); font-size: 14px; margin-bottom: 5px; font-weight: 500; }
  .overflow { display: block; width: 100%; margin-top: 5px; padding: 8px; border: 0; color: var(--accent); background: var(--hover); border-radius: 8px; font-size: 11px; }
  .footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 14px; }
  .sync { color: var(--muted); font-size: 9px; display: flex; align-items: center; gap: 5px; }
  .dot { width: 5px; height: 5px; display: inline-block; border-radius: 50%; background: #8ab5a0; }
  .offline .dot { background: #dba274; }
  .editor { padding: 5px 7px; background: transparent; color: var(--accent); border: 0; border-radius: 6px; font-size: 11px; }
  .notice { color: var(--muted); font-size: 9px; line-height: 1.6; margin: 10px 0 0; border-top: 1px solid var(--line); padding-top: 10px; }
  .error { background: rgba(210,132,94,.13); border: 1px solid rgba(210,132,94,.28); border-radius: 8px; color: var(--text); font-size: 10px; line-height: 1.6; padding: 8px 10px; margin-top: 12px; overflow-wrap: anywhere; }
  .cache { color: #dba274; font-size: 10px; margin: -10px 0 12px; }
`;

export function render(state, dispatch) {
  const data = state.data;
  const tasks = data ? todayTasks(data) : [];
  const summary = summarize(tasks);
  const percentage = Math.round(summary.progress * 100);
  const date = data ? data.today : dateInTimezone(options.fallbackTimezone);
  const isPreviousDay = data && date !== dateInTimezone(data.timezone || options.fallbackTimezone);
  const cancelled = data ? data.tasks.filter(task => task.date === data.today && task.status === 'cancelled').length : 0;
  const lastChecked = state.checkedAt ? new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', timeZone: data ? data.timezone : options.fallbackTimezone}).format(state.checkedAt) : '';
  return (
    <section className={'planner ' + options.theme} aria-label="Daily Planner 今日计划">
      <div className="topline">
        <span className="eyebrow">DAILY PLANNER</span>
        <button className="icon" aria-label="刷新计划" title="立即从本地服务刷新" disabled={state.busy} onClick={() => refresh(dispatch)}>↻</button>
      </div>
      <h1 className="date">{dateLabel(date)}</h1>
      {isPreviousDay && <p className="cache">跨日后尚未同步 · 以下为 {date} 的缓存计划</p>}
      <div className="summary"><span className="count">{summary.completed}<span style={{fontSize: 19, color: 'var(--muted)', fontWeight: 400}}> / {summary.total}</span></span><span className="unit">项已完成</span><span className="percentage">{percentage}%</span></div>
      <div className="progress" role="progressbar" aria-label="今日完成进度" aria-valuenow={percentage} aria-valuemin="0" aria-valuemax="100"><div className="fill" style={{width: percentage + '%'}} /></div>
      <div className="time"><span>计划 {formatMinutes(summary.totalMinutes)}</span><span>已完成 {formatMinutes(summary.completedMinutes)}</span></div>
      <div className="tasks">
        {tasks.slice(0, options.maxTasks).map(task => <div className={'task ' + (task.status === 'done' ? 'done' : '')} key={task.id}>
          <input className="check" type="checkbox" checked={task.status === 'done'} disabled={state.busy || state.offline} aria-label={(task.status === 'done' ? '取消完成：' : '标记完成：') + task.title} onChange={() => toggle(task, state, dispatch)} />
          <button className="detail" title="在完整编辑器中查看和修改任务" onClick={() => openEditor(dispatch, task.id)}>
            <span className="titleline"><span className="title">{task.title}</span><span className="duration">{task.estimatedMinutes} 分</span></span>
            {task.description && <span className="description">{task.description}</span>}
            <span className="meta"><span className="category">{task.category || '未分类'}</span><span>·</span><span className={'priority ' + task.priority}>●</span><span>{({high: '高优先级', medium: '中优先级', low: '低优先级'})[task.priority]}</span>{task.status === 'in_progress' && <span className="running">· 进行中</span>}</span>
          </button>
        </div>)}
        {!tasks.length && <div className="empty"><strong>{!data ? '连接你的本地计划' : '今天，留一点空间'}</strong>{!data ? '服务启动后会自动读取任务' : '打开编辑器，安排今天的第一件事'}</div>}
      </div>
      {tasks.length > options.maxTasks && <button className="overflow" onClick={() => openEditor(dispatch)}>还有 {tasks.length - options.maxTasks} 项 · 打开完整计划</button>}
      {state.error && <div className="error" role="alert">{state.error}{data && state.offline ? ' 当前显示上次成功读取的数据。' : ''}</div>}
      <div className="footer"><span className={'sync ' + (state.offline ? 'offline' : '')}><i className="dot" />{state.offline ? '离线缓存' : state.busy ? '正在保存' : lastChecked ? lastChecked + ' 已同步' : '等待连接'}{cancelled > 0 ? ' · ' + cancelled + ' 项已取消' : ''}</span><button className="editor" onClick={() => openEditor(dispatch)}>完整编辑器 ↗</button></div>
      <p className="notice">交互：按住「{options.interactionShortcut}」再点击；需在 macOS 辅助功能中授权 Übersicht。可直接用浏览器编辑。</p>
    </section>
  );
}
