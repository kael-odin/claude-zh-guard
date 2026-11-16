// CLI 入口（中文输出）
import fs from 'node:fs';
import path from 'node:path';
import { detectInstall, toolDataDir } from './detect.ts';
import { doctor } from './doctor.ts';
import { install, LANGS, launch, uninstall, type Lang } from './patch.ts';
import { getUpdatePolicyState, setUpdatesDisabled } from './policy.ts';
import { controlledUpdate, repair } from './update.ts';
import { watch, installWatchTask } from './guard.ts';
import { dictCheck, dictSync } from './dict.ts';
import { fail, info, ok, RED, run, warn } from './util.ts';

const HELP = `claude-zh-guard — 打不坏的 Claude Desktop 汉化管理器

用法: node src/cli.ts <命令> [选项]

命令:
  doctor                只读体检：安装/补丁/哈希/备份/策略 全项检查
  install               安装汉化补丁（幂等；自动备份、失败回滚）
  uninstall             卸载补丁，恢复官方纯净状态
  repair                自愈：asar 损坏→备份恢复；版本变更→重打补丁
  update                受控官方更新：恢复纯净→放行更新→自动重打补丁
  watch                 守护巡检（默认 60s；--auto-fix 自动自愈）
  watch-task install|uninstall   注册/注销开机守护计划任务
  updates on|off|status 官方自动更新策略（默认保留；off 为可选加固）
  dict check|sync       词典覆盖率检查 / 从上游仓库同步词典
  launch                MSIX 激活启动 Claude

选项:
  --lang zh-CN|zh-TW|zh-HK   界面语言（默认 zh-CN）
  --yes                      自动确认（含关闭运行中的 Claude）
  --launch                   install 完成后自动启动 Claude
  --disable-updates          安装时禁用官方自动更新（可选；默认保留）
  --interval <秒>            watch 巡检间隔（默认 60）
  --no-auto-fix              watch 只提醒不自动修复
  --elevate                  以管理员身份重新运行当前命令
  --help                     本帮助
`;

interface Args {
  cmd: string;
  positional: string[];
  lang: Lang;
  yes: boolean;
  launchFlag: boolean;
  disableUpdates: boolean;
  interval: number;
  autoFix: boolean;
  elevate: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cmd: '',
    positional: [],
    lang: 'zh-CN',
    yes: false,
    launchFlag: false,
    disableUpdates: false,
    interval: 60,
    autoFix: true,
    elevate: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    switch (a) {
      case '--lang': {
        const v = rest[++i];
        if (!v || !(LANGS as readonly string[]).includes(v)) throw new Error(`--lang 取值须为 ${LANGS.join('|')}`);
        args.lang = v as Lang;
        break;
      }
      case '--yes':
        args.yes = true;
        break;
      case '--launch':
        args.launchFlag = true;
        break;
      case '--disable-updates':
        args.disableUpdates = true;
        break;
      case '--keep-updates':
        // 兼容旧参数：现在默认就是保留更新
        args.disableUpdates = false;
        break;
      case '--interval':
        args.interval = Number(rest[++i] ?? 60);
        break;
      case '--no-auto-fix':
        args.autoFix = false;
        break;
      case '--elevate':
        args.elevate = true;
        break;
      case '--help':
      case '-h':
        args.cmd = 'help';
        break;
      default:
        if (a.startsWith('-')) throw new Error(`未知选项: ${a}`);
        if (!args.cmd) args.cmd = a;
        else args.positional.push(a);
    }
  }
  return args;
}

