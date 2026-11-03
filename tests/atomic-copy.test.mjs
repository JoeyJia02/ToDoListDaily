import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicCopyFileSync } from '../scripts/atomic-copy.mjs';

test('runtime replacement uses a new inode, retains mode, and failed copy preserves original', t => {
  const dir = mkdtempSync(join(tmpdir(), 'todolist-runtime-test-')); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const source = join(dir,'source'); const target = join(dir,'node');
  writeFileSync(source,'new executable',{mode:0o755}); writeFileSync(target,'old executable',{mode:0o755});
  const original = statSync(target).ino;
  atomicCopyFileSync(source,target);
  assert.notEqual(statSync(target).ino,original); assert.equal(readFileSync(target,'utf8'),'new executable'); assert.equal(statSync(target).mode & 0o111,0o111);
  assert.throws(()=>atomicCopyFileSync(join(dir,'missing'),target));
  assert.equal(readFileSync(target,'utf8'),'new executable'); assert.deepEqual(readdirSync(dir).sort(),['node','source']);
});
