# vike-txiki-adapter

**Serve um build de produção do [Vike](https://vike.dev) no [txiki.js](https://github.com/saghul/txiki.js) — um runtime de QuickJS + libuv que cumpre o [WinterTC](https://wintercg.org).**

Não conhece nada do seu projeto nem do seu framework de interface (Lit, Solid, React, Vue…): ele adapta `Request → renderPage(Vike) → Response` e serve os assets estáticos do build. Funciona para qualquer app Vike.

Isso é possível porque o runtime de produção do Vike (`dist/server`, condição de export `worker`) já é Web-standard — `renderPage` não lê o disco, porque o manifest está embutido em `dist/server/entry.mjs`, e não usa APIs reais do Node. O adapter só liga esse `renderPage` ao servidor HTTP nativo do txiki (`tjs.serve`).

![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=for-the-badge&logo=typescript&logoColor=white)
![Vike](https://img.shields.io/badge/Vike-CE3B3B?style=for-the-badge&logo=vite&logoColor=white)
![txiki.js](https://img.shields.io/badge/txiki.js-1F6FEB?style=for-the-badge&logo=javascript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white)
![Apache-2.0](https://img.shields.io/badge/Apache--2.0-green?style=for-the-badge)

-----

## ✨ Destaques

* **Nenhum arquivo de fiação no seu projeto.** O txiki não resolve *bare specifiers* nem `node_modules`, então é preciso empacotar num arquivo só antes de rodar. As três formas de fazer isso — plugin de Vite, CLI ou API — geram um *entry* efêmero em vez de exigir um `entry.js` versionado.
* **O bundle é portável.** Ele localiza os assets por `import.meta.url`, então não depende do caminho onde foi gerado nem de configuração no destino.
* **Um `vite build` basta.** O plugin engata no `closeBundle`, como um adapter de SvelteKit ou Nuxt: o mesmo comando que produz o build do Vike produz `dist/txiki/server.mjs`.
* **Requer Bun para empacotar, `tjs` para servir.** São papéis distintos — o Bun é ferramenta de build e não aparece em produção.

-----

## 🛠️ Instalação

| | |
|---|---|
| **[Bun](https://bun.sh)** | empacotar; o plugin usa `Bun.build` |
| **[txiki.js](https://github.com/saghul/txiki.js) (`tjs`)** | servir; precisa estar no PATH |
| **Vike** | com o build de produção já configurado |

-----

## 🚀 Uso

### Plugin de Vite — recomendado

```ts
// vite.config.ts
import { txiki } from 'vike-txiki-adapter/vite';

export default {
  plugins: [vike(), /* seu framework, ex.: vikeLit(), */ txiki()]
};
```

```json
{
  "scripts": {
    "build": "vite build",
    "start": "vike-txiki-adapter start"
  }
}
```

> Se o `vite build` rodar sob Bun (ex.: `bunx --bun vite build`), o plugin empacota no mesmo processo; sob Node, ele delega ao binário `bun` automaticamente.

`txiki(options)` aceita as mesmas opções da CLI.

### CLI

Com o build do Vike já gerado:

```bash
vike-txiki-adapter build   # gera dist/txiki/server.mjs
vike-txiki-adapter start   # roda o bundle no tjs; builda se faltar
```

| Opção          | Default                  | Descrição |
|----------------|--------------------------|-----------|
| `--entry <p>`  | `dist/server/entry.mjs`  | Entry SSR do Vike. |
| `--client <p>` | `dist/client`            | Dir de assets estáticos. |
| `--out <p>`    | `dist/txiki/server.mjs`  | Bundle de saída. |
| `--port <n>`   | `3000`                   | Porta padrão (o env `PORT` tem prioridade). |

### Programático — avançado

Para embutir no seu próprio entry ou servidor:

```js
import '../dist/server/entry.mjs';
import { renderPage } from 'vike/server';
import { serve } from 'vike-txiki-adapter';

serve({ renderPage, staticDir: new URL('../client/', import.meta.url), port: 3000 });
```

> Empacote com `NODE_ENV=production bun build … --target=node --conditions worker`.
> **Não** use `--minify`: há um bug do Bun que tenta resolver um `require` morto do `@babel/core`, puxado só pelo toolchain e nunca executado.

-----

## 🏗️ API

### `serve(options)`

Sobe `tjs.serve` e retorna o servidor (`{ port }`).

### `createFetchHandler(options) => (Request) => Promise<Response>`

Retorna só o handler `fetch` Web-standard, sem depender do `tjs.serve` — útil para testes ou para outros servidores WinterTC.

### `options`

| Campo        | Tipo                     | Default              | Descrição |
|--------------|--------------------------|----------------------|-----------|
| `renderPage` | `RenderPage`             | — (obrigatório)      | Importado de `vike/server`. |
| `staticDir`  | `URL \| string`          | `undefined`          | Base dos assets (`dist/client`). Omitido = nada estático. |
| `port`       | `number`                 | `tjs.env.PORT` ou 3000 | Porta HTTP. |
| `mimeTypes`  | `Record<string, string>` | `{}`                 | Overrides do mapa de MIME. |

### Atrás de um proxy reverso

A URL que chega ao `renderPage` tem o esquema do `X-Forwarded-Proto`, quando o cabeçalho vem; sem ele, o da conexão recebida. Isso importa porque o proxy termina o TLS: a conexão até aqui é sempre `http://`, e sem honrar o cabeçalho toda URL absoluta montada a partir dela — o `Location` de um `+redirects`, por exemplo — sairia em texto claro e jogaria o navegador para fora do TLS.

> Confiar no cabeçalho só é seguro enquanto nada alcançar este servidor senão o proxy (escutando em loopback, com a porta fechada para fora). Exposto diretamente, ele vira entrada de usuário e deixa de valer como fonte.

-----

## 🌐 i18n (LinguiJS) — opcional

O adapter também empacota utilitários de build para projetos que usam [LinguiJS](https://lingui.dev), evitando scripts soltos em `tools/`. Ambos rodam sob Bun ou Node em tempo de build (usam Babel) e **não** vão para o runtime txiki.

### `linguiMacroTs(options?)` — plugin de Vite

Transforma o macro `msg` (`@lingui/core/macro`) em arquivos `.ts` **puros** de i18n, sem JSX — que o `vite-plugin-solid` não processa. Roda `enforce: 'pre'`, em dev e no build:

```ts
import { txiki, linguiMacroTs } from 'vike-txiki-adapter/vite';

export default {
  plugins: [linguiMacroTs(), vike(), vikeSolid(), txiki(), lingui()]
};
```

`options.include` (default `/shared/i18n/`) limita quais caminhos são processados.

### `vike-txiki-adapter i18n-po` — CLI

Gera os catálogos `.po` a partir de um arquivo de descriptors `msg`:

```bash
vike-txiki-adapter i18n-po \
  --catalog shared/i18n/messages/catalog.ts \
  --out shared/i18n/locales \
  --locales pt-BR,en,es \
  --source pt-BR
```

O locale-fonte recebe as mensagens; os demais ficam vazios, a traduzir.

> Requer `@babel/core`, `@babel/preset-typescript`, `@lingui/babel-plugin-lingui-macro` e `@lingui/format-po` — dependências do pacote, resolvidas no consumidor.

-----

## ✏️ Contribuir

```bash
bun run build   # bun build → dist/{index,cli,vite,genpo}.d.ts + dist/{index,cli,vite}.mjs
```

**Exemplo de uso real:** [Tachyon PortMaster](https://github.com/allan-rcos/tachyon-portmaster-front), que serve seu SSR inteiro por este adapter.

-----

## 🔓 Licença

[![Apache-2.0](https://img.shields.io/badge/Apache--2.0-green?style=for-the-badge)](LICENSE)
