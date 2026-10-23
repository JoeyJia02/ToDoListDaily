# 故障排查

## 卡片不显示或无法点击

确认 Übersicht 已启动，在菜单中 Refresh All Widgets；检查 daily-planner 是否被隐藏、是否选择主屏以及当前 Space。只安装本工具入口，不启用已禁用的其他 Widget。检查 `src/config.js` 的边距、宽度、scale，防止卡片被挤出屏幕。多个显示器或改变分辨率后重新检查主屏设置。

点击受 Übersicht Interaction Shortcut 和 macOS 辅助功能限制。按住用户配置的快捷键操作；没有配置时到 Preferences 设置，权限由用户在系统设置授予。不要修改 TCC 数据库、关闭 SIP 或使用不透明脚本绕过。可用 `./planner open` 的浏览器编辑器替代桌面交互。

## 数据服务不可用

先运行 `./planner status`，再 `./planner start`。日志在所配置数据目录的 `service.log`；launchd 模式日志在 `~/Library/Logs/DailyPlanner/service.log`。手动启动日志超过 2 MiB 时轮换一个 previous；launchd 日志需长期使用者定期检查/清理，不记录任务正文和请求体。

端口被占用时不要结束不认识的进程。选择新端口并对 install/start 使用同一配置，重启服务/刷新卡片；若已配置 login enable，重新运行该命令更新设置。`install` 生成 `src/connection.js` 保存端口。

停止只会针对健康端点的 PID 与本工具保存的 instanceId 一致的进程发 SIGTERM，避免 PID 重用误杀。手动在终端启动 `node server/index.mjs` 的进程由该终端 Ctrl+C 结束。`stop` 会 bootout 当前会话 LaunchAgent；配置保留，`login enable` 重新加载。

## 版本冲突、导入失败或预览失效

版本冲突说明另一个页面或卡片已写入。保留草稿，读取最新数据、核对内容后重开任务再提交；不要盲目自动重试写入。导入校验失败时原库不变，按报错修改字段、日期、预计时长或重复 ID。合并按 id 匹配，不以相似标题推断任务。重复导入同一文件请选合并并先预览。服务重启或超过预览有效期后需要重新预览。

## 数据库损坏与恢复

服务遇到损坏会停止，不自动丢弃文件。先停止服务并复制整个数据目录（包含 SQLite WAL/SHM，如果存在）。保留原目录。设置 DAILY_PLANNER_DATA_DIR 到新目录启动；在新编辑页预览导入 backups 中最近的正常 JSON 或自己的导出，核对数量和时长后应用。恢复到新数据库后，在 Übersicht 中 Refresh All Widgets，清除旧 revision 的缓存。确认恢复后再决定是否保留新目录。切勿一边运行服务一边覆盖 SQLite，也不要只复制运行中的单个 sqlite 文件作为唯一备份。

## 登录恢复与运行时

`./planner login enable` 将服务和运行时安装到 `~/Library/Application Support/DailyPlannerApp`，生成用户 LaunchAgent 并立即加载，不需要管理员权限。不要手改 plist 使其从 Documents/Desktop 直接执行；本次实测该路径的 Node 在 launchd 中停在 dyld 文件打开阶段。安装副本在 Application Support 运行已验证正常，不修改 macOS 隐私权限。系统“登录项”中若禁用后台项目，需自行允许。Übersicht 自身的登录启动另行设置。Mac 注销、重启、全屏、锁屏后的恢复必须在真实环境验收，自动化测试不能替代它。

Node 路径失效或更新代码：运行官方下载脚本安装项目运行时，再重新 login enable 更新安装副本。移动项目不影响现有安装副本，后续更新需从新目录运行命令。开发构建用 ./planner deps 获取 TypeScript，运行不需要 node_modules。
