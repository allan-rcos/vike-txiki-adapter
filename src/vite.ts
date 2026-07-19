// Plugin de Vite do vike-txiki-adapter.
//
// Integra a geração do servidor txiki.js ao `vite build` — assim, como um
// adapter do SvelteKit/Nuxt, um único `vite build` já produz
// `dist/txiki/server.mjs`, sem passo/CLI separado.
//
//   // vite.config.ts
//   import { txiki } from 'vike-txiki-adapter/vite';
//   export default { plugins: [vike(), vikeSolid(), txiki()] };
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as babel from '@babel/core';
import linguiMacro from '@lingui/babel-plugin-lingui-macro';

import { buildTxikiServer, type BuildOptions } from './build.js';

/** Subconjunto de um Plugin do Vite (evita depender do pacote `vite`). */
interface VitePlugin {
  name: string;
  apply?: 'build' | 'serve';
  enforce?: 'pre' | 'post';
  closeBundle?: () => void | Promise<void>;
  transform?: (
    code: string,
    id: string
  ) => Promise<{ code: string; map?: unknown } | undefined> | undefined;
}

const linguiMacroPlugin = (linguiMacro as { default?: unknown }).default ?? linguiMacro;

/**
 * Plugin que transforma os macros do Lingui (`msg` de `@lingui/core/macro`) em
 * arquivos `.ts` puros de i18n — que o `vite-plugin-solid` não processa por não
 * terem JSX. Roda antes dos demais (`enforce: 'pre'`), em dev e no build.
 *
 *   // vite.config.ts
 *   import { linguiMacroTs } from 'vike-txiki-adapter/vite';
 *   export default { plugins: [linguiMacroTs(), vike(), ...] };
 *
 * @param options.include Fragmento de caminho a processar. Default: `/shared/i18n/`.
 */
export function linguiMacroTs(options: { include?: string } = {}): VitePlugin {
  const includeDir = options.include ?? '/shared/i18n/';
  return {
    name: 'vike-txiki-lingui-macro-ts',
    enforce: 'pre',
    async transform(code: string, id: string) {
      const path = id.split('\\').join('/');
      if (!path.includes(includeDir) || !path.endsWith('.ts')) return;
      if (!code.includes('@lingui/core/macro')) return;

      const result = await babel.transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        presets: ['@babel/preset-typescript'],
        plugins: [linguiMacroPlugin],
        sourceMaps: true,
      });
      return result ? { code: result.code as string, map: result.map } : undefined;
    }
  };
}

// O bundle usa `Bun.build`. Quando o `vite build` roda sob Node (o bin do Vite
// tem shebang node), delegamos ao binário `bun` executando a CLI do adapter.
function buildViaBunCli(cwd: string, options: BuildOptions): Promise<void> {
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const args = [cli, 'build'];
  if (options.entry) args.push('--entry', options.entry);
  if (options.client) args.push('--client', options.client);
  if (options.out) args.push('--out', options.out);
  if (options.port != null) args.push('--port', String(options.port));
  return new Promise((res, rej) => {
    const proc = spawn('bun', args, { stdio: 'inherit', cwd });
    proc.on('error', rej);
    proc.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`[vike-txiki-adapter] bun saiu com código ${code}`))
    );
  });
}

/**
 * Plugin que empacota o servidor txiki.js ao final do `vite build`.
 *
 * O Vike faz dois builds (client e server); o plugin dispara no `closeBundle`
 * de cada um mas só age quando o entry SSR (`dist/server/entry.mjs`) já existe
 * — ou seja, após o build do servidor. Requer Bun (direto ou no PATH).
 */
export function txiki(options: BuildOptions = {}): VitePlugin {
  let done = false;
  return {
    name: 'vike-txiki-adapter',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (done) return;
      const cwd = options.cwd ?? process.cwd();
      const entryAbs = resolve(cwd, options.entry ?? 'dist/server/entry.mjs');
      // Ainda não é o build do servidor (ex.: terminou o do client).
      if (!existsSync(entryAbs)) return;
      done = true;

      if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
        await buildTxikiServer(options); // já sob Bun: bundle no mesmo processo
      } else {
        await buildViaBunCli(cwd, options); // sob Node: delega ao `bun`
      }
    }
  };
}

export default txiki;
