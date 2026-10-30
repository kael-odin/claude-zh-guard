<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="claude-zh-guard：给 Windows 版 Claude Desktop 装上中文界面，官方自动更新再也撞不坏；右侧是 cdzh doctor 体检全绿的输出">
</p>

**打不坏的 Claude Desktop 汉化管理器**——给微软商店版 Claude Desktop 装上简繁中文界面，并用备份、守护和自动回滚保证官方更新永远不会把界面弄坏。

![platform](https://img.shields.io/badge/platform-Windows_10+-00599C) ![runtime](https://img.shields.io/badge/Node.js-%E2%89%A522.7-339933) ![license](https://img.shields.io/badge/license-MIT-green) ![claude](https://img.shields.io/badge/Claude_Desktop-4.29%E2%80%934.4212 tested-D97757) ![coverage](https://img.shields.io/badge/%E8%AF%8D%E5%85%B8%E8%A6%86%E7%9B%96-89.8%25-6FBF73)

## 为什么会有这个项目

Claude Desktop 的界面包 `ion-dist.asar` 被 [javaht/claude-desktop-zh-cn](https://github.com/javaht/claude-desktop-zh-cn) 等汉化方案改写后，官方后台静默更新的差量部署会发现哈希对不上、强制重写文件——写坏的那天，应用就永远卡在 *"Couldn't connect to Claude / ERR_UNEXPECTED"*（真机实录：`ion-dist.asar` 被写成 **0 字节**）。

claude-zh-guard 从架构上终结这个循环：**纯净备份在包外、更新走受控管线、坏了自己修回来**。你只管用中文界面，升级的事它管。

## 快速开始

要求：Windows 10+，[Node.js](https://nodejs.org) ≥ 22.7（原生运行 TypeScript，无需构建）。

```bat
node src\cli.ts doctor                  :: 先体检，看看现状（只读）
node src\cli.ts install --yes --launch  :: 装中文界面（自动备份，失败即回滚）
node src\cli.ts updates off             :: 禁官方静默更新（强烈建议）
```

以后想升级 Claude：

```bat
node src\cli.ts update    :: 恢复纯净 → 放行官方更新 → 自动重打补丁 → 重启
```

<p align="center">
  <img src="./assets/readme/workflow.svg" width="100%" alt="cdzh update 四阶段：恢复纯净 → 放行官方更新 → 重打补丁 → 体检全绿，失败自动回滚">
</p>

日常还有两道保险：`doctor` 一键体检，`repair` 损坏自愈（从版本匹配的备份恢复并重打补丁）；`watch-task install` 注册开机守护后，官方更新落地会自动重打补丁。

## 和原方案比，强在哪

| | javaht/claude-desktop-zh-cn | claude-zh-guard |
|---|---|---|
| 重建方式 | 全量解包 4532 个文件再重打包 | 外科式流式重建，不落地临时文件 |
| integrity 块 | 有 | 有（实测 Claude 4.29+ 缺它=启动即崩溃） |
| 补丁面 | i18n + 3914 条硬编码替换（事故重灾区） | 仅 i18n 词典 + 语言白名单，缺词回退英文 |
| 备份 | 包内 `.zh-cn-backups`，复用最旧一份 | 包外按版本管理，哈希校验 |
| 官方更新 | 手动应对 | 受控管线 + 守护自愈 + 策略禁更 |
| 出问题后 | 提示"可能不完整" | journal 事务自动回滚，`repair` 一键自愈 |

## 命令参考

<details>
<summary>全部命令与选项</summary>

```text
doctor                  只读体检：安装/补丁/哈希/备份/策略 全项检查
install                 安装汉化补丁（幂等；自动备份、失败回滚）
uninstall               卸载补丁，恢复官方纯净状态
repair                  自愈：损坏→备份恢复；版本变更→重打补丁
update                  受控官方更新管线
watch                   守护巡检（--interval 秒数；--no-auto-fix 只提醒）
watch-task install|uninstall   注册/注销开机守护计划任务
updates on|off|status   官方自动更新策略
dict check|sync         词典覆盖率 / 从上游仓库同步
launch                  MSIX 激活启动 Claude
```

选项：`--lang zh-CN|zh-TW|zh-HK` · `--yes` · `--launch` · `--keep-updates` · `--elevate`
</details>

## 工作原理

Claude 前端有正规的 i18n 系统：运行时加载 `/i18n/<语言>.json`（内置 11 种语言，恰好没有中文），缺失键自动回退英文。所以补丁只需要四步：

1. 向 `ion-dist.asar` 追加 `i18n/zh-CN.json`（+ dynamic/statsig 覆盖层）
2. 在界面 JS 的语言白名单里插入 `"zh-CN"`
3. 补全 per-file integrity 块（**实测 Claude 4.29+ 没有它启动即崩**），同步 `Claude.exe` 内嵌头部哈希
4. 写入 `config.json` 的 `locale` 与桌面菜单词典

诊断脚本（asar 哈希探测、崩溃转储解析）在 [`scripts/`](scripts/)。

## 词典与致谢

界面词典来自 [javaht/claude-desktop-zh-cn](https://github.com/javaht/claude-desktop-zh-cn)（MIT），简繁繁体（zh-CN/TW/HK）三套齐备，见 [NOTICE](NOTICE)。`dict sync` 可随时从上游拉最新词典，`dict check` 查看对当前版本的覆盖率（当前 89.8%，未覆盖键回退英文显示）。

## License

[MIT](LICENSE) © claude-zh-guard contributors。补丁会修改应用包内文件并重写 `Claude.exe` 内嵌哈希（签名状态改变），仅限个人设备自用，请遵守 Anthropic 服务条款。
