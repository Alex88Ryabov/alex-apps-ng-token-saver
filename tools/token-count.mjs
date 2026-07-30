// Token counting for the section-5 benches. Claude's tokenizer is not public, so counts
// use OpenAI's o200k_base (with cl100k_base as a cross-check) via gpt-tokenizer - a stated
// proxy, not the real thing. The package never enters package.json: it is installed once
// into a cache under the OS temp dir, so the product stays dependency-free and npm test
// never touches the network.
//
//   const counters = await loadTokenizers();
//   counters.o200k('text') -> token count

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CACHE = join(tmpdir(), 'ng-token-saver-tokenizer');

export async function loadTokenizers() {
  const pkgDir = join(CACHE, 'node_modules', 'gpt-tokenizer');
  if (!existsSync(pkgDir)) {
    console.error(`one-time: installing gpt-tokenizer into ${CACHE} (benches only, not a product dependency)`);
    // Pinned exactly: the published numbers must survive a cleaned cache.
    execSync(`npm install --prefix "${CACHE}" gpt-tokenizer@3.4.0 --no-audit --no-fund --loglevel=error`, {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  const require = createRequire(join(CACHE, 'anchor.js'));
  const counterOf = (name) => {
    const module = require(`gpt-tokenizer/encoding/${name}`);
    const encode = module.encode ?? module.default?.encode;
    if (typeof encode !== 'function') {
      throw new Error(`gpt-tokenizer/encoding/${name} did not expose encode()`);
    }
    return (text) => encode(text).length;
  };
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  return { version, o200k: counterOf('o200k_base'), cl100k: counterOf('cl100k_base') };
}
