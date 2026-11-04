import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { main, validateReport } from '../src/support-report.mjs';

const report = '# Lỗi Product Review\n## Tóm tắt\nsecret-test\n## Nguyên nhân\nCó log lỗi.\n## Cách sửa cho người dùng\nKiểm tra.\n## Đánh giá đã Bỏ\nrun__item\n## Cần sửa trong app\nKhông.';
test('reject incomplete AI output and redact configured secrets', () => {
  assert.throws(() => validateReport('AI failed'), /tiêu đề/);
  assert.throws(() => validateReport('# Lỗi Product Review'), /thiếu mục/);
  assert.ok(!validateReport(report, ['secret-test']).includes('secret-test'));
});
for (const mode of ['ok', 'ai-failed', 'invalid', 'omitted-sample']) {
  test(`report lifecycle: ${mode}`, async () => {
    const base = resolve('workspace/tests'); await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'support-node-'));
    try {
      await mkdir(join(root, 'src/docs'), { recursive: true });
      await mkdir(join(root, 'workspace/rejected/run__item'), { recursive: true });
      await writeFile(join(root, 'src/docs/error-report.md'), 'Read only local logs.');
      await writeFile(join(root, 'workspace/rejected/run__item/sample.json'), '{}');
      const options = { projectRoot: root,
        generateReport: async (prompt, file) => {
          assert.match(prompt, /run__item/);
          if (mode === 'ai-failed') throw Error('AI stopped');
          await writeFile(file, mode === 'invalid' ? 'bad output' : mode === 'omitted-sample' ? report.replace('run__item', 'Không') : report);
        },
      };
      if (['ai-failed', 'invalid'].includes(mode)) await assert.rejects(main(options));
      else await main(options);
      // The report stays on this machine, in workspace/reports.
      const saved = await readdir(join(root, 'workspace/reports')).catch(() => []);
      assert.equal(saved.length, ['ai-failed', 'invalid'].includes(mode) ? 0 : 1);
      if (saved.length) assert.match(await readFile(join(root, 'workspace/reports', saved[0]), 'utf8'), /## Tóm tắt/);
      const sent = () => access(join(root, 'workspace/rejected/run__item/.sent'));
      if (mode === 'ok') await sent(); else await assert.rejects(sent());
      if (['ok', 'omitted-sample'].includes(mode)) await access(join(root, 'workspace/support-sent.txt'));
      else await assert.rejects(access(join(root, 'workspace/support-sent.txt')));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
