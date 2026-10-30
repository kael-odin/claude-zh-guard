// 补丁核心：install / uninstall / restore，事务化，失败即回滚
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getFileNode,
  parseAsar,
  readFileNode,
  readEmbeddedHeaderHash,
  sha256hex,
  surgicalRebuild,
  type Upsert,
} from './asar.ts';
import { detectInstall, existingConfigPaths, type ClaudeInstall } from './detect.ts';
import { findExeMarkers, writeExeMarkerHash } from './exeinteg.ts';
import { backupDirFor, clearState, loadState, saveState, type BackupInfo, type GuardState } from './state.ts';
import { fail, fileExists, info, listClaudePids, log, ok, run, startDetached, stopClaudeProcesses, warn } from './util.ts';

export const LANGS = ['zh-CN', 'zh-TW', 'zh-HK'] as const;
export type Lang = (typeof LANGS)[number];

const TOOL_VERSION = '0.1.0';

const ANCHOR = '"en-US","de-DE","fr-FR","ko-KR","ja-JP"';
const anchorWithLang = (lang: string) => `"en-US","de-DE","fr-FR","ko-KR","ja-JP","${lang}"`;

const dictDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'dict');

function loadDict(name: string): Buffer {
  const p = path.join(dictDir(), name);
  if (!fileExists(p)) throw new Error(`词典缺失: ${p}`);
  return fs.readFileSync(p);
}

/** 语言白名单锚点替换；返回 [新内容, 命中数]。0 命中且未打过补丁时调用方应中止。 */
export function patchLanguageWhitelist(js: Buffer, lang: string): [Buffer, number] {
  const text = js.toString('utf8');
  if (text.includes(anchorWithLang(lang))) return [js, 0]; // 幂等
  let count = 0;
  let idx = 0;
  let out = text;
  while ((idx = out.indexOf(ANCHOR, idx)) !== -1) {
    out = out.slice(0, idx) + anchorWithLang(lang) + out.slice(idx + ANCHOR.length);
    idx += anchorWithLang(lang).length;
    count++;
  }
  return [Buffer.from(out, 'utf8'), count];
}

export interface IonDistStatus {
  parseable: boolean;
  error?: string;
  size: number;
  zhInHeader: boolean;
  anchorHasLang: boolean;
  anchorHits: number;
  headerHash?: string;
  fileSha256?: string;
}

/** 评估 ion-dist.asar 当前状态（找到锚点文件后即早停，不必扫全部 js）。 */
export function assessIonDist(install: ClaudeInstall, lang: string): IonDistStatus {
  const st: IonDistStatus = { parseable: false, size: 0, zhInHeader: false, anchorHasLang: false, anchorHits: 0 };
  if (!fileExists(install.ionDistPath)) {
    st.error = '文件不存在';
    return st;
  }
  st.size = fs.statSync(install.ionDistPath).size;
  if (st.size === 0) {
    st.error = '文件为 0 字节（典型的官方更新损坏）';
    return st;
  }
  let pa;
  try {
    pa = parseAsar(install.ionDistPath);
  } catch (e) {
    st.error = `头部解析失败: ${(e as Error).message}`;
    return st;
  }
  st.parseable = true;
  st.zhInHeader = !!getFileNode(pa, `i18n/${lang}.json`);
  try {
    st.headerHash = readEmbeddedHeaderHash(install.ionDistPath);
    st.fileSha256 = sha256hex(fs.readFileSync(install.ionDistPath));
  } catch {
    /* 忽略 */
  }
  const files = listAllFiles(pa.tree).filter((f) => f.startsWith('assets/') && f.endsWith('.js'));
  for (const f of files) {
    const node = getFileNode(pa, f);
    if (!node || node.size > 25 * 1024 * 1024) continue;
    const text = readFileNode(pa, node).toString('utf8');
    st.anchorHasLang = st.anchorHasLang || text.includes(anchorWithLang(lang));
    st.anchorHits += countOccurrences(text, ANCHOR);
    if (st.anchorHits > 0 && st.anchorHasLang) break;
  }
  return st;
}

