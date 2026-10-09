import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSocketDir } from "../../src/daemon/socket-dir.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "agt-sd-")));

test("a symlink in place of the socket directory is refused", () => {
  const base = tmp();
  const link = join(base, "link");
  symlinkSync(tmp(), link);
  expect(() => ensureSocketDir(link)).toThrow(`socket directory ${link} is not a directory`);
});

test("a real directory is accepted and made private", () => {
  const dir = join(tmp(), "sock");
  ensureSocketDir(dir);
  ensureSocketDir(dir);
});
