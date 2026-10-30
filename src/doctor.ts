// doctor：只读体检。repair 场景由 patch/cli 组合完成
import fs from 'node:fs';
import path from 'node:path';
import { getFileNode, listFiles, parseAsar, readEmbeddedHeaderHash, sha256hex } from './asar.ts';
import { detectInstall, existingConfigLibraries, existingConfigPaths, type ClaudeInstall } from './detect.ts';
import { findExeMarkers } from './exeinteg.ts';
import { getUpdatePolicyState } from './policy.ts';
import { backupDirFor, loadState } from './state.ts';
import { assessIonDist } from './patch.ts';
import { dirExists, fail, fileExists, fmtBytes, info, listClaudePids, ok, run, warn, YELLOW, GREEN, RED, DIM } from './util.ts';

export interface DoctorReport {
  install?: ClaudeInstall;
  lines: Array<{ level: 'ok' | 'warn' | 'fail' | 'info'; text: string }>;
  patched: boolean;
  healthy: boolean;
}

export function doctor(lang = 'zh-CN'): DoctorReport {
  const lines: DoctorReport['lines'] = [];
  const add = (level: DoctorReport['lines'][number]['level'], text: string) => {
    lines.push({ level, text });
    const tag = level === 'ok' ? GREEN('✓') : level === 'warn' ? YELLOW('!') : level === 'fail' ? RED('✗') : DIM('·');
    console.log(tag, text);
  };

  const inst = detectInstall();
  if (!inst) {
    add('fail', '未检测到 Claude Desktop 安装');
    return { lines, patched: false, healthy: false };
  }
  add('ok', `安装: ${inst.kind} v${inst.version} — ${inst.resourcesDir}`);
  add('ok', `程序: ${inst.exePath}`);

  // 进程
  const pids = listClaudePids();
  add(pids.length ? 'info' : 'ok', pids.length ? `Claude 正在运行 (${pids.length} 个进程)` : 'Claude 未在运行');

  // ion-dist 状态
  const st = assessIonDist(inst, lang);
  if (!st.parseable) {
    add('fail', `ion-dist.asar: ${st.error} (${fmtBytes(st.size)})`);
  } else {
    add('ok', `ion-dist.asar: 可解析, ${fmtBytes(st.size)}, 头部哈希 ${st.headerHash!.slice(0, 12)}...`);
    // 结构校验
    const pa = parseAsar(inst.ionDistPath);
    const hasEn = !!getFileNode(pa, 'i18n/en-US.json');
    add(hasEn ? 'ok' : 'fail', `i18n/en-US.json ${hasEn ? '存在' : '缺失（结构异常）'}`);
    const files = listFiles(pa.tree);
    let total = 0;
    let maxEnd = 0;
    for (const f of files) {
      const n = getFileNode(pa, f)!;
      total += n.size;
      maxEnd = Math.max(maxEnd, Number(n.offset) + n.size);
    }
    const closed = pa.contentBase + maxEnd === pa.fileSize;
    add(closed ? 'ok' : 'fail', `偏移闭合校验 ${closed ? '通过' : `失败(contentBase=${pa.contentBase}, maxEnd=${maxEnd}, fileSize=${pa.fileSize})`}`);
    // 补丁状态
    const zhNode = getFileNode(pa, `i18n/${lang}.json`);
    add(st.anchorHasLang ? 'ok' : st.zhInHeader ? 'warn' : 'info', `补丁状态: ${st.anchorHasLang ? `已安装 (${lang} 白名单+词典)` : st.zhInHeader ? '部分(词典在,白名单未改)' : '未安装'}`);
    if (zhNode) add('ok', `词典文件: i18n/${lang}.json (${fmtBytes(zhNode.size)})`);
    // 官方白名单锚点完整性
    if (st.anchorHits === 0 && !st.anchorHasLang) add('fail', '未找到官方语言白名单锚点（版本兼容性问题）');
  }

  // exe 内嵌哈希 vs 实际
  try {
    const markers = findExeMarkers(inst.exePath);
    const ionActual = st.parseable ? readEmbeddedHeaderHash(inst.ionDistPath) : undefined;
    const appActual = readEmbeddedHeaderHash(inst.appAsarPath);
    for (const m of markers) {
      const actual = m.asar === 'ion-dist.asar' ? ionActual : m.asar === 'app.asar' ? appActual : undefined;
      if (actual === undefined) {
        add('warn', `exe 内嵌 ${m.asar} 哈希无法比对`);
      } else if (actual === m.hash) {
        add('ok', `exe 内嵌 ${m.asar} 哈希与实际一致`);
      } else {
        const state = loadState();
        const expected = state?.ionDistPatchedHeaderHash;
        if (m.asar === 'ion-dist.asar' && expected === actual && expected === m.hash) {
          add('ok', `exe 内嵌 ion-dist 哈希 = 本工具补丁哈希 (一致)`);
        } else if (m.asar === 'ion-dist.asar' && !st.parseable) {
          add('fail', `exe 内嵌 ion-dist 哈希无法比对（asar 损坏）`);
        } else {
          add('warn', `exe 内嵌 ${m.asar} 哈希与实际不一致 (exe=${m.hash.slice(0, 10)}... 实际=${actual!.slice(0, 10)}...)`);
        }
      }
    }
    if (!markers.some((m) => m.asar === 'app.asar')) add('warn', 'exe 中未找到 app.asar 完整性条目');
  } catch (e) {
    add('fail', `exe 读取失败: ${(e as Error).message}`);
  }

  // state
  const state = loadState();
  if (state) {
    if (state.pending) add('warn', `存在未完成事务: ${state.pending}（建议运行 repair）`);
    add('info', `本工具安装记录: v${state.claudeVersion} ${state.lang} @ ${state.patchedAt || '(时间未知)'}`);
    add('info', `备份: ${state.backups.map((b) => `v${b.version}(${b.dir})`).join(', ') || '无'}`);
  } else {
    add('info', '本工具无安装记录（未打过补丁或由其他工具管理）');
  }

  // 备份有效性
  if (state) {
    for (const b of state.backups) {
      const p = path.join(b.dir, 'ion-dist.asar');
      if (!fileExists(p)) add('fail', `备份缺失: ${p}`);
      else {
        try {
          const h = sha256hex(fs.readFileSync(p));
          add(h === b.ionDistSha256 ? 'ok' : 'fail', `备份 v${b.version} 校验${h === b.ionDistSha256 ? '通过' : '失败'}`);
        } catch (e) {
          add('fail', `备份读取失败: ${(e as Error).message}`);
        }
      }
    }
  } else if (dirExists(backupDirFor('x').replace(/[/\\]x$/, ''))) {
    info('存在孤立备份目录（无状态引用）');
  }

  // config locale
  const configs = existingConfigPaths(inst.packageFamily);
  for (const c of configs) {
    try {
      const cfg = JSON.parse(fs.readFileSync(c, 'utf8')) as Record<string, unknown>;
      add('info', `config: ${c} → locale=${String(cfg['locale'])}`);
    } catch {
      add('warn', `config 无法解析: ${c}`);
    }
  }

  // 更新策略
  const pol = getUpdatePolicyState();
  add('info', `更新策略: 注册表 disableAutoUpdates=${pol.registry ?? '(未设置)'}${pol.libraries.map((l) => `, configLibrary=${String(l.disableAutoUpdates)}`).join('')}`);

  // 挂起的官方更新（近 48h AppX 部署事件）
  try {
    const out = run('wevtutil', ['qe', 'Microsoft-Windows-AppXDeploymentServer/Operational', '/q', '*[System[(EventID=603 or EventID=855)]]', '/c', '8', '/rd', 'true', '/f', 'text'], { quiet: true });
    const claudeEvents = out.split(/\r?\n\r?\n/).filter((blk) => /Claude_\d/.test(blk));
    if (claudeEvents.length > 0) {
      add('warn', `近期有 ${claudeEvents.length} 条 Claude MSIX 部署事件（若刚更新属正常）`);
    } else {
      add('ok', '近期无挂起的 Claude MSIX 部署事件');
    }
  } catch {
    add('info', '无法读取 AppX 部署事件日志（不影响使用）');
  }

  const patched = st.parseable && (st.anchorHasLang || st.zhInHeader);
  const healthy = lines.filter((l) => l.level === 'fail').length === 0;
  return { install: inst, lines, patched, healthy };
}
