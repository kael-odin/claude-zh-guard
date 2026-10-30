// 安装检测：MSIX 商店版 / 非打包版，配置文件路径，进程状态
import fs from 'node:fs';
import path from 'node:path';
import { dirExists, fileExists, run } from './util.ts';

export interface ClaudeInstall {
  kind: 'msix' | 'unpackaged';
  installRoot: string;
  appDir: string;
  resourcesDir: string;
  exePath: string;
  ionDistPath: string;
  appAsarPath: string;
  version: string;
  packageFamily?: string;
  aumid?: string;
}

/** 从注册表枚举 MSIX 包（比 Get-AppxPackage 快得多）。 */
function findMsixViaRegistry(): Array<{ key: string; installLocation: string; version: string; family: string }> {
  const base =
    'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';
  let out: string;
  try {
    out = run('reg', ['query', base, '/f', 'Claude', '/k', '/s'], { quiet: true });
  } catch {
    return [];
  }
  const results: Array<{ key: string; installLocation: string; version: string; family: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(HKEY_CURRENT_USER\\.*Claude_[\d.]+_x64__[a-z0-9]+)$/i);
    if (!m) continue;
    const key = m[1]!;
    const pkgName = key.split('\\').pop()!;
    const vm = pkgName.match(/^Claude_([\d.]+)_x64__([a-z0-9]+)$/i);
    if (!vm) continue;
    let loc = '';
    try {
      const v = run('reg', ['query', key], { quiet: true });
      loc =
        (v.match(/PackageRootFolder\s+REG_SZ\s+(.*)/) ?? [])[1]?.trim() ??
        (v.match(/InstallLocation\s+REG_SZ\s+(.*)/) ?? [])[1]?.trim() ??
        '';
    } catch {
      /* 值读取失败，走兜底路径 */
    }
    if (!loc) loc = `C:\\Program Files\\WindowsApps\\${pkgName}`;
    if (loc && dirExists(loc)) {
      results.push({ key, installLocation: loc, version: vm[1]!, family: `Claude_${vm[2]}` });
    }
  }
  return results;
}

export function detectInstall(): ClaudeInstall {
  const candidates: ClaudeInstall[] = [];

  for (const pkg of findMsixViaRegistry()) {
    const appDir = path.join(pkg.installLocation, 'app');
    const resourcesDir = path.join(appDir, 'resources');
    if (!fileExists(path.join(resourcesDir, 'ion-dist.asar'))) continue;
    candidates.push({
      kind: 'msix',
      installRoot: pkg.installLocation,
      appDir,
      resourcesDir,
      exePath: path.join(appDir, 'Claude.exe'),
      ionDistPath: path.join(resourcesDir, 'ion-dist.asar'),
      appAsarPath: path.join(resourcesDir, 'app.asar'),
      version: pkg.version,
      packageFamily: pkg.family,
      aumid: `${pkg.family}!Claude`,
    });
  }

  // 非打包版（Squirrel/NSIS 装到 %LocalAppData%\AnthropicClaude）
  const local = process.env.LOCALAPPDATA ?? '';
  if (local) {
    const base = path.join(local, 'AnthropicClaude');
    if (dirExists(base)) {
      for (const name of fs.readdirSync(base)) {
        const vm = name.match(/^app-([\d.]+)$/);
        if (!vm) continue;
        const installRoot = path.join(base, name);
        const resourcesDir = path.join(installRoot, 'resources');
        if (!fileExists(path.join(resourcesDir, 'ion-dist.asar'))) continue;
        candidates.push({
          kind: 'unpackaged',
          installRoot,
          appDir: installRoot,
          resourcesDir,
          exePath: path.join(installRoot, 'Claude.exe'),
          ionDistPath: path.join(resourcesDir, 'ion-dist.asar'),
          appAsarPath: path.join(resourcesDir, 'app.asar'),
          version: vm[1]!,
        });
      }
    }
  }

  if (candidates.length === 0) return undefined as unknown as ClaudeInstall;
  // 取版本最高者
  candidates.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));
  return candidates[0]!;
}

/** 找出全部 MSIX 安装（含旧版本残留），供 doctor/update 使用。 */
export function detectAllMsixInstalls(): ClaudeInstall[] {
  const out: ClaudeInstall[] = [];
  for (const pkg of findMsixViaRegistry()) {
    const appDir = path.join(pkg.installLocation, 'app');
    const resourcesDir = path.join(appDir, 'resources');
    if (!fileExists(path.join(resourcesDir, 'ion-dist.asar'))) continue;
    out.push({
      kind: 'msix',
      installRoot: pkg.installLocation,
      appDir,
      resourcesDir,
      exePath: path.join(appDir, 'Claude.exe'),
      ionDistPath: path.join(resourcesDir, 'ion-dist.asar'),
      appAsarPath: path.join(resourcesDir, 'app.asar'),
      version: pkg.version,
      packageFamily: pkg.family,
      aumid: `${pkg.family}!Claude`,
    });
  }
  out.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));
  return out;
}

/** 可能存放 locale/disableAutoUpdates 配置的 config.json 路径（仅返回已存在的）。 */
export function existingConfigPaths(family?: string): string[] {
  const appdata = process.env.APPDATA ?? '';
  const local = process.env.LOCALAPPDATA ?? '';
  const list = [
    appdata && path.join(appdata, 'Claude', 'config.json'),
    appdata && path.join(appdata, 'Claude-3p', 'config.json'),
    local && path.join(local, 'Claude-3p', 'config.json'),
    family && local && path.join(local, 'Packages', family, 'LocalCache', 'Roaming', 'Claude', 'config.json'),
    family && local && path.join(local, 'Packages', family, 'LocalCache', 'Roaming', 'Claude-3p', 'config.json'),
  ].filter((p): p is string => !!p);
  return list.filter((p) => fileExists(p));
}

/** 3P configLibrary 路径（含 _meta.json 的目录），用于 disableAutoUpdates。 */
export function existingConfigLibraries(family?: string): string[] {
  const local = process.env.LOCALAPPDATA ?? '';
  const list = [
    local && path.join(local, 'Claude-3p', 'configLibrary'),
    family && local && path.join(local, 'Packages', family, 'LocalCache', 'Roaming', 'Claude-3p', 'configLibrary'),
  ].filter((p): p is string => !!p);
  return list.filter((p) => fileExists(path.join(p, '_meta.json')));
}

/** 工具自身的数据目录（状态/备份）。 */
export function toolDataDir(): string {
  const local = process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? '.';
  return path.join(local, 'claude-zh-guard');
}
