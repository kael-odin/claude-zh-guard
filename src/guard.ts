// 守护：监视官方更新事件与安装目录变化，自动重打补丁/自愈
import { detectInstall } from './detect.ts';
import { getUpdatePolicyState } from './policy.ts';
import { assessIonDist, install, makeBackup, restorePristine } from './patch.ts';
import { loadState } from './state.ts';
import { fail, info, listClaudePids, ok, RED, run, warn } from './util.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WatchOptions {
  lang: 'zh-CN' | 'zh-TW' | 'zh-HK';
  intervalSec?: number;
  autoFix?: boolean;
}

export async function watch(opts: WatchOptions): Promise<void> {
  const interval = (opts.intervalSec ?? 60) * 1000;
  const autoFix = opts.autoFix ?? true;
  info(`守护启动（每 ${interval / 1000}s 巡检，自动修复=${autoFix}，Ctrl+C 退出）`);

  let lastVersion: string | undefined;
  let consecutiveErrors = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const inst = detectInstall();
      if (!inst) {
        consecutiveErrors++;
        if (consecutiveErrors % 5 === 1) warn('未检测到 Claude 安装（可能正在更新部署中）...');
      } else {
        consecutiveErrors = 0;
        const state = loadState();
        const st = assessIonDist(inst, opts.lang);

        // 情形 1：文件损坏（0 字节 / 头解析失败）—— 今天那种惨案
        if (!st.parseable) {
          const backup = state?.backups?.find((b) => b.version === inst.version);
          fail(`[${now()}] ion-dist.asar 损坏: ${st.error}`);
          if (autoFix && backup) {
            info('自动修复：恢复纯净备份 ...');
            if (listClaudePids().length > 0) await stopIfRunning();
            restorePristine(inst, backup);
            await install({ lang: opts.lang, yes: true });
            ok(`[${now()}] 已自愈`);
          } else {
            warn('自动修复未启用或无备份，请手动运行: cdzh repair');
          }
        }
        // 情形 2：版本变了（官方更新已落位）
        else if (lastVersion && inst.version !== lastVersion) {
          info(`[${now()}] 检测到版本变化: ${lastVersion} → ${inst.version}`);
          if (state && !st.zhInHeader && !st.anchorHasLang) {
            if (autoFix) {
              info('自动为新版本重打补丁 ...');
              makeBackup(inst);
              await install({ lang: opts.lang, yes: true });
            } else {
              warn('新版本未打补丁（自动修复已关闭）。运行 cdzh install');
            }
          } else if (st.zhInHeader || st.anchorHasLang) {
            ok(`[${now()}] 新版本已有补丁`);
          }
        }
        // 情形 3：补丁丢失（文件正常但词典没了）
        else if (state && !st.zhInHeader && !st.anchorHasLang && state.patchedAt) {
          if (autoFix) {
            info(`[${now()}] 补丁丢失（可能被官方更新覆盖），重新安装 ...`);
            await install({ lang: opts.lang, yes: true });
          }
        }
        // 情形 4：官方更新事件提醒（仅提示）
        else {
          const pol = getUpdatePolicyState();
          if (pol.registry !== '0x1' && lastVersion && st.parseable) {
            // 静默即可；策略提醒只在启动时打一次
          }
        }
        lastVersion = inst.version;
      }
    } catch (e) {
      console.error(RED(`[${now()}] 巡检异常: ${(e as Error).message}`));
    }
    await sleep(interval);
  }
}

async function stopIfRunning(): Promise<void> {
  const { stopClaudeProcesses } = await import('./util.ts');
  await stopClaudeProcesses();
}

/** 注册/注销开机守护计划任务。 */
export function installWatchTask(action: 'install' | 'uninstall', projectDir: string): void {
  const taskName = 'claude-zh-guard-watch';
  if (action === 'uninstall') {
    try {
      run('schtasks', ['/Delete', '/TN', taskName, '/F'], { quiet: true });
      ok('守护任务已注销');
    } catch {
      warn('守护任务不存在或注销失败');
    }
    return;
  }
  const tr = `cmd /c cd /d "${projectDir}" && node src\\cli.ts watch --yes`;
  run('schtasks', ['/Create', '/TN', taskName, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F']);
  ok(`守护任务已注册（登录自启）: ${taskName}`);
}

export function now(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
