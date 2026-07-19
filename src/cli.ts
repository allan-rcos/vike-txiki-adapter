#!/usr/bin/env bun
// CLI do vike-txiki-adapter.
//
// Alternativa explícita ao plugin de Vite (`vike-txiki-adapter/vite`): gera o
// bundle do servidor a partir de um build do Vike, sem nenhum arquivo de
// fiação no projeto. Requer Bun para `build` e `tjs` no PATH para `start`.
//
//   vike-txiki-adapter build   # gera dist/txiki/server.mjs
//   vike-txiki-adapter start   # roda o bundle no txiki.js (tjs)
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTxikiServer, type BuildOptions } from './build.js';
import { genPo, type GenPoOptions } from './genpo.js';

declare const Bun: {
  spawn(
    cmd: string[],
    options: { stdio: [string, string, string]; env: Record<string, string | undefined> }
  ): { exited: Promise<void>; exitCode: number | null };
};

function parseArgs(argv: string[]): BuildOptions {
  const opts: BuildOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--entry') opts.entry = next()!;
    else if (a === '--client') opts.client = next()!;
    else if (a === '--out') opts.out = next()!;
    else if (a === '--port') opts.port = Number(next());
  }
  return opts;
}

async function build(opts: BuildOptions): Promise<void> {
  try {
    await buildTxikiServer(opts);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

function parseGenPoArgs(argv: string[]): GenPoOptions {
  const opts: GenPoOptions = {
    catalog: 'shared/i18n/messages/catalog.ts',
    out: 'shared/i18n/locales',
    locales: ['pt-BR', 'en', 'es'],
    sourceLocale: 'pt-BR'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--catalog') opts.catalog = next()!;
    else if (a === '--out') opts.out = next()!;
    else if (a === '--locales') opts.locales = next()!.split(',');
    else if (a === '--source') opts.sourceLocale = next()!;
    else if (a === '--silent') opts.silent = true;
  }
  return opts;
}

async function i18nPo(argv: string[]): Promise<void> {
  try {
    await genPo(parseGenPoArgs(argv));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

async function start(opts: BuildOptions): Promise<void> {
  const outAbs = resolve(process.cwd(), opts.out ?? 'dist/txiki/server.mjs');
  if (!existsSync(outAbs)) {
    console.log('[vike-txiki-adapter] Bundle ausente — buildando primeiro…');
    await build(opts);
  }
  const proc = Bun.spawn(['tjs', 'run', outAbs], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env }
  });
  await proc.exited;
  process.exit(proc.exitCode ?? 0);
}

function help(): void {
  console.log(
    `vike-txiki-adapter — serve um build do Vike no txiki.js\n\n` +
      `Uso:\n` +
      `  vike-txiki-adapter build [opções]   Gera o bundle do servidor\n` +
      `  vike-txiki-adapter start [opções]   Roda o bundle no tjs (builda se faltar)\n` +
      `  vike-txiki-adapter i18n-po [opções] Gera os catálogos .po do Lingui\n\n` +
      `Opções (build/start):\n` +
      `  --entry <path>    Entry SSR do Vike   (default: dist/server/entry.mjs)\n` +
      `  --client <path>   Dir de assets       (default: dist/client)\n` +
      `  --out <path>      Bundle de saída     (default: dist/txiki/server.mjs)\n` +
      `  --port <n>        Porta padrão        (default: 3000; PORT env tem prioridade)\n\n` +
      `Opções (i18n-po):\n` +
      `  --catalog <path>  TS com descriptors  (default: shared/i18n/messages/catalog.ts)\n` +
      `  --out <path>      Dir de saída        (default: shared/i18n/locales)\n` +
      `  --locales <list>  Locales (csv)       (default: pt-BR,en,es)\n` +
      `  --source <loc>    Locale-fonte        (default: pt-BR)\n`
  );
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'build') await build(parseArgs(rest));
else if (cmd === 'start' || cmd === 'serve') await start(parseArgs(rest));
else if (cmd === 'i18n-po') await i18nPo(rest);
else help();
