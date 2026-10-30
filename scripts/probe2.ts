// 暴力枚举：找出 exe 内嵌哈希对应的头部字节范围
import fs from 'node:fs';
import { parseAsar, sha256hex } from '../src/asar.ts';

const resDir = process.argv[2] ?? 'C:/Program Files/WindowsApps/Claude_4.29.0.0_x64__pzs8sxrjxfjjc/app/resources';
const embedded: Record<string, string> = {
  'app.asar': '722aea081d2ddd5b155cb5645dba0c5642cef4711575ddb3648ea04426def648',
  'ion-dist.asar': 'e405e7e201cb7a5d215ec38e98d7e27cf61a86fcf8405126a44ac888f3a58d98',
};

for (const asarName of Object.keys(embedded)) {
  const p = `${resDir}/${asarName}`;
  const pa = parseAsar(p);
  const fd = fs.openSync(p, 'r');
  const pickle = Buffer.alloc(pa.pickleSize);
  fs.readSync(fd, pickle, 0, pa.pickleSize, 8);
  fs.closeSync(fd);
  const jsonSize = pa.pickleSize - 4 - 4; // payloadSize - strLen字段
  // 重新精确解析 payload
  const payloadSize = pickle.readUInt32LE(0);
  const strLen = pickle.readUInt32LE(4);
  const jsonWithNul = pickle.subarray(8, 8 + strLen);
  const jsonOnly = jsonWithNul.subarray(0, strLen - 1);
  void jsonSize;
  void payloadSize;

  const cands: Array<[string, Buffer]> = [
    ['[8..8+pickleSize) pickle 整段', pickle],
    ['[0..8+pickleSize) 前8+pickle', Buffer.concat([Buffer.from([4, 0, 0, 0]), pickle])],
    ['[4..8+pickleSize) 前4去掉', pickle.subarray(-4 - 0 + 0, 0).length ? pickle : pickle.subarray(0)], // placeholder
    ['jsonWithNul [16..16+strLen)', jsonWithNul],
    ['jsonOnly   [16..16+strLen-1)', jsonOnly],
    ['jsonUtf8 reserialize', Buffer.from(JSON.stringify(pa.tree), 'utf8')],
    ['pickle 头部16字节+pickle', Buffer.concat([Buffer.alloc(8), pickle])],
  ];
  console.log(`\n=== ${asarName} (嵌入值 ${embedded[asarName]!.slice(0, 16)}...) ===`);
  for (const [name, buf] of cands) {
    const h = sha256hex(buf);
    const hit = h === embedded[asarName] ? '  ✓✓✓ 命中!' : '';
    console.log(`  ${h.slice(0, 16)}... ${name}${hit}`);
  }
}
