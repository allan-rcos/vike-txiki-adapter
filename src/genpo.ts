// Geração dos catálogos .po (LinguiJS) sem depender de um script no projeto.
//
// Transforma o macro `msg` (@lingui/core/macro) via Babel, coleta os
// descriptors e serializa com @lingui/format-po. O locale-fonte recebe as
// mensagens; os demais ficam vazios (a traduzir). Roda sob Bun/Node (usa
// Babel + node:fs) — NÃO é para o runtime txiki.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as babel from '@babel/core';
import linguiMacro from '@lingui/babel-plugin-lingui-macro';
import { formatter } from '@lingui/format-po';

const macroPlugin = (linguiMacro as { default?: unknown }).default ?? linguiMacro;

export interface GenPoOptions {
  /** Arquivo TS com os descriptors `msg` (ex.: `shared/i18n/messages/catalog.ts`). */
  catalog: string;
  /** Dir de saída dos catálogos (`{out}/{locale}/messages.po`). */
  out: string;
  /** Locales a gerar (ex.: `['pt-BR', 'en', 'es']`). */
  locales: string[];
  /** Locale-fonte: recebe as mensagens; os demais ficam vazios. */
  sourceLocale: string;
  /** Silencia o log por locale. Default: false. */
  silent?: boolean;
}

type Descriptor = { id: string; message?: string };

/**
 * Gera os catálogos `.po` a partir de um arquivo de descriptors `msg`.
 * O arquivo deve exportar `catalog` (Record<namespace, Record<key, descriptor>>).
 */
export async function genPo(options: GenPoOptions): Promise<void> {
  const { catalog, out, locales, sourceLocale } = options;

  const src = readFileSync(catalog, 'utf8');
  const { code } = await babel.transformAsync(src, {
    filename: 'catalog.ts',
    babelrc: false,
    configFile: false,
    presets: ['@babel/preset-typescript'],
    plugins: [macroPlugin],
  });

  // Importa o módulo transformado (macro já resolvido em descriptors).
  const tmp = join(tmpdir(), `vike-txiki-catalog-${Date.now()}.mjs`);
  writeFileSync(tmp, code ?? '');
  const mod = (await import(pathToFileURL(tmp).href)) as {
    catalog: Record<string, Record<string, Descriptor>>;
  };

  // Coleta { id: message } de todos os namespaces.
  const messages: Record<string, string> = {};
  for (const ns of Object.values(mod.catalog)) {
    for (const desc of Object.values(ns)) {
      messages[desc.id] = desc.message ?? desc.id;
    }
  }

  const po = formatter({ lineNumbers: false });
  for (const locale of locales) {
    // format-po espera um Record<id, entry>, não um array.
    const catalogObj: Record<string, unknown> = {};
    for (const [id, message] of Object.entries(messages)) {
      catalogObj[id] = {
        message,
        translation: locale === sourceLocale ? message : '',
        obsolete: false,
        flags: [],
        comments: [],
        origin: [],
      };
    }
    const dir = join(out, locale);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'messages.po'), po.serialize(catalogObj, { locale }), 'utf8');
    if (!options.silent) {
      const n = Object.keys(catalogObj).length;
      console.log(`[vike-txiki-adapter] wrote ${dir}/messages.po (${n} messages)`);
    }
  }
}