function elevateSelf(args: Args): never {
  info('以管理员身份重新运行 ...');
  const script = process.argv[1]!;
  const argv = [script, ...process.argv.slice(2).filter((a) => a !== '--elevate')];
  const nodeExe = process.execPath;
  const logDir = toolDataDir();
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logDir, `elevated-${stamp}.log`);
  const wrapperPath = path.join(logDir, `elevated-${stamp}.ps1`);
  const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  // Start-Process -Verb RunAs 走 ShellExecute，不能重定向标准流；
  // 因此写一个提权包装脚本，由它在内部把 node 的全部输出重定向到日志。
  const wrapper = [
    `$ErrorActionPreference = 'Continue'`,
    `& ${psQuote(nodeExe)} ${argv.map(psQuote).join(' ')} *> ${psQuote(logPath)}`,
    `$code = $LASTEXITCODE`,
    `"EXITCODE=$code" | Out-File -FilePath ${psQuote(logPath)} -Append -Encoding utf8`,
    `exit $code`,
  ].join('\r\n');
  fs.writeFileSync(wrapperPath, wrapper, 'utf8');
  const ps =
    `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(wrapperPath)} ` +
    `-Verb RunAs -PassThru -Wait; exit $p.ExitCode`;
  try {
    run('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 1_800_000 });
  } finally {
    try {
      const text = fs.readFileSync(logPath, 'utf8').trim();
      if (text) console.log(`--- 提权安装日志 (tail) ---\n${text.split(/\r?\n/).slice(-40).join('\n')}`);
    } catch {
      /* 日志不存在 */
    }
  }
  process.exit(0);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    fail((e as Error).message);
    process.exit(2);
  }

  try {
    switch (args.cmd) {
      case 'help':
      case '':
        console.log(HELP);
        return;
      case 'doctor': {
        const r = doctor(args.lang);
        const fails = r.lines.filter((l) => l.level === 'fail').length;
        const warns = r.lines.filter((l) => l.level === 'warn').length;
        console.log('');
        if (fails > 0) console.log(RED(`体检结果: ${fails} 项异常, ${warns} 项警告`));
        else if (warns > 0) console.log(`体检结果: ${warns} 项警告，无异常`);
        else ok('体检结果: 全部通过');
        process.exit(fails > 0 ? 1 : 0);
        return;
      }
      case 'install': {
        if (args.elevate) elevateSelf(args);
        await install({ lang: args.lang, yes: args.yes, launch: args.launchFlag });
        if (args.disableUpdates) {
          try {
            const r = setUpdatesDisabled(true);
            if (r.registry === 'denied') warn('注册表更新策略被系统拒绝（HKCU\\Policies 加固），不影响使用');
            else ok('已禁用官方自动更新（可选加固）。如需恢复: cdzh updates on');
            if (r.library > 0) info(`已同步 3P configLibrary ${r.library} 处`);
          } catch (e) {
            warn((e as Error).message);
          }
        } else {
          info('默认保留官方自动更新。更新落地后若界面变回英文，运行 cdzh repair 重打补丁。');
        }
        return;
      }
      case 'uninstall':
        if (args.elevate) elevateSelf(args);
        uninstall();
        return;
      case 'repair':
        if (args.elevate) elevateSelf(args);
        await repair(args.lang);
        return;
      case 'update':
        if (args.elevate) elevateSelf(args);
        await controlledUpdate({ lang: args.lang });
        return;
      case 'watch':
        await watch({ lang: args.lang, intervalSec: args.interval, autoFix: args.autoFix });
        return;
      case 'watch-task': {
        const action = args.positional[0];
        if (action !== 'install' && action !== 'uninstall') throw new Error('用法: watch-task install|uninstall');
        const projectDir = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
        installWatchTask(action, decodeURIComponent(projectDir));
        return;
      }
      case 'updates': {
        if (args.elevate) elevateSelf(args);
        const sub = args.positional[0] ?? 'status';
        if (sub === 'status') {
          const s = getUpdatePolicyState();
          console.log(`注册表 disableAutoUpdates: ${s.registry ?? '(未设置)'}`);
          for (const l of s.libraries) console.log(`configLibrary ${l.path}: disableAutoUpdates=${String(l.disableAutoUpdates)}`);
          const disabled = s.registry === '0x1' || s.libraries.some((l) => l.disableAutoUpdates === true);
          if (disabled) warn('官方自动更新: 已禁用（可选加固；恢复: cdzh --elevate updates on）');
          else ok('官方自动更新: 已允许（默认）');
        } else if (sub === 'off') {
          const r = setUpdatesDisabled(true);
          ok(`已禁用官方自动更新（注册表: ${r.registry === 'ok' ? '已写入' : '被系统拒绝'}，configLibrary: ${r.library} 处）`);
          if (r.registry === 'denied') warn('注册表策略被加固拒绝；如需彻底禁用，请用 cdzh --elevate updates off');
        } else if (sub === 'on') {
          const r = setUpdatesDisabled(false);
          ok(`已允许官方自动更新（注册表: ${r.registry === 'ok' ? '已写入 0' : '被系统拒绝'}，configLibrary: ${r.library} 处）`);
          if (r.registry === 'denied') warn('注册表策略仍为禁用；请用 cdzh --elevate updates on 以管理员身份写入');
        } else {
          throw new Error('用法: updates on|off|status');
        }
        return;
      }
      case 'dict': {
        const sub = args.positional[0] ?? 'check';
        if (sub === 'check') dictCheck(args.lang);
        else if (sub === 'sync') dictSync();
        else throw new Error('用法: dict check|sync');
        return;
      }
      case 'launch': {
        const inst = detectInstall();
        if (!inst) throw new Error('未检测到 Claude Desktop 安装');
        launch(inst);
        return;
      }
      default:
        throw new Error(`未知命令: ${args.cmd}（--help 查看帮助）`);
    }
  } catch (e) {
    const err = e as { code?: string; message: string };
    fail(err.message);
    if (err.code === 'EPERM' || err.code === 'EACCES' || /EPERM|EACCES|权限/.test(err.message)) {
      info('提示: 权限不足。可尝试 cdzh --elevate install 以管理员运行');
    }
    process.exit(1);
  }
}

main().then(undefined, (e) => {
  console.error(RED('未捕获异常:'), e);
  process.exit(1);
});
