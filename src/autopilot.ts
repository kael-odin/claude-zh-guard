// Autopilot：官方自动更新照常开；发现问题自动注册新版、备份、重打补丁并启动
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, detectInstall, findStagedNewerPackage, toolDataDir } from './detect.ts';
import { assessIonDist, install, launch, makeBackup, restorePristine, type Lang } from './patch.ts';
import { loadState } from './state.ts';
import { info, listClaudePids, LockFile, log, ok, run, stopClaudeProcesses, warn } from './util.ts';

const TASK_NAME = 'claude-zh-guard-autopilot';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AutopilotOptions {
  lang: Lang;
  launchAfterRepair?: boolean;
  quiet?: boolean;
}

function autopilotLog(line: string): void {
  try {
    const dir = toolDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'autopilot.log'), `[${new Date().toISOString()}] ${line}\r\n`, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function say(msg: string, quiet?: boolean): void {
  autopilotLog(msg);
  if (!quiet) log(msg);
}

async function stopCoworkService(): Promise<void> {
  try {
    run('powershell', ['-NoProfile', '-Command', 'Stop-Service CoworkVMService -Force -ErrorAction SilentlyContinue'], {
      timeoutMs: 60_000,
      quiet: true,
    });
  } catch {
    /* 服务不存在或被占用 */
  }
}

async function startCoworkService(): Promise<void> {
  try {
    run('powershell', ['-NoProfile', '-Command', 'Start-Service CoworkVMService -ErrorAction SilentlyContinue'], {
      timeoutMs: 60_000,
      quiet: true,
    });
  } catch {
    /* 忽略 */
  }
}

function isPatched(st: ReturnType<typeof assessIonDist>): boolean {
  return st.parseable && (st.anchorHasLang || (st.zhInHeader && st.enUsMerged));
}

/** 注册 WindowsApps 中已暂存的新版 MSIX，并等待注册生效。 */
async function registerStaged(staged: { version: string; manifestPath: string }): Promise<void> {
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  say(`注册已暂存的新版 ${staged.version} ...`);
  run(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Add-AppxPackage -Register ${quote(staged.manifestPath)} -DisableDevelopmentMode -ForceApplicationShutdown`,
    ],
    { timeoutMs: 300_000 },
  );
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const inst = detectInstall();
    if (inst && compareVersions(inst.version, staged.version) >= 0) return;
  }
  throw new Error(`新版 ${staged.version} 注册后仍未生效`);
}

/** 跑一次 Autopilot。返回执行的动作，便于 CLI/日志使用。 */
export async function runAutopilot(opts: AutopilotOptions): Promise<string> {
  const lock = new LockFile(path.join(toolDataDir(), 'autopilot.lock'));
  if (!lock.acquire()) return 'locked';
  try {
    const inst = detectInstall();
    if (!inst) {
      say('未检测到 Claude Desktop 安装', opts.quiet);
      return 'no-install';
    }
    const state = loadState();
    const st = assessIonDist(inst, opts.lang);
    const running = listClaudePids().length > 0;
    const staged = findStagedNewerPackage(inst.version, inst.packageFamily);
    const patched = isPatched(st);

    // 1) Store 已暂存新版：应用没在跑，或旧包已经坏了 → 注册新版并重打补丁
    if (staged) {
      if (running && st.parseable) {
        say(`发现已暂存新版 ${staged.version}，但 Claude 正在运行；等退出后再处理`, opts.quiet);
        return 'pending-while-running';
      }
      if (running) await stopClaudeProcesses();
      await stopCoworkService();
      await registerStaged(staged);
      const next = detectInstall();
      if (!next) throw new Error('新版注册后检测不到安装');
      say(`新版 ${next.version} 已注册，开始备份并重打补丁 ...`, opts.quiet);
      makeBackup(next);
      await install({ lang: opts.lang, yes: true });
      await startCoworkService();
      if (opts.launchAfterRepair ?? true) launch(next);
      say(`Autopilot 完成：已升级到 ${next.version} 并汉化`, opts.quiet);
      return 'registered-and-patched';
    }

    // 2) 当前包损坏：从纯净备份恢复并重打补丁
    if (!st.parseable) {
      const backup = state?.backups?.find((b) => b.version === inst.version);
      if (!backup) throw new Error(`ion-dist.asar 损坏且没有 v${inst.version} 备份，请运行 cdzh repair`);
      say(`ion-dist.asar 损坏（${st.error}），从备份恢复 ...`, opts.quiet);
      if (running) await stopClaudeProcesses();
      restorePristine(inst, backup);
      await install({ lang: opts.lang, yes: true });
      await startCoworkService();
      if (opts.launchAfterRepair ?? true) launch(inst);
      say('Autopilot 完成：已修复并汉化', opts.quiet);
      return 'repaired';
    }

    // 3) 新版本已由 Store 注册但还没汉化（且本工具曾管理过这台机器）
    if (!patched) {
      if (!state?.patchedAt) {
        say('检测到未打补丁的 Claude，但本工具无安装记录；跳过（可运行 cdzh install）', opts.quiet);
        return 'not-managed';
      }
      say(`检测到 v${inst.version} 尚未汉化，开始重打补丁 ...`, opts.quiet);
      makeBackup(inst);
      if (running) await stopClaudeProcesses();
      await install({ lang: opts.lang, yes: true });
      await startCoworkService();
      if (running || opts.launchAfterRepair) launch(inst);
      say('Autopilot 完成：新版已汉化', opts.quiet);
      return 'patched-new';
    }

    say('Claude 状态正常，无需处理', opts.quiet);
    return 'healthy';
  } finally {
    lock.release();
  }
}

/** 注册每 2 分钟运行一次的开机守护计划任务（需要管理员）。 */
export function installAutopilotTask(projectDir: string): void {
  const wrapper = path.join(toolDataDir(), 'autopilot.vbs');
  fs.mkdirSync(toolDataDir(), { recursive: true });
  const script = path.join(projectDir, 'src', 'cli.ts');
  // wscript + Run(...,0) 让 node 控制台完全隐藏，任务本身不闪 cmd/UAC 窗口
  const command = `"${process.execPath}" "${script}" autopilot --quiet`;
  const vbsCommand = command.replace(/"/g, '""');
  fs.writeFileSync(
    wrapper,
    `Set sh = CreateObject("WScript.Shell")\r\ncode = sh.Run("${vbsCommand}", 0, True)\r\nWScript.Quit code\r\n`,
    'utf8',
  );
  const wscript = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
  run('schtasks', [
    '/Create',
    '/TN',
    TASK_NAME,
    '/TR',
    `"${wscript}" "${wrapper}"`,
    '/SC',
    'MINUTE',
    '/MO',
    '2',
    '/RL',
    'HIGHEST',
    '/F',
  ]);
  ok(`Autopilot 已注册：每 2 分钟静默巡检一次（任务名 ${TASK_NAME}）`);
  info(`日志: ${path.join(toolDataDir(), 'autopilot.log')}`);
}

export function uninstallAutopilotTask(): void {
  try {
    run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { quiet: true });
    ok('Autopilot 计划任务已注销');
  } catch {
    warn('Autopilot 计划任务不存在或注销失败');
  }
}

export function autopilotTaskStatus(): void {
  try {
    const out = run('schtasks', ['/Query', '/TN', TASK_NAME, '/V', '/FO', 'LIST'], { quiet: true });
    console.log(out.trim());
  } catch {
    warn('Autopilot 计划任务未安装。运行 cdzh autopilot install --elevate 安装');
  }
}
