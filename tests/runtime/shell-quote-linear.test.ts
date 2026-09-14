import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

describe("GHSA-395f-4hp3-45gv: linear shell token finalization", () => {
  for (const modulePath of [
    "../../runtime/vendor/shell-quote/parse.ts",
    "../../dist/vendor/shell-quote/parse.js",
    "../../plugins/kimi-codex/dist/vendor/shell-quote/parse.js",
  ]) {
    test(modulePath, () => {
      const script = `
        import assert from 'node:assert/strict';
        import { parse } from ${JSON.stringify(new URL(modulePath, import.meta.url).href)};
        const count = 128_000;
        for (const env of [undefined, () => 'resolved']) {
          const result = parse('x '.repeat(count), env);
          assert.equal(result.length, count);
          assert.ok(result.every(value => value === 'x'));
        }
        assert.deepEqual(parse('echo hi#tail ignored'), ['echo', 'hi', { comment: 'tail ignored' }]);
        assert.deepEqual(parse('echo *.ts && cat'), ['echo', { op: 'glob', pattern: '*.ts' }, { op: '&&' }, 'cat']);
        assert.deepEqual(parse('pre$X/post', () => ({ op: '|' })), ['pre', { op: '|' }, '/post']);
        assert.deepEqual(parse('$X $Y', () => ({ op: '|' })), [{ op: '|' }, { op: '|' }]);
      `;
      const result = spawnSync("node", ["--import", "tsx", "--input-type=module", "--eval", script], {
        encoding: "utf8",
        timeout: 4_000,
        killSignal: "SIGKILL",
      });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }, 5_000);
  }
});
