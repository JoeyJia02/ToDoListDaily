// Edit the installed copy, then choose “Refresh All Widgets” in Übersicht.
// The service port is generated separately in src/connection.js by the installer.
// Keep this file inside src/: Übersicht ignores src folders as standalone widgets.
export default {
  top: 76,
  right: 28,
  width: 364,
  scale: 1,
  maxTasks: 6,
  theme: 'auto', // auto | light | dark (auto follows macOS appearance)
  refreshSeconds: 30, // values below 15 are clamped to avoid frequent polling
  fallbackTimezone: 'Asia/Shanghai',
  // Set to the shortcut chosen in Übersicht Preferences → Interaction.
  interactionShortcut: '你在 Übersicht 中设置的交互快捷键',
};
