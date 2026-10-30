// 找出 e405e7e2 对应的哈希公式：对纯净备份与当前补丁文件算全部候选范围
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const backupAsar = path.join(process.env.LOCALAPPDATA ?? '', 'claude-zh-guard', 'backups', '4.29.0.0', 'ion-dist.asar');
const liveAsar = 'C:/Program Files/WindowsApps/Claude_4.29.0.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist.asar';

const targets: Array<[string, string | undefined]> = [
  ['纯净备份(对应 exe=e405e7e2...)', 'e405e7e201cb7a5d215ec38e98d7e27cf61a86fcf8405126a44ac888f3a58d98'],
  ['当前补丁文件(对应 exe=c963229c...我写的)', undefined],
];

for (const [label, expected] of targets as Array<[string, string | undefined]>) {
  const p = expected ? backupAsar : liveAsar;
  const buf = fs.readFileSync(p);
  const pickleSize = buf.readUInt32LE(4);
  const payloadSize = buf.readUInt32LE(8);
  const strLen = buf.readUInt32LE(12);
  const contentBase = 8 + pickleSize;
  console.log(`\n=== ${label} ===`);
  console.log(`  pickleSize=${pickleSize} payloadSize=${payloadSize} strLen=${strLen} contentBase=${contentBase} fileSize=${buf.length}`);
  const cands: Array<[string, Buffer]> = [
    ['[16..16+strLen) 纯JSON', buf.subarray(16, 16 + strLen)],
    ['[16..16+strLen+1) JSON+NUL', buf.subarray(16, 16 + strLen + 1)],
    ['[16..contentBase) JSON+尾部填充', buf.subarray(16, contentBase)],
    ['[8..contentBase) 整个pickle', buf.subarray(8, contentBase)],
    ['[0..contentBase) 含前缀', buf.subarray(0, contentBase)],
    ['[16..16+strLen-1) JSON去尾', buf.subarray(16, 16 + strLen - 1)],
    ['整文件', buf],
  ];
  for (const [name, b] of cands) {
    const h = sha(b);
    const hit = expected && h === expected ? '  ✓✓✓ 命中 e405e7e2!' : '';
    console.log(`  ${h.slice(0, 14)}... ${name}${hit}`);
  }
  if (!expected) {
    console.log(`  （我写入 exe 的值 = c963229c121d...，上面第一项应与之相同）`);
  }
}
