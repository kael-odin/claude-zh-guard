// 受控官方更新管线：恢复纯净 → 放行更新 → 等落位 → 重打补丁
import fs from 'node:fs';
import { detectAllMsixInstalls, detectInstall } from './detect.ts';
import { getUpdatePolicyState, setUpdatesDisabled } from './policy.ts';
import { install, launch, makeBackup, restorePristine, uninstall as uninstallPatch, assessIonDist } from './patch.ts';
import { loadState, saveState } from './state.ts';
import { fail, fileExists, info, listClaudePids, ok, run, startDetached, stopClaudeProcesses, warn, GREEN, DIM } from './util.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UpdateOptions {
  lang: 'zh-CN' | 'zh-TW' | 'zh-HK';
  timeoutMin?: number;
  noRepPatch?: boolean;
}

/**
 * 流程：
 *  1) 有补丁 → 恢复纯净（保证官方更新做差量部署时哈希全部对得上）
 *  2) 临时解除更新禁用策略
 *  3) 启动 Claude，等待其自动下载并部署新版本（轮询安装版本号）
 *  4) 新版本落位且 Claude 关闭后，验证纯净 → 重新打补丁 → 恢复禁用策略 → 重启
 */
export async function controlledUpdate(opts: UpdateOptions): Promise<void> {
  const timeoutMin = opts.timeoutMin ?? 20;
  const origPolicy = getUpdatePolicyState();
  const wasDisabled = origPolicy.registry === '0x1' || origPolicy.libraries.some((l) => l.disableAutoUpdates === true);

  const inst0 = detectInstall();
  if (!inst0) throw new Error('未检测到 Claude Desktop 安装');
  const state = loadState();

  // 1) 恢复纯净
  if (state && state.backups?.some((b) => b.version === inst0.version)) {
    info('步骤 1/5: 恢复纯净状态（为官方差量更新扫清哈希障碍）');
    if (listClaudePids().length > 0) await stopClaudeProcesses();
    const backup = state.backups.find((b) => b.version === inst0.version)!;
    restorePristine(inst0, backup);
    // 注意：不清 state，重打补丁还要用
  } else {
    info('步骤 1/5: 当前无补丁（或无备份），跳过恢复');
  }

  // 2) 解除策略
  info('步骤 2/5: 临时允许官方更新');
  try {
    setUpdatesDisabled(false);
  } catch (e) {
    warn(`策略解除失败（继续尝试）: ${(e as Error).message}`);
  }

  // 3) 启动并等待版本变化
  info('步骤 3/5: 启动 Claude，等待官方更新部署（最长 ' + timeoutMin + ' 分钟）...');
  const before = detectAllMsixInstalls().map((i) => i.version);
  launch(inst0);
  const deadline = Date.now() + timeoutMin * 60_000;
  let newVersion: string | undefined;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const now = detectAllMsixInstalls().map((i) => i.version);
    const added = now.find((v) => !before.includes(v));
    if (added) {
      newVersion = added;
      info(`  检测到新版本 ${added} 已部署`);
      break;
    }
    if (listClaudePids().length === 0) {
      // 应用自己退出（可能更新已暂存待注册）
      const again = detectAllMsixInstalls().map((i) => i.version);
      const added2 = again.find((v) => !before.includes(v));
      if (added2) {
        newVersion = added2;
        info(`  检测到新版本 ${added2} 已部署（应用已退出）`);
        break;
      }
      // 也许没有可用更新 —— 提示后继续等一小会
      info('  Claude 已退出且未见新版本部署（可能当前已是最新版）');
      await sleep(30_000);
      const added3 = detectAllMsixInstalls().map((i) => i.version).find((v) => !before.includes(v));
      if (added3) {
        newVersion = added3;
        break;
      }
      break;
    }
  }

  if (!newVersion) {
    warn('未见官方更新部署。恢复禁用更新策略。');
    if (wasDisabled) setUpdatesDisabled(true);
    // 若之前有补丁，恢复补丁
    const st2 = loadState();
    const inst2 = detectInstall();
    if (st2 && inst2 && st2.backups?.some((b) => b.version === inst2.version)) {
      await install({ lang: opts.lang, yes: true });
    }
    return;
  }

  // 4) 等注册收尾 → 停 Claude → 验证
  info('步骤 4/5: 等待部署注册收尾 ...');
  await sleep(20_000);
  if (listClaudePids().length > 0) await stopClaudeProcesses();
  await sleep(5_000);
  const instNew = detectInstall();
  if (!instNew || instNew.version !== newVersion) throw new Error(`新版本 ${newVersion} 检测异常`);
  const st = assessIonDist(instNew, opts.lang);
  if (!st.parseable) {
    fail(`新版本 ion-dist.asar 仍异常: ${st.error}`);
    if (wasDisabled) setUpdatesDisabled(true);
    throw new Error('官方更新后文件异常，请重启一次 Claude 让其自检，或运行 cdzh repair');
  }
  // 新版本首次备份
  makeBackup(instNew);

  // 5) 重打补丁 + 恢复策略
  if (!opts.noRepPatch) {
    info('步骤 5/5: 为新版本重打补丁 ...');
    await install({ lang: opts.lang, yes: true });
  }
  if (wasDisabled) setUpdatesDisabled(true);
  ok(`受控更新完成: v${newVersion}${opts.noRepPatch ? '' : ' + 补丁'}`);
  if (listClaudePids().length === 0) {
    const instFinal = detectInstall();
    if (instFinal) launch(instFinal);
  }
}

/** repair：损坏自愈入口。 */
export async function repair(lang: 'zh-CN' | 'zh-TW' | 'zh-HK'): Promise<void> {
  const inst = detectInstall();
  if (!inst) throw new Error('未检测到 Claude Desktop 安装');
  const state = loadState();
  const st = assessIonDist(inst, lang);

  if (st.parseable) {
    if (st.zhInHeader || st.anchorHasLang) {
      ok('asar 正常且补丁完好，无需修复');
      return;
    }
    // 未打补丁但正常 → 视为官方更新后的新版本，直接重打
    if (state) {
      info(`检测到版本已变为 v${inst.version}（记录为 v${state.claudeVersion}），重打补丁 ...`);
      await install({ lang, yes: true });
      return;
    }
    info('asar 正常且无补丁，无需修复（如需安装请运行 install）');
    return;
  }

  // 损坏路径
  fail(`ion-dist.asar 损坏: ${st.error}`);
  const backup = state?.backups?.find((b) => b.version === inst.version);
  if (backup) {
    info(`使用 v${inst.version} 备份修复并重打补丁 ...`);
    if (listClaudePids().length > 0) await stopClaudeProcesses();
    restorePristine(inst, backup);
    await install({ lang, yes: true });
    return;
  }
  throw new Error(`无 v${inst.version} 备份。请运行 cdzh update（恢复旧版→官方更新→重打补丁），或手动重装 Claude。`);
}

void fileExists;
void run;
void saveState;
void DIM;
