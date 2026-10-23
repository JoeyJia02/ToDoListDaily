// Native shell arguments are single-quoted; task contents never become shell code.
export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

export function settings(config) {
  return {
    port: Math.round(bounded(config.port, 43117, 1024, 65535)),
    top: bounded(config.top, 76, 0, 4000),
    right: bounded(config.right, 28, 0, 8000),
    width: bounded(config.width, 364, 280, 640),
    scale: bounded(config.scale, 1, 0.6, 1.6),
    maxTasks: Math.round(bounded(config.maxTasks, 6, 1, 7)),
    refreshSeconds: bounded(config.refreshSeconds, 30, 15, 300),
    theme: ['light', 'dark'].indexOf(config.theme) >= 0 ? config.theme : 'auto',
    fallbackTimezone: config.fallbackTimezone || 'Asia/Shanghai',
    interactionShortcut: config.interactionShortcut || 'Übersicht 中设置的交互快捷键',
  };
}

export function createClient(run, port) {
  const base = 'http://127.0.0.1:' + port;
  const request = async (path, body) => {
    let cmd = '/usr/bin/curl --silent --show-error --connect-timeout 2 --max-time 5 --noproxy ' + shellQuote('*');
    cmd += ' --header ' + shellQuote('Accept: application/json');
    if (body !== undefined) {
      cmd += ' --request POST --header ' + shellQuote('Content-Type: application/json');
      cmd += ' --header ' + shellQuote('X-Daily-Planner: 1');
      cmd += ' --data-binary ' + shellQuote(JSON.stringify(body));
    }
    let response;
    try {
      response = JSON.parse(await run(cmd + ' ' + shellQuote(base + path)));
    } catch (error) {
      throw new Error('无法连接本地服务。请启动 Daily Planner 后重试。');
    }
    if (response.error) {
      const error = new Error(response.error.message || '本次操作未保存。');
      error.code = response.error.code;
      throw error;
    }
    return response;
  };
  return {
    async read() {
      const state = await request('/api/state');
      if (!Number.isInteger(state.revision) || !Array.isArray(state.tasks) || !/^\d{4}-\d{2}-\d{2}$/.test(state.today)) {
        throw new Error('本地服务返回的数据格式不正确，请检查服务日志。');
      }
      return state;
    },
    write(operation, args, expectedRevision) {
      return request('/api/operations', {operation, args, expectedRevision});
    },
    open(id) {
      const url = base + (id ? '/#task=' + encodeURIComponent(id) : '/');
      return run('/usr/bin/open ' + shellQuote(url));
    },
  };
}

export function formatMinutes(minutes) {
  const value = Math.max(0, Number(minutes) || 0);
  if (value < 60) return value + ' 分钟';
  const rest = value % 60;
  return Math.floor(value / 60) + ' 小时' + (rest ? ' ' + rest + ' 分' : '');
}

export function dateInTimezone(timezone, now) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(now || new Date());
  const values = {};
  parts.forEach(part => { values[part.type] = part.value; });
  return values.year + '-' + values.month + '-' + values.day;
}

export function dateLabel(date) {
  // A calendar date is parsed as UTC noon solely for the weekday label, never as
  // local midnight (which would shift dates in timezones west of UTC).
  return new Intl.DateTimeFormat('zh-CN', {timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'long'}).format(new Date(date + 'T12:00:00Z'));
}

export function todayTasks(data) {
  return data.tasks.filter(task => task.date === data.today && task.status !== 'cancelled')
    .slice().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function summarize(tasks) {
  const active = tasks.filter(task => task.status !== 'cancelled');
  const completed = active.filter(task => task.status === 'done');
  return {
    total: active.length,
    completed: completed.length,
    totalMinutes: active.reduce((total, task) => total + task.estimatedMinutes, 0),
    completedMinutes: completed.reduce((total, task) => total + task.estimatedMinutes, 0),
    progress: active.length ? completed.length / active.length : 0,
  };
}
