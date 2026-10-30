import { run } from '../src/util.ts';

const base = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';
console.log('base =', JSON.stringify(base));
let out: string;
try {
  out = run('reg', ['query', base, '/f', 'Claude', '/k', '/s'], { quiet: true });
} catch (e) {
  console.log('reg query 失败:', (e as Error).message.slice(0, 300));
  process.exit(1);
}
const lines = out.split(/\r?\n/);
console.log('输出总行数:', lines.length);
const hits = lines.filter((l) => l.includes('Claude_'));
console.log('Claude 键行:', JSON.stringify(hits.slice(0, 3), null, 1));
for (const line of hits.slice(0, 2)) {
  const m = line.trim().match(/^(HKEY_CURRENT_USER\\.*Claude_[\d.]+_x64__[a-z0-9]+)$/i);
  console.log('regex 匹配:', m ? m[1] : '(不匹配)');
  if (m) {
    const key = m[1];
    try {
      const v = run('reg', ['query', key, '/v', 'InstallLocation'], { quiet: true });
      console.log('InstallLocation 原始输出:', JSON.stringify(v.split(/\r?\n/).filter((l) => l.includes('InstallLocation'))[0]));
      const loc = (v.match(/InstallLocation\s+REG_SZ\s+(.*)/) ?? [])[1]?.trim() ?? '';
      console.log('解析位置:', JSON.stringify(loc));
    } catch (e) {
      console.log('InstallLocation 查询失败:', (e as Error).message.slice(0, 200));
    }
  }
}
