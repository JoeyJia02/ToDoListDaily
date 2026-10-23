# Daily Planner

macOS 上的天级任务规划工具：Übersicht React/JSX 桌面卡片 + 本机 TypeScript 编辑页 + Node.js/SQLite。无账户、云端同步、TaskMap 或 Project Explorer 依赖。真实数据初始为空，示例计划不会自动导入。

## 安装与启动

需要 macOS 12+、[Übersicht](https://tracesof.net/uebersicht/) 和 Node.js 24+。本次开发机器为 macOS 26.7.1、Übersicht 1.6 (82)。无需编译原生模块，也无需安装 npm 运行依赖。

在本项目目录运行：

```sh
# 仅在缺少独立 Node 24+ 时：从 nodejs.org 下载，校验 SHA-256，安装到项目 .runtime/node
sh scripts/download-node.sh
./planner install
./planner start
./planner open
```

`install` 只复制 Daily Planner 卡片到用户的 Übersicht widgets 目录，保存本地设置；不会修改其他 Widget。重复安装保留卡片视觉配置。`start` 会检查已运行的服务，防止重复启动。`open` 打开本机编辑页。默认地址为 `http://127.0.0.1:43117`。运行时查找顺序为 `DAILY_PLANNER_NODE`、项目 `.runtime/node`、PATH、Codex 的捆绑运行时；建议独立使用者安装项目运行时，以免依赖 Codex 缓存。

安装不使用 sudo、不改系统 PATH、不改 shell 配置、不创建全局 npm 包。Node 下载脚本仅从 Node 官网获取包及校验表；需联网。Übersicht 已安装时无需重装。

## 放到桌面

1. 首次安装后退出并重新打开 Übersicht，加载仅主屏的默认设置；后续更新可从菜单栏选择 **Refresh All Widgets**。
2. 在 Daily Planner 子菜单中核对 **Show on Main Screen**；安装程序只写入本工具的主屏默认值，其他 Widget 的显示设置保留。后续重复安装保留你的选择。若 Übersicht 正在运行时覆盖了首次默认值，在菜单手动选择一次即可。
3. 在 Übersicht **Preferences** 配置 **Interaction Shortcut**。按住所配置的修饰键再点击卡片。按照系统提示自行在“系统设置 → 隐私与安全性 → 辅助功能”授予 Übersicht 权限。程序不会替你修改安全权限。
4. 卡片默认位于右上区域。它属于桌面层，普通应用窗口可遮挡。不会设置总在最前或强制跨所有 Spaces；虚拟桌面、Stage Manager、全屏和桌面图标行为由 Übersicht/macOS 控制。

如果暂时无法交互，直接运行 `./planner open` 使用完整编辑页，卡片仍会每 30 秒读取一次数据。任务标题打开详情，勾选框切换完成，右上刷新按钮主动刷新。

位置配置位于 `~/Library/Application Support/Übersicht/widgets/daily-planner/src/config.js`。配置键以该文件注释为准，包括位置、宽度、缩放及最多显示任务数。修改后 Refresh All Widgets。若桌面右侧有 Finder 文件，调节右边距或顶部位置。不要把卡片拖成遮住常用桌面文件的尺寸。自定义 Übersicht widgets 根目录可通过 `DAILY_PLANNER_WIDGET_DIR` 指定。

## 第一周计划与日常编辑

打开编辑页，选择“导入 JSON”，选取项目 `examples/` 中的示例周计划。示例包含 AI 应用岗位筛选投递、信息安全 Agent、Python Coding、408 和日终复盘，全部为待做；请先按实际日期调整。

导入必须先预览任务数量、每日总时长和改动数量，再确认写入。默认“追加”保留已有任务；已存在的相同 ID 会报错，避免重复。想更新已导入任务时选择“合并”（按稳定 ID）。明确选择“覆盖”时，只替换导入文件中出现的日期。空导入不会清空所有数据。时区不一致时需要先调整导入计划，不能默认把 UTC 日期当本地日期。

“今日”和“七日”切换视图；可新增、编辑、切换状态、设置实际分钟数、用上下按钮排序，或编辑日期跨日移动。点击删除后可撤销；任意后续写入发生后，旧撤销会被拒绝，避免覆盖别的编辑。复杂批量变更遵循预览 → 确认 → 执行 → 撤销。

浏览器多个标签会通过本机 SSE 同步。编辑中的草稿保留；若其他来源已修改数据，提交会显示版本冲突，需要核对并重新打开/保存，绝不静默覆盖。完成比例按任务数计算；取消任务不计入计划数量、时长及进度。已完成时长累计已完成任务的预计分钟数。

## 持久化、退出及登录启动

```sh
./planner status
./planner stop
./planner start
# 可选：用户级 launchd 登录启动和异常退出恢复
./planner login enable
./planner login disable
```

默认数据目录：`~/Library/Application Support/DailyPlanner`。SQLite 事务、全局版本号和历史记录保护写入，修改前保留 JSON 备份。数据与仓库分开，更新源码和关闭浏览器不会删任务。准确文件名见 `./planner status` 和架构文档。不要在服务运行时手改 SQLite 文件。

验证持久化：新增一条自己的测试任务，关闭编辑页，确认桌面仍显示；执行 `stop`/`start` 后重开页面核对；在 Übersicht 退出并重开后再次核对。最后导出 JSON 留作离线备份。登录恢复请在保存其他工作的前提下自行注销/登录验收。

登录启动包含两部分：`login enable` 管理用户 LaunchAgent；Übersicht 自身的“Launch at Login”请在其 Preferences 自行启用。未运行此命令就不会更改登录启动。启用后服务异常退出最多每 30 秒重启一次。`stop` 会卸载当前登录会话的 LaunchAgent，配置文件仍在；本会话要恢复它，运行 `login enable`，下次登录也会读取保留的配置。手动 `start` 可临时运行服务。

`login enable` 将当前服务代码、编译好的编辑页和 Node 可执行文件复制到 `~/Library/Application Support/DailyPlannerApp`，供 launchd 独立运行，避免从受隐私保护的 Documents 目录执行。无需授予整个文稿目录访问权限。更新源码或构建后，重新运行 `login enable` 更新这个安装副本。任务数据仍在 DailyPlanner 目录。移动项目不影响已安装的登录服务。

## 设置

首次 install/start 时可指定以下环境变量，值保存于本项目忽略版本管理的 `.local/settings.json`：

```sh
DAILY_PLANNER_PORT=43117 DAILY_PLANNER_TIMEZONE=Asia/Shanghai ./planner install
DAILY_PLANNER_DATA_DIR="$HOME/Library/Application Support/DailyPlanner" ./planner start
```

固定时区默认为 Asia/Shanghai。所有日期是该时区的日历日期，创建/更新时间是 UTC 瞬时时间。出差或系统时区变化不会静默移动任务。修改时区前先导出、退出服务，再重新配置并重启。服务只绑定 `127.0.0.1`；不支持局域网访问。

## 开发与验证

```sh
# 只有开发编译需要 TypeScript；使用项目运行时自带 npm
./planner deps
./planner build
./planner check
./planner test
```

发布版包含编译好的 `web/app.js`，正常使用不需要 TypeScript 编译器。源码为 `web/app.ts`，Widget 使用 Übersicht 提供的 React。后端为 ES modules，任务接口类型为 `shared/` 中的 TypeScript 模型。详见 [架构](docs/architecture.md)、[故障排查](docs/troubleshooting.md) 和 [验收报告](docs/test-report.md)。

## 卸载

```sh
./planner uninstall
```

停止服务、移除本工具的 LaunchAgent 和 Widget 入口，保留用户任务、卡片配置和仓库。需要彻底移除时，先导出 JSON；自行删除 DailyPlanner 数据目录、DailyPlannerApp 登录服务副本、日志目录、widgets/daily-planner 残留配置和本项目目录。不会自动删除个人计划或 Übersicht 应用。不要删除其他 Widget。
