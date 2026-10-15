import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const target = resolve('.player-two/cart-demo');
if (existsSync(target)) { console.error(`Already exists: ${target}. Choose a new directory or remove the disposable copy yourself.`); process.exit(1); }
mkdirSync(target, { recursive: true });
cpSync(resolve('fixtures/cart'), target, { recursive: true });
console.log(target);
