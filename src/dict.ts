// 词典工具：覆盖率检查 / 从上游同步
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectInstall, toolDataDir } from './detect.ts';
import { getFileNode, parseAsar, readFile, readFileNode } from './asar.ts';
import { loadState } from './state.ts';
import { fileExists, info, ok, warn } from './util.ts';

const dictDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'dict');

/** 词典 vs 安装内官方词库的覆盖率（前端 / dynamic / 主进程桌面三套）。 */
export function dictCheck(lang: string): void {
  const inst = detectInstall();
  if (!inst) throw new Error('未检测到 Claude Desktop 安装');
  // 覆盖率必须对“官方纯净词库”计算；已打补丁的 en-US 已被中文覆盖，不能作为基准
  const state = loadState();
  const backup = state?.backups?.find((b) => b.version === inst.version);
  const ionPath =
    backup && fileExists(path.join(backup.dir, 'ion-dist.asar'))
      ? path.join(backup.dir, 'ion-dist.asar')
      : inst.ionDistPath;
  const appPath =
    backup && fileExists(path.join(backup.dir, 'app.asar')) ? path.join(backup.dir, 'app.asar') : inst.appAsarPath;
  const pa = parseAsar(ionPath);

  const load = (file: string): Record<string, string> => {
    const p = path.join(dictDir(), file);
    if (!fileExists(p)) throw new Error(`词典缺失: ${p}`);
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>;
  };
  const report = (label: string, enData: Buffer | undefined, dict: Record<string, string>) => {
    if (!enData) {
      info(`${label}: 当前版本无对应官方词库，跳过`);
      return;
    }
    const en = JSON.parse(enData.toString('utf8')) as Record<string, string>;
    const enKeys = new Set(Object.keys(en));
    let covered = 0;
    let empty = 0;
    for (const k of enKeys) {
      const v = dict[k];
      if (v !== undefined) {
        covered++;
        if (v === '') empty++;
      }
    }
    const stale = Object.keys(dict).filter((k) => !enKeys.has(k)).length;
    const pct = ((covered / enKeys.size) * 100).toFixed(1);
    ok(`${label}: 官方 ${enKeys.size} 键 / 词典 ${Object.keys(dict).length} 键 → 覆盖率 ${pct}%${empty ? `（空翻译 ${empty}）` : ''}，失效键 ${stale}`);
    if (parseFloat(pct) < 80) warn(`${label} 覆盖率偏低：该词典可能尚未适配当前 Claude 版本`);
  };

  let frontendEn: Buffer | undefined;
  try {
    frontendEn = readFile(pa, 'i18n/en-US.json');
  } catch {
    throw new Error('asar 内无 i18n/en-US.json（结构异常）');
  }
  report('前端词库', frontendEn, load(`frontend-${lang}.json`));
  try {
    report('dynamic 词库', readFile(pa, 'i18n/dynamic/en-US.json'), load(`dynamic-${lang}.json`));
  } catch {
    info('dynamic 词库: 当前版本无 i18n/dynamic/en-US.json，跳过');
  }
  try {
    const appPa = parseAsar(appPath);
    const appEn = getFileNode(appPa, 'resources/i18n/en-US.json');
    const officialName = lang === 'zh-CN' ? 'zh-Hans' : 'zh-Hant';
    const officialNode = getFileNode(appPa, `resources/i18n/${officialName}.json`);
    const official = officialNode
      ? (JSON.parse(readFileNode(appPa, officialNode).toString('utf8')) as Record<string, string>)
      : {};
    const extraPath = path.join(dictDir(), `desktop-extra-${lang}.json`);
    const extra = fileExists(extraPath)
      ? (JSON.parse(fs.readFileSync(extraPath, 'utf8')) as Record<string, string>)
      : {};
    const desktop = { ...official, ...load(`desktop-${lang}.json`), ...extra };
    info(`主进程词库底稿: 官方 ${officialName} ${Object.keys(official).length} 键 + 上游桌面词库 + 人工补充 ${Object.keys(extra).length} 键`);
    report('主进程词库', appEn ? readFileNode(appPa, appEn) : undefined, desktop);
  } catch {
    info('主进程词库: app.asar 读取失败，跳过');
  }
  info('未覆盖键将自动回退英文显示（不会报错）');
}

/** 从 javaht/claude-desktop-zh-cn 同步最新词典（首次自动浅克隆到工具数据目录）。 */
export function dictSync(): void {
  const repo = process.env.CDZH_UPSTREAM_DIR ?? path.join(toolDataDir(), 'upstream', 'claude-desktop-zh-cn');
  if (!fileExists(path.join(repo, '.git'))) {
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    info(`首次同步，浅克隆上游词典仓库 → ${repo} ...`);
    execFileSync('git', ['clone', '--depth', '1', 'https://github.com/javaht/claude-desktop-zh-cn.git', repo], {
      encoding: 'utf8',
      timeout: 180_000,
      windowsHide: true,
    });
  } else {
    info(`git -C ${repo} pull --ff-only ...`);
    const out = execFileSync('git', ['-C', repo, 'pull', '--ff-only'], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    info(out.trim().split(/\r?\n/)[0] ?? '');
  }
  const resDir = path.join(repo, 'resources');
  const names = fs
    .readdirSync(resDir, 'utf8')
    .filter((f) => /^(frontend|frontend-hardcoded|dynamic|statsig|desktop)-zh-(CN|TW|HK)\.json$/.test(f));
  if (names.length === 0) throw new Error('上游仓库未找到词典文件');
  let copied = 0;
  for (const n of names) {
    const src = path.join(resDir, n);
    const localName = n.replace(/^frontend-hardcoded-/, 'hardcoded-');
    const dst = path.join(dictDir(), localName);
    if (!fileExists(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst))) {
      fs.copyFileSync(src, dst);
      copied++;
    }
  }
  ok(`词典同步完成，更新 ${copied} 个文件（共 ${names.length} 个，含 gated 匹配用硬编码表）`);
  warn('词典更新后请运行 cdzh install 重打补丁使新词典生效');
}