function listAllFiles(tree: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (files: Record<string, unknown>, prefix: string) => {
    for (const [name, child] of Object.entries(files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      const c = child as { files?: Record<string, unknown> };
      if (c && typeof c.files === 'object') walk(c.files, p);
      else out.push(p);
    }
  };
  walk(tree, '');
  return out;
}

function countOccurrences(text: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

function sha256File(p: string): string {
  return sha256hex(fs.readFileSync(p));
}

/** 确保目录可写（必要时 ACL 补救）。 */
function ensureWritable(dir: string): void {
  try {
    const probe = path.join(dir, `.cdzh-probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
  } catch {
    const user = process.env.USERNAME ?? 'Users';
    log(`目录不可写，尝试 icacls 授权 (${user}) ...`);
    try {
      run('icacls', [dir, '/grant', `${user}:(OI)(CI)F`]);
    } catch {
      throw new Error('无写入权限且授权失败：请以管理员身份运行（或 cdzh --elevate install）');
    }
  }
}

/** 备份 ion-dist.asar 与 Claude.exe 到包外目录（按版本，幂等）。 */
export function makeBackup(install: ClaudeInstall, reuseExisting = true): BackupInfo {
  const dir = backupDirFor(install.version);
  if (
    reuseExisting &&
    fileExists(path.join(dir, 'ion-dist.asar')) &&
    fileExists(path.join(dir, 'Claude.exe')) &&
    fileExists(path.join(dir, 'backup.json'))
  ) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8')) as BackupInfo;
    ok(`复用已有纯净备份: ${dir}`);
    return meta;
  }
  fs.mkdirSync(dir, { recursive: true });
  info(`备份 ion-dist.asar 与 Claude.exe → ${dir} ...`);
  fs.copyFileSync(install.ionDistPath, path.join(dir, 'ion-dist.asar'));
  fs.copyFileSync(install.exePath, path.join(dir, 'Claude.exe'));
  const meta: BackupInfo = {
    version: install.version,
    dir,
    ionDistSha256: sha256File(path.join(dir, 'ion-dist.asar')),
    ionDistHeaderHash: readEmbeddedHeaderHash(path.join(dir, 'ion-dist.asar')),
    exeSha256: sha256File(path.join(dir, 'Claude.exe')),
    exeMarkers: findExeMarkers(path.join(dir, 'Claude.exe')).map((m) => ({ asar: m.asar, hash: m.hash })),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify(meta, null, 2), 'utf8');
  ok('备份完成');
  return meta;
}

/** 从备份恢复 ion-dist.asar 并还原 exe 内嵌哈希（哈希全部从磁盘字节重算）。 */
export function restorePristine(install: ClaudeInstall, backup: BackupInfo): void {
  if (sha256File(path.join(backup.dir, 'ion-dist.asar')) !== backup.ionDistSha256) {
    throw new Error('备份文件校验失败，拒绝恢复');
  }
  info('恢复 ion-dist.asar ← 纯净备份 ...');
  fs.copyFileSync(path.join(backup.dir, 'ion-dist.asar'), install.ionDistPath);
  info('还原 exe 内嵌哈希 ...');
  const ionHash = readEmbeddedHeaderHash(install.ionDistPath);
  const appHash = fileExists(install.appAsarPath) ? readEmbeddedHeaderHash(install.appAsarPath) : undefined;
  for (const m of backup.exeMarkers) {
    const hash = m.asar === 'ion-dist.asar' ? ionHash : m.asar === 'app.asar' ? (appHash ?? m.hash) : m.hash;
    if (writeExeMarkerHash(install.exePath, m.asar, hash)) info(`  已还原 ${m.asar} → ${hash.slice(0, 12)}...`);
  }
  ok('纯净状态恢复完成');
}

export interface InstallOptions {
  lang: Lang;
  yes?: boolean;
  launch?: boolean;
  keepUpdatesOn?: boolean;
}

/** 安装/重装补丁（幂等：已装则先恢复纯净再重打）。 */
export async function install(opts: InstallOptions): Promise<void> {
  const inst = detectInstall();
  if (!inst) throw new Error('未检测到 Claude Desktop 安装');
  const lang = opts.lang;
  log(`目标: ${inst.kind} v${inst.version}  ${inst.resourcesDir}`);
  log(`语言: ${lang}`);

  const state = loadState();
  ensureWritable(inst.resourcesDir);
  ensureWritable(inst.appDir);

  // 外来补丁残留（javaht 的桌面词典文件）
  const foreignDict = path.join(inst.resourcesDir, 'zh-CN.json');
  if (fileExists(foreignDict)) {
    const archiveDir = backupDirFor('foreign');
    fs.mkdirSync(archiveDir, { recursive: true });
    const dest = path.join(archiveDir, `zh-CN.json.${Date.now()}`);
    fs.renameSync(foreignDict, dest);
    warn(`检测到 javaht 汉化残留 (resources/zh-CN.json)，已归档: ${dest}`);
  }

  // ion-dist 健康检查（0 字节 / 头损坏 → 自动修复）
  let status = assessIonDist(inst, lang);
  if (!status.parseable) {
    fail(`ion-dist.asar 异常: ${status.error}`);
    const backup = state?.backups?.find((b) => b.version === inst.version);
    if (backup) {
      info(`发现 v${inst.version} 纯净备份，执行自动修复 ...`);
      restorePristine(inst, backup);
      status = assessIonDist(inst, lang);
    } else {
      throw new Error('无匹配版本备份可修复。请运行 cdzh update 走受控更新，或重装 Claude。');
    }
  }

  // 进程检查
  if (listClaudePids().length > 0) {
    if (opts.yes) {
      await stopClaudeProcesses();
      ok('已关闭 Claude 相关进程');
    } else {
      throw new Error('Claude 正在运行，请先退出，或加 --yes 自动关闭');
    }
  }

  // 既有补丁 → 先恢复纯净
  if (status.zhInHeader || status.anchorHasLang) {
    const backup = state?.backups?.find((b) => b.version === inst.version);
    if (backup) {
      info('检测到既有补丁，先恢复纯净状态 ...');
      restorePristine(inst, backup);
      status = assessIonDist(inst, lang);
    } else {
      throw new Error('检测到既有补丁但无本工具备份（可能是 javaht 补丁）。请先用原工具卸载后再运行本工具。');
    }
  }

  // 备份（此时应为纯净态）
  const backup = makeBackup(inst);

  // 构造 upserts：先全部准备并通过锚点检查，再动包（未动包前的失败 = 零影响）
  const upserts: Upsert[] = [
    { vpath: `i18n/${lang}.json`, data: loadDict(`frontend-${lang}.json`) },
    { vpath: `i18n/dynamic/${lang}.json`, data: loadDict(`dynamic-${lang}.json`) },
    { vpath: `i18n/statsig/${lang}.json`, data: loadDict(`statsig-${lang}.json`) },
  ];
  let anchorCount = 0;
  {
    const pa = parseAsar(inst.ionDistPath);
    const files = listAllFiles(pa.tree).filter((f) => f.startsWith('assets/') && f.endsWith('.js'));
    for (const f of files) {
      const node = getFileNode(pa, f);
      if (!node || node.size > 25 * 1024 * 1024) continue;
      const [patched, hits] = patchLanguageWhitelist(readFileNode(pa, node), lang);
      if (hits > 0) {
        upserts.push({ vpath: f, data: patched });
        anchorCount += hits;
      }
    }
  }
  if (anchorCount === 0) {
    throw new Error('未找到语言白名单锚点——此版本界面结构可能已变化，补丁中止（未做任何修改）。请反馈此版本号。');
  }
  info(`白名单锚点命中 ${anchorCount} 处，词典 3 个文件就绪，开始重建 ion-dist.asar ...`);

  // 事务：pending 标记 → 重建 → exe 哈希 → 收尾
  const base: GuardState =
    state ?? {
      toolVersion: TOOL_VERSION,
      kind: inst.kind,
      installRoot: inst.installRoot,
      resourcesDir: inst.resourcesDir,
      exePath: inst.exePath,
      claudeVersion: inst.version,
      lang,
      patchedAt: '',
      ionDistPatchedHeaderHash: '',
      ionDistPatchedSha256: '',
      appAsarHeaderHash: '',
      backups: [],
    };
  const draft: GuardState = {
    ...base,
    pending: 'ion-dist-rebuild',
    toolVersion: TOOL_VERSION,
    lang,
    claudeVersion: inst.version,
    resourcesDir: inst.resourcesDir,
    exePath: inst.exePath,
    installRoot: inst.installRoot,
    kind: inst.kind,
    packageFamily: inst.packageFamily,
    backups: mergeBackups(base.backups, backup),
  };
  saveState(draft);

  try {
    // integrity 块必须补全：Claude 4.29+ 的运行时校验依赖每个文件带 integrity（javaht 形态已验证可启动）
    const result = surgicalRebuild(inst.ionDistPath, inst.ionDistPath, upserts, { integrity: 'always' });
    info(`重建完成: 文件 ${(result.fileSize / 1048576).toFixed(1)}MB（原 ${(status.size / 1048576).toFixed(1)}MB），新头部哈希 ${result.headerHash.slice(0, 12)}...`);

    draft.pending = 'exe-hash';
    draft.ionDistPatchedHeaderHash = result.headerHash;
    draft.ionDistPatchedSha256 = sha256File(inst.ionDistPath);
    draft.appAsarHeaderHash = readEmbeddedHeaderHash(inst.appAsarPath);
    saveState(draft);

    const changedIon = writeExeMarkerHash(inst.exePath, 'ion-dist.asar', result.headerHash);
    const appMarker = findExeMarkers(inst.exePath).find((m) => m.asar === 'app.asar');
    let changedApp = false;
    if (appMarker && appMarker.hash !== draft.appAsarHeaderHash) {
      writeExeMarkerHash(inst.exePath, 'app.asar', draft.appAsarHeaderHash);
      changedApp = true;
    }
    info(`exe 哈希同步: ion-dist ${changedIon ? '已改写' : '一致'}, app.asar ${changedApp ? '已改写' : '一致'}`);

    // 桌面外壳词典（Electron 菜单用）
    fs.copyFileSync(path.join(dictDir(), `desktop-${lang}.json`), path.join(inst.resourcesDir, `${lang}.json`));

    // config locale
    const configs = existingConfigPaths(inst.packageFamily);
    for (const cfgPath of configs) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
        cfg['locale'] = lang;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4), 'utf8');
        info(`locale → ${lang}: ${cfgPath}`);
      } catch (e) {
        warn(`config 写入失败 ${cfgPath}: ${(e as Error).message}`);
      }
    }
    if (configs.length === 0) warn('未找到任何 config.json，界面语言请稍后在应用设置里确认');
  } catch (e) {
    // 回滚
    fail(`安装失败: ${(e as Error).message}，正在回滚 ...`);
    try {
      restorePristine(inst, backup);
    } catch (e2) {
      fail(`回滚也失败: ${(e2 as Error).message}。请手动从 ${backup.dir} 恢复。`);
      throw e2;
    }
    throw e;
  }

  delete draft.pending;
  draft.patchedAt = new Date().toISOString();
  saveState(draft);
  ok(`补丁安装完成 (v${inst.version}, ${lang})`);

  if (opts.launch) launch(inst);
}

function mergeBackups(existing: BackupInfo[] | undefined, add: BackupInfo): BackupInfo[] {
  const list = [...(existing ?? [])];
  const i = list.findIndex((b) => b.version === add.version);
  if (i >= 0) list[i] = add;
  else list.push(add);
  return list;
}

/** 卸载：恢复官方纯净状态。 */
export function uninstall(): void {
  const inst = detectInstall();
  if (!inst) throw new Error('未检测到 Claude Desktop 安装');
  const state = loadState();
  if (!state) {
    warn('本工具无安装记录。若装过 javaht 汉化，请用其自带卸载流程。');
    return;
  }
  if (state.pending) warn(`检测到未完成的事务(${state.pending})，将直接恢复纯净状态`);
  const backup = state.backups?.find((b) => b.version === inst.version);
  if (!backup) throw new Error(`没有 v${inst.version} 的备份，无法安全卸载`);
  restorePristine(inst, backup);

  const ours = path.join(inst.resourcesDir, `${state.lang}.json`);
  if (fileExists(ours)) fs.unlinkSync(ours);

  for (const cfgPath of existingConfigPaths(inst.packageFamily)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      cfg['locale'] = 'en-US';
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4), 'utf8');
    } catch {
      /* 忽略 */
    }
  }
  clearState();
  ok('已卸载补丁，恢复官方纯净状态');
}

/** MSIX 激活启动 Claude。 */
export function launch(inst: ClaudeInstall): void {
  if (inst.kind === 'msix' && inst.aumid) {
    // explorer.exe 直启 shell: 会报"拒绝访问"，用 PowerShell Start-Process 已验证可靠
    startDetached('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process "shell:AppsFolder\\${inst.aumid}"`]);
    ok(`已通过 MSIX 激活启动 (${inst.aumid})`);
  } else {
    startDetached(inst.exePath, []);
    ok('已启动 Claude');
  }
}
