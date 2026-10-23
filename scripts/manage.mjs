import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(root, '.local');
mkdirSync(local, { recursive: true, mode: 0o700 });
const settingsPath = join(local, 'settings.json');
const saved = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
const settings = {
  port: Number(process.env.DAILY_PLANNER_PORT || saved.port || 43117),
  timezone: process.env.DAILY_PLANNER_TIMEZONE || saved.timezone || 'Asia/Shanghai',
  dataDir: resolve(process.env.DAILY_PLANNER_DATA_DIR || saved.dataDir || join(homedir(), 'Library/Application Support/DailyPlanner')),
  widgetDir: resolve(process.env.DAILY_PLANNER_WIDGET_DIR || saved.widgetDir || join(homedir(), 'Library/Application Support/Übersicht/widgets')),
};
if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw Error('端口必须为 1024..65535');
new Intl.DateTimeFormat('en', { timeZone: settings.timezone });
const url = `http://127.0.0.1:${settings.port}`;
const pidPath = join(local, 'process.json');
const label = 'local.daily-planner';
const plistPath = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const env = { ...process.env, DAILY_PLANNER_DATA_DIR: settings.dataDir, DAILY_PLANNER_PORT: String(settings.port), DAILY_PLANNER_TIMEZONE: settings.timezone };
const [command = 'help', subcommand] = process.argv.slice(2);
const delay = ms => new Promise(r => setTimeout(r, ms));
const xml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
function run(file, args) {
  const r = spawnSync(file, args, { cwd: root, stdio: 'inherit', env });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error(`${file} 失败 (${r.status})`);
}
async function health(base = url) {
  try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function saveSettings() {
  if (saved.port && (saved.port !== settings.port || saved.dataDir !== settings.dataDir || saved.timezone !== settings.timezone)) {
    try {
      const old = await fetch(`http://127.0.0.1:${saved.port}/health`, { signal: AbortSignal.timeout(1000) });
      const state = await old.json();
      if (state.app === 'daily-planner') throw Error('修改端口、时区或数据目录前，请先用原配置执行 ./planner stop。');
    } catch (error) {
      if (error.message.startsWith('修改端口')) throw error;
    }
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
function loaded() { return spawnSync('/bin/launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }).status === 0; }
async function stopManual() {
  if (!existsSync(pidPath)) return;
  const recorded = JSON.parse(readFileSync(pidPath, 'utf8'));
  const recordedUrl = recorded.url || `http://127.0.0.1:${saved.port || settings.port}`;
  const current = await health(recordedUrl);
  if (current?.app === 'daily-planner' && current.pid === recorded.pid && current.instanceId === recorded.instanceId) {
    process.kill(recorded.pid, 'SIGTERM');
    for (let i = 0; i < 30 && await health(recordedUrl); i++) await delay(100);
    if (await health(recordedUrl)) throw Error('服务尚未退出，保留进程记录。');
  }
  unlinkSync(pidPath);
}
async function start() {
  const previous = await health();
  if (previous?.app === 'daily-planner') { console.log(`已运行 ${url} (PID ${previous.pid})`); return; }
  if (previous) throw Error('端口由其他服务占用');
  if (loaded()) { run('/bin/launchctl', ['kickstart', `${domain}/${label}`]); }
  else {
    mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
    const { openSync, closeSync } = await import('node:fs');
    const log = join(settings.dataDir, 'service.log');
    if (existsSync(log) && (await import('node:fs')).statSync(log).size > 2 * 1024 * 1024) {
      (await import('node:fs')).renameSync(log, `${log}.previous`);
    }
    const fd = openSync(log, 'a', 0o600);
    const child = spawn(process.execPath, [join(root, 'server/index.mjs')], { cwd: root, env, stdio: ['ignore', fd, fd], detached: true });
    child.on('error', e => console.error(e.message));
    child.unref(); closeSync(fd);
  }
  for (let i = 0; i < 50; i++) {
    const current = await health();
    if (current?.app === 'daily-planner') {
      writeFileSync(pidPath, JSON.stringify({ pid: current.pid, instanceId: current.instanceId, url }), { mode: 0o600 });
      console.log(`ToDoList 已启动：${url}\n数据目录：${settings.dataDir}`); return;
    }
    await delay(100);
  }
  throw Error(`启动失败，查看 ${settings.dataDir}/service.log（可能是端口占用或数据库损坏）。`);
}
function installWidget() {
  const target = join(settings.widgetDir, 'daily-planner');
  mkdirSync(join(target, 'src'), { recursive: true });
  copyFileSync(join(root, 'widget/daily-planner.jsx'), join(target, 'daily-planner.jsx'));
  // User-maintained visual configuration survives repeated installs.
  const config = join(target, 'src/config.js');
  if (!existsSync(config)) copyFileSync(join(root, 'widget/src/config.js'), config);
  for (const file of readdirSync(join(root, 'widget/src')).filter(f => f !== 'config.js' && f !== 'connection.js')) {
    copyFileSync(join(root, 'widget/src', file), join(target, 'src', file));
  }
  writeFileSync(join(target, 'src/connection.js'), `export default ${settings.port};\n`);
  const settingsDir = join(homedir(), 'Library/Application Support/tracesOf.Uebersicht');
  const displaySettings = join(settingsDir, 'WidgetSettings.json');
  const previous = existsSync(displaySettings) ? JSON.parse(readFileSync(displaySettings, 'utf8')) : {};
  if (!existsSync(join(local, 'widget-installed'))) {
    // Seed only our widget's display preference; no changes to other widgets.
    mkdirSync(settingsDir, { recursive: true });
    if (existsSync(displaySettings)) copyFileSync(displaySettings, join(local, 'uebersicht-settings-backup.json'));
    previous['daily-planner-daily-planner-jsx'] = { showOnAllScreens: false, showOnMainScreen: true, showOnSelectedScreens: false, hidden: false, screens: [] };
    writeFileSync(`${displaySettings}.daily-planner.tmp`, JSON.stringify(previous));
    renameSync(`${displaySettings}.daily-planner.tmp`, displaySettings);
    writeFileSync(join(local, 'widget-installed'), '1\n');
  }
  console.log(`卡片已安装：${target}\n首次安装后请退出并重新打开 Übersicht，加载仅主屏的默认设置；配置交互快捷键。后续更新可 Refresh All Widgets。`);
}
async function login(enable) {
  if (!enable) {
    if (loaded()) run('/bin/launchctl', ['bootout', `${domain}/${label}`]);
    if (existsSync(plistPath)) unlinkSync(plistPath);
    console.log('已关闭本服务的登录启动；未删除任务。'); return;
  }
  await saveSettings();
  await stopManual();
  if (loaded()) run('/bin/launchctl', ['bootout', `${domain}/${label}`]);
  // launchd should not execute from privacy-protected Documents/Desktop folders.
  // Install only application code and its runtime in the normal per-user app area.
  const appDir = join(homedir(), 'Library/Application Support/DailyPlannerApp');
  for (const directory of ['server', 'web', 'runtime']) mkdirSync(join(appDir, directory), { recursive: true });
  for (const directory of ['server', 'web']) {
    for (const file of readdirSync(join(root, directory)).filter(f => /\.(mjs|html|js|css)$/.test(f))) {
      copyFileSync(join(root, directory, file), join(appDir, directory, file));
    }
  }
  copyFileSync(process.execPath, join(appDir, 'runtime/node'));
  mkdirSync(dirname(plistPath), { recursive: true });
  const logDir = join(homedir(), 'Library/Logs/DailyPlanner'); mkdirSync(logDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(join(appDir, 'runtime/node'))}</string><string>${xml(join(appDir, 'server/index.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(appDir)}</string><key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>DAILY_PLANNER_PORT</key><string>${settings.port}</string><key>DAILY_PLANNER_TIMEZONE</key><string>${xml(settings.timezone)}</string><key>DAILY_PLANNER_DATA_DIR</key><string>${xml(settings.dataDir)}</string></dict>
<key>StandardOutPath</key><string>${xml(join(logDir, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(logDir, 'service.log'))}</string>
</dict></plist>`;
  writeFileSync(plistPath, plist, { mode: 0o600 });
  run('/bin/launchctl', ['bootstrap', domain, plistPath]);
  await start();
  console.log('已启用本服务登录启动。Übersicht 的登录启动请在其 Preferences 中自行启用。');
}
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('需要 Node.js 24+');
  switch (command) {
    case 'install': await saveSettings(); installWidget(); break;
    case 'start': await saveSettings(); await start(); break;
    case 'stop': if (loaded()) run('/bin/launchctl', ['bootout', `${domain}/${label}`]); await stopManual(); console.log('服务已退出，任务已保留。'); break;
    case 'restart':
      if (loaded()) { run('/bin/launchctl', ['kickstart', '-k', `${domain}/${label}`]); await delay(200); await start(); }
      else { await stopManual(); await start(); }
      break;
    case 'status': console.log(JSON.stringify({ url, ...settings, running: await health(), loginConfigured: existsSync(plistPath), launchAgentLoaded: loaded() }, null, 2)); break;
    case 'open': await start(); run('/usr/bin/open', [url]); break;
    case 'login': if (!['enable', 'disable'].includes(subcommand)) throw Error('用法：./planner login enable|disable'); await login(subcommand === 'enable'); break;
    case 'uninstall': {
      await login(false); await stopManual();
      const target = join(settings.widgetDir, 'daily-planner/daily-planner.jsx');
      if (existsSync(target)) unlinkSync(target);
      console.log('已移除卡片入口；保留视觉配置、仓库和全部任务。完整清理见 README。'); break;
    }
    case 'deps': {
      const npm = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
      if (!existsSync(npm)) throw Error('当前运行时未包含 npm，请使用官方下载的项目 Node 或 npm ci。');
      run(process.execPath, [npm, 'ci', '--ignore-scripts']); break;
    }
    case 'test': run(process.execPath, ['--test', ...readdirSync(join(root, 'tests')).filter(f => f.endsWith('.test.mjs')).map(f => join(root, 'tests', f)), join(root, 'widget/client.test.mjs')]); break;
    case 'build': run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'web/tsconfig.json']); break;
    case 'check': run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'web/tsconfig.json', '--noEmit']); break;
    default: console.log('ToDoList · 本地桌面计划\n./planner install | start | stop | restart | status | open | deps | build | check | test\n./planner login enable|disable\n./planner uninstall\n环境变量：DAILY_PLANNER_NODE / PORT / TIMEZONE / DATA_DIR / WIDGET_DIR');
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
