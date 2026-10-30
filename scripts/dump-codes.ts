import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.env.LOCALAPPDATA ?? '', 'Claude-3p', 'Crashpad', 'reports');
const names: Record<string, string> = {
  '0xc0000005': '访问违例(AV)',
  '0x80000003': 'int3 断言',
  '0xc0000409': 'fail-fast(CHECK 失败)',
  '0xe06d7363': 'C++ 异常',
  '0x40000015': '进程致命退出',
  '0x4000001f': '??',
  '0xc0000417': '参数越界',
};

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.dmp'))) {
  const p = path.join(dir, f);
  const fd = fs.openSync(p, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  if (head.toString('latin1', 0, 4) !== 'MDMP') {
    console.log(f, '不是 minidump');
    fs.closeSync(fd);
    continue;
  }
  const nStreams = head.readUInt32LE(8);
  const dirRva = head.readUInt32LE(12);
  let exc: { code: string; addr: string } | null = null;
  const entry = Buffer.alloc(12);
  for (let i = 0; i < nStreams; i++) {
    fs.readSync(fd, entry, 0, 12, dirRva + i * 12);
    const type = entry.readUInt32LE(0);
    const size = entry.readUInt32LE(4);
    const rva = entry.readUInt32LE(8);
    if (type === 6) {
      const buf = Buffer.alloc(Math.min(size, 64));
      fs.readSync(fd, buf, 0, buf.length, rva);
      exc = { code: '0x' + buf.readUInt32LE(8).toString(16), addr: '0x' + buf.readBigUInt64LE(24).toString(16) };
    }
  }
  fs.closeSync(fd);
  const st = fs.statSync(p);
  console.log(
    `${f.slice(0, 8)} ${st.mtime.toISOString().slice(11, 19)} 异常: ${exc ? `${exc.code} (${names[exc.code] ?? '未知'}) @ ${exc.addr}` : '无异常流'}`,
  );
}
