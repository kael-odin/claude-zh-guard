# claude-zh-guard

**打不坏的 Claude Desktop 汉化管理器**（Windows / MSIX 商店版优先）。

为 [javaht/claude-desktop-zh-cn](https://github.com/javaht/claude-desktop-zh-cn) 修补方案的结构性缺陷而生的替代工具：
官方自动更新（MSIX 差量部署）会校验包内文件哈希，被改过的 `ion-dist.asar` 一旦撞上后台静默更新就会被重写成 **0 字节**，Claude 从此卡在 "Couldn't connect to Claude / ERR_UNEXPECTED"。

## 与原项目的核心差异

| | javaht/claude-desktop-zh-cn | claude-zh-guard |
|---|---|---|
| 重建方式 | 全量解包 4532 个文件再重打包 | **外科式流式重建**（不落地临时文件树） |
| per-file integrity 块 | 有 | **有（必须！）**——实测 Claude 4.29 运行时强依赖它，缺失 = 启动即 int3 崩溃 |
| 补丁面 | i18n 注入 + **3914 条硬编码替换规则**（事故重灾区）+ 菜单 JSX 注入 | 仅 i18n 词典 + 语言白名单（缺失键自动回退英文，永不崩） |
| 备份位置 | 包内 `.zh-cn-backups`（复用最旧一份） | **包外** `%LOCALAPPDATA%\claude-zh-guard\backups\<版本>\`，按版本管理、哈希校验 |
| 更新防御 | 手动（菜单里可选禁更新） | **updates off 企业策略 + 受控更新管线 + watch 守护自愈** |
| 坏了怎么办 | 提示重装 | `repair` 自动从版本匹配的备份恢复并重打补丁 |
| 事务性 | 失败提示"可能不完整" | journal 化：任何一步失败自动回滚到纯净状态 |
| 运行中写入 | 主动杀进程后写 | 同样要求退出，但**写入前校验、写入后全量复验**，失败即回滚 |

## 安装使用

要求：Windows 10+，Node.js ≥ 22.7（原生运行 TypeScript，无需构建）。

```bat
:: 体检（只读，先看看现状）
node src\cli.ts doctor

:: 安装汉化（自动关闭 Claude → 备份 → 打补丁 → 校验；失败自动回滚）
node src\cli.ts install --yes --launch

:: 禁用官方自动更新（强烈建议，防官方更新撞坏补丁）
node src\cli.ts updates off

:: 以后升级 Claude（恢复纯净 → 放行官方更新 → 自动重打补丁）
node src\cli.ts update

:: 常驻守护（可选）：官方更新后自动重打补丁；文件损坏自动自愈
node src\cli.ts watch-task install

:: 其他
node src\cli.ts uninstall          :: 恢复官方纯净状态
node src\cli.ts repair             :: 损坏自愈
node src\cli.ts dict check         :: 词典覆盖率
node src\cli.ts dict sync          :: 从上游 javaht 仓库同步最新词典
```

选项：`--lang zh-CN|zh-TW|zh-HK`（默认 zh-CN）、`--yes`（自动确认）、`--launch`（装完启动）、`--keep-updates`（不动更新策略）。

## 工作原理

Claude Desktop 前端有正规的 i18n 系统：运行时从 `app://localhost/i18n/<BCP-47>.json` 加载词典（内置 11 种语言，无中文），键为 react-intl 哈希 ID，缺失键回退英文。因此只需：

1. 向 `ion-dist.asar` **追加** `i18n/zh-CN.json`（+ `dynamic/`、`statsig/` 覆盖层）
2. 在 `assets/v1/shared-*.js` 的语言白名单 `"en-US","de-DE","fr-FR","ko-KR","ja-JP"` 后插入 `"zh-CN"`
3. 同步 `Claude.exe` 内嵌的头部 SHA256（marker：`resources\\<asar>","alg":"SHA256","value":"`）
4. 重写 `config.json` 的 `locale` + 写入桌面外壳菜单词典

其中第 3 步的哈希公式经真机验证：**exe 内嵌值 = sha256(头部 JSON 字符串字节 [16, 16+strLen))**（`app.asar` 上精确命中）。注意 ion-dist 的官方出厂嵌入值与出厂文件对不上（打包流水线的陈旧产物），运行时校验以文件实际头部为准——但**必须带 per-file integrity 块**，这是本项目踩坑后实证的关键发现。

## 开发

```bash
npm install
npm test          # node:test，含 @electron/asar 官方库交叉验证
npm run typecheck
```

`scripts/` 内含诊断脚本（probe*/dump-*），用于排查 asar 哈希与崩溃转储。

## 致谢与许可

- 词典文件（`assets/dict/`）来自 [javaht/claude-desktop-zh-cn](https://github.com/javaht/claude-desktop-zh-cn)（MIT），见 [NOTICE](NOTICE)
- 本项目代码 MIT

## 免责声明

补丁会改写 `Claude.exe` 内嵌哈希（破坏 Authenticode 签名显示）并修改应用包内文件，仅限个人设备自用；请遵守 Anthropic 的服务条款。官方大版本更新后如界面结构变化，`install` 会安全中止（不做任何修改）并提示反馈。
