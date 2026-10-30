// Claude 自动更新策略：注册表 + 3P configLibrary 双保险（与 javaht 方案兼容）
import fs from 'node:fs';
import path from 'node:path';
import { existingConfigLibraries } from './detect.ts';
import { run } from './util.ts';

const POLICY_KEY = 'HKCU\\SOFTWARE\\Policies\\Claude';
const VALUE_NAME = 'disableAutoUpdates';

export function setUpdatesDisabled(disabled: boolean): { registry: 'ok' | 'denied' | 'removed'; library: number } {
  // 1) 注册表策略（部分系统对 HKCU\Policies 加固，拒绝时降级为非致命）
  let registry: 'ok' | 'denied' | 'removed' = 'ok';
  try {
    if (disabled) {
      run('reg', ['add', POLICY_KEY, '/v', VALUE_NAME, '/t', 'REG_DWORD', '/d', '1', '/f']);
    } else {
      try {
        run('reg', ['delete', POLICY_KEY, '/v', VALUE_NAME, '/f'], { quiet: true });
        registry = 'removed';
      } catch {
        registry = 'removed'; // 值本来就不存在
      }
    }
  } catch {
    registry = 'denied';
  }

  // 2) 3P configLibrary 里的 applied 配置（用户文件，不受注册表加固影响）
  let library = 0;
  for (const lib of existingConfigLibraries()) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(lib, '_meta.json'), 'utf8')) as { appliedId?: string };
      const id = String(meta.appliedId ?? '').trim();
      if (!id) continue;
      const cfgPath = path.join(lib, `${id}.json`);
      if (!fs.existsSync(cfgPath)) continue;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      cfg[VALUE_NAME] = disabled;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      library++;
    } catch (e) {
      console.error(`  (configLibrary 更新失败: ${(e as Error).message})`);
    }
  }
  if (registry === 'denied' && library === 0) {
    throw new Error('无法写入更新策略：注册表被系统加固拒绝，且未找到 3P configLibrary。可忽略（影响：官方自动更新仍开启，建议用 cdzh update 手动升级）');
  }
  return { registry, library };
}

export function getUpdatePolicyState(): { registry?: string; libraries: Array<{ path: string; disableAutoUpdates: unknown }> } {
  let registry: string | undefined;
  try {
    const out = run('reg', ['query', POLICY_KEY, '/v', VALUE_NAME], { quiet: true });
    registry = (out.match(/disableAutoUpdates\s+REG_DWORD\s+(0x\d+)/) ?? [])[1];
  } catch {
    /* 未设置 */
  }
  const libraries = existingConfigLibraries().map((lib) => {
    let disableAutoUpdates: unknown = undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(lib, '_meta.json'), 'utf8')) as { appliedId?: string };
      const id = String(meta.appliedId ?? '').trim();
      const cfg = JSON.parse(fs.readFileSync(path.join(lib, `${id}.json`), 'utf8')) as Record<string, unknown>;
      disableAutoUpdates = cfg[VALUE_NAME];
    } catch {
      /* 忽略 */
    }
    return { path: lib, disableAutoUpdates };
  });
  return { registry, libraries };
}
