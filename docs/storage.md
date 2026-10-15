# Portas de armazenamento — como adicionar

> **Ainda não existe.** Este documento é o guia para quem quiser criar essa
> extensão: o desenho da porta, três implementações prontas e a fiação. O
> `vike-txiki-adapter` hoje expõe portas de ambiente, sistema de arquivos e
> sinais — armazenamento seria a próxima, e o caminho já está aberto.

## 🤔 O que você ganha com isso

Servindo SSR sob o [txiki.js](https://github.com/saghul/txiki.js), cedo ou tarde
aparece algo que vale a pena guardar entre requisições:

* a resposta de uma API que muda de hora em hora, e não a cada render;
* uma configuração que precisa sobreviver ao restart, sem merecer um banco;
* um valor caro de calcular no boot.

O txiki tem com que fazer as três coisas — `localStorage`, `sessionStorage` e um
SQLite embutido e público. O que falta é a fronteira: um jeito de o seu código
pedir "guarde isto" sem saber em qual dessas três o valor vai parar, e sem que
trocar de uma para outra signifique reescrever quem chama.

É isso que uma porta resolve, e é isso que este documento mostra como construir.

-----

## 🧩 O padrão que já está aqui

O adapter não deixa o [`wts-logger`](../../wts-logger) conhecer o txiki. O logger
declara **portas** — ambiente, sistema de arquivos, sinais de parada — e este
package as preenche, porque é o único do conjunto que já sabe estar sob o `tjs`.
Está em [`src/runtime.ts`](../src/runtime.ts), e vale ler antes de continuar: é o
molde.

```ts
// no package genérico: declara o que precisa e não sabe obter
export interface RuntimePorts {
  env?: (name: string) => string | undefined;
  fs?: FileSystemPort;
  signals?: SignalPort;
}
export function configureRuntime(next: RuntimePorts): void;

// no adapter: preenche com o que o runtime oferece
export function installTxikiRuntime(): void {
  configureRuntime({ env: txikiEnv(), fs: txikiFs(), signals: txikiSignals() });
}
```

Três propriedades desse molde valem copiar:

* **quem declara não escolhe.** O package genérico nunca menciona `tjs`;
* **quem preenche é a raiz de composição**, chamada uma vez, no boot;
* **chave ausente não apaga o que já estava instalado** — dá para fornecer uma
  porta numa chamada e outra depois.

Um `StoragePort` entra exatamente aí.

-----

## 🔌 A porta

```ts
/** O que a raiz de composição fornece a quem precisa guardar algo. */
export interface StoragePort {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}
```

Quatro decisões de desenho, e a primeira é a única difícil de desfazer depois:

**1. Assíncrona, mesmo que a primeira implementação seja um `Map` síncrono.**
Uma porta síncrona compila hoje sobre um `Map` e amarra para sempre: nenhum
armazenamento real — SQLite, um arquivo, um cache na rede — cabe atrás dela sem
reescrever todo chamador. O `await` que o `Map` não precisava é o preço de manter
as três opções abertas.

**2. `string` na fronteira, não `unknown`.** Quem serializa é quem chama, que
sabe o formato e sabe validar na volta. Uma porta que aceita objeto tem de
escolher um serializador por você — e nenhuma das implementações abaixo guarda
outra coisa senão texto.

**3. `ttlMs` na porta, e não em cima dela.** Validade em SQL é uma cláusula
`WHERE`; validade emulada por fora é um laço sobre todas as chaves. Deixar a
implementação decidir é o que permite a versão em disco ser eficiente.

**4. `keys(prefix)` em vez de `keys()`.** O prefixo é o que torna a varredura
barata na implementação em disco, e é o que dá namespace quando o armazenamento é
compartilhado.

E as duas portas, porque as necessidades são diferentes:

```ts
export interface StoragePorts {
  /** Volátil e rápido: cache. */
  cache?: StoragePort;
  /** Durável: configuração, estado. */
  store?: StoragePort;
}

export function configureStorage(next: StoragePorts): void;
export function runtimeCache(): StoragePort | undefined;
export function runtimeStore(): StoragePort | undefined;
```

-----

## 🛠️ Três implementações

As três abaixo foram escritas, empacotadas e rodadas sob `tjs` — a mesma bateria
de dez asserções passa nas três, o que é o ponto: **para quem chama, são
intercambiáveis.**

### Memória — para cache

Rápida e descartável. É a implementação certa para cache de requisição: quente
enquanto o processo vive, e sem nada no caminho da resposta.

```ts
export function memoryStorage(): StoragePort {
  const mapa = new Map<string, { valor: string; expiraEm?: number }>();

  return {
    async get(key) {
      const e = mapa.get(key);
      if (e === undefined) return undefined;
      if (e.expiraEm !== undefined && Date.now() > e.expiraEm) {
        mapa.delete(key);
        return undefined;
      }
      return e.valor;
    },
    async set(key, value, options) {
      mapa.set(key, {
        valor: value,
        ...(options?.ttlMs !== undefined ? { expiraEm: Date.now() + options.ttlMs } : {}),
      });
    },
    async delete(key) {
      mapa.delete(key);
    },
    async keys(prefix = '') {
      return [...mapa.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}
```

### `localStorage` — para começar sem configurar nada

O txiki publica `localStorage` e `sessionStorage` como globais. O primeiro
persiste (SQLite em `$TJS_HOME/localStorage.db`, `~/.tjs` por padrão), o segundo
vive só no processo. A mesma função serve aos dois:

```ts
export function webStorage(storage: Storage, prefix = 'app:'): StoragePort {
  return {
    async get(key) {
      const bruto = storage.getItem(prefix + key);
      if (bruto === null) return undefined;
      try {
        const { v, e } = JSON.parse(bruto) as { v: string; e?: number };
        if (e !== undefined && Date.now() > e) {
          storage.removeItem(prefix + key);
          return undefined;
        }
        return v;
      } catch {
        // O armazenamento é compartilhado: o que voltou pode não ter sido nosso.
        return undefined;
      }
    },
    async set(key, value, options) {
      const e = options?.ttlMs !== undefined ? Date.now() + options.ttlMs : undefined;
      storage.setItem(prefix + key, JSON.stringify({ v: value, e }));
    },
    async delete(key) {
      storage.removeItem(prefix + key);
    },
    async keys(p = '') {
      const achadas: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k?.startsWith(prefix + p)) achadas.push(k.slice(prefix.length));
      }
      return achadas;
    },
  };
}

configureStorage({ store: webStorage(localStorage), cache: webStorage(sessionStorage, 'c:') });
```

O `prefix` não é enfeite: `localStorage.db` fica no home do usuário e é
compartilhado por todo programa `tjs` da máquina. O prefixo é o seu namespace, e
o `catch` acima existe porque o valor que volta pode ter sido escrito por outro.

> O `localStorage` do runtime guarda **só string** — `setItem(k, {a:1})` grava
> `"[object Object]"` — e o envelope JSON acima já resolve isso para quem usa a
> porta.

### SQLite — para durar

O SQLite do txiki é público, e abrir o seu próprio banco te dá o que o
`localStorage` não expõe: os PRAGMAs, a validade como coluna e um arquivo que é
só seu.

```ts
/** A parte de `tjs:sqlite` que isto usa — tipada aqui porque o runtime não
 *  publica tipos. */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(p?: unknown[]): Record<string, unknown>[]; run(p?: unknown[]): void };
  close(): void;
}

export interface SqliteStorageOptions {
  /** Caminho do arquivo. */
  path: string;
  /** O construtor `Database` de `tjs:sqlite`, injetado — é o que mantém esta
   *  função testável fora do txiki e o módulo livre de import de runtime. */
  Database: new (path: string) => SqliteDatabase;
}

export interface SqliteStorage extends StoragePort {
  /** Apaga o que venceu. Para um timer, fora do caminho da requisição. */
  prune(): void;
  close(): void;
}

export function sqliteStorage({ path, Database }: SqliteStorageOptions): SqliteStorage {
  const db = new Database(path);
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expira INTEGER)');
  // WAL move a escrita para um log sequencial; NORMAL dispensa o fsync por
  // commit sem abrir mão de durabilidade contra queda do processo. É a
  // diferença entre uma escrita de milissegundos e uma de dezenas deles.
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');

  const selecionar = db.prepare('SELECT value FROM kv WHERE key = ? AND (expira IS NULL OR expira > ?)');
  const gravar = db.prepare('INSERT OR REPLACE INTO kv (key, value, expira) VALUES (?, ?, ?)');
  const apagar = db.prepare('DELETE FROM kv WHERE key = ?');
  const listar = db.prepare('SELECT key FROM kv WHERE key LIKE ? AND (expira IS NULL OR expira > ?)');
  const podar = db.prepare('DELETE FROM kv WHERE expira IS NOT NULL AND expira <= ?');

  return {
    async get(key) {
      const linhas = selecionar.all([key, Date.now()]);
      return linhas.length > 0 ? String(linhas[0]!.value) : undefined;
    },
    async set(key, value, options) {
      gravar.run([key, value, options?.ttlMs !== undefined ? Date.now() + options.ttlMs : null]);
    },
    async delete(key) {
      apagar.run([key]);
    },
    async keys(prefix = '') {
      return listar.all([`${prefix.replace(/[%_]/g, '')}%`, Date.now()]).map((l) => String(l.key));
    },
    /** Para um timer, fora do caminho da requisição. */
    prune() {
      podar.run([Date.now()]);
    },
    close() {
      db.close();
    },
  };
}
```

Repare no que a coluna `expira` compra: o vencido some da leitura por `WHERE`, e
a limpeza é um `DELETE` que roda quando você quiser — não um laço sobre todas as
chaves a cada consulta. O `prune` é separado de propósito: ele pertence a um
timer, não ao caminho da resposta.

### Qual usar

| | vive até | serve para | precisa de |
|---|---|---|---|
| `memoryStorage` | o processo parar | cache de requisição | nada |
| `webStorage(sessionStorage)` | o processo parar | cache, se você já usa a outra | nada |
| `webStorage(localStorage)` | você apagar | configuração pequena | `$TJS_HOME` gravável |
| `sqliteStorage` | você apagar | configuração, volume, TTL de verdade | um caminho de arquivo |

-----

## 🔩 A fiação

No molde do `installTxikiRuntime`, um `installTxikiStorage` ao lado:

```ts
// src/storage.ts
import { Database } from 'tjs:sqlite';
import { configureStorage } from 'sua-lib/storage';

export interface TxikiStorageOptions {
  /** Onde fica o banco durável. Sem isto, só o cache é instalado. */
  storePath?: string;
  /** De quanto em quanto tempo apagar o vencido. `0` desliga. */
  pruneMs?: number;
}

export function installTxikiStorage(options: TxikiStorageOptions = {}): void {
  configureStorage({ cache: memoryStorage() });

  if (options.storePath === undefined) return;

  const store = sqliteStorage({ path: options.storePath, Database });
  configureStorage({ store });

  const intervalo = options.pruneMs ?? 300_000;
  if (intervalo > 0) setInterval(() => store.prune(), intervalo);
}
```

E a chamada entra onde a de runtime já está — no topo de `createFetchHandler` e
de `serve` ([`src/index.ts`](../src/index.ts)), antes de qualquer coisa que possa
querer ler uma configuração:

```ts
installTxikiRuntime();
installTxikiStorage({ storePath: `${runtimeEnv('STATE_DIR') ?? '.'}/estado.db` });
```

O caminho sai do ambiente de propósito: é o que deixa o mesmo bundle rodar num
container com volume montado e na máquina de quem desenvolve.

-----

## 🎯 Usando: cache de requisição

Com a porta no lugar, o cache é curto — e as três linhas comentadas abaixo são as
que realmente importam:

```ts
const emVoo = new Map<string, Promise<unknown>>();

export async function buscarComCache(url: string, escopo: string, ttlMs = 30_000) {
  // 1. O escopo entra na CHAVE. Uma chave montada só a partir da URL serve a
  //    resposta de uma pessoa para outra — isto é correção, não otimização.
  const chave = `req:${escopo}|${url}`;
  const cache = runtimeCache();

  const guardado = await cache?.get(chave);
  // 2. O que volta do armazenamento é entrada externa: valide, não confie.
  if (guardado !== undefined) return JSON.parse(guardado);

  // 3. Coalescer os voos. Sem isto, N requisições simultâneas a frio viram N
  //    idas ao upstream — o cache não protege o pico que deveria proteger.
  const voando = emVoo.get(chave);
  if (voando) return voando;

  const promessa = (async () => {
    const corpo = await (await fetch(url)).json();
    await cache?.set(chave, JSON.stringify(corpo), { ttlMs });
    return corpo;
  })();

  emVoo.set(chave, promessa);
  try {
    return await promessa;
  } finally {
    emVoo.delete(chave);
  }
}
```

Num `+data` do Vike:

```ts
export async function data(pageContext: PageContext) {
  const escopo = pageContext.headers?.cookie ? 'sessão:' + hashDaSessão(pageContext) : 'anon';
  return { planos: await buscarComCache('http://api/v1/plans/public', escopo) };
}
```

**Para cache, prefira `memoryStorage`.** Um cache quer ser rápido e descartável;
persistir cada preenchimento em disco cobra I/O no caminho da resposta em troca
de uma vantagem — sobreviver ao restart — que raramente importa. Se importar (um
upstream tão caro que aquecer do zero seja inaceitável), a resposta é o
`sqliteStorage` em WAL, não o `localStorage`.

-----

## 🎯 Usando: configuração em disco

O caso oposto: escreve raro, lê no boot, precisa durar.

```ts
export async function lerConfig<T>(chave: string, padrão: T, valida: (v: unknown) => v is T): Promise<T> {
  const bruto = await runtimeStore()?.get(`config:${chave}`);
  if (bruto === undefined) return padrão;
  try {
    const v: unknown = JSON.parse(bruto);
    return valida(v) ? v : padrão;
  } catch {
    return padrão;
  }
}

export async function gravarConfig(chave: string, valor: unknown): Promise<void> {
  await runtimeStore()?.set(`config:${chave}`, JSON.stringify(valor));
}
```

O `valida` não é zelo excessivo: o valor foi escrito por uma versão anterior do
seu código, ou — se o armazenamento for o `localStorage` — por outro programa.
Um padrão de volta é sempre melhor do que um `undefined` que vaza três camadas
adiante.

> **Segredo, não.** Tanto o `localStorage` quanto o SQLite guardam texto claro
> num arquivo. Credencial continua vindo do ambiente.

-----

## ⚠️ Pontos de atenção

Curto, e nenhum deles impeditivo:

* **O caminho de escrita não é grátis.** O `localStorage` do runtime grava de
  forma síncrona e durável a cada `setItem`, e o txiki é monothread — numa mídia
  lenta isso aparece como latência nas *outras* requisições. Para escrita
  frequente, use `memoryStorage`, ou o `sqliteStorage` com o WAL acima.
* **`$TJS_HOME` precisa ser gravável.** Se não for, o primeiro acesso ao
  `localStorage` lança `TypeError: Handle object expected` — mensagem que não
  menciona storage. Um serviço rodando como usuário de sistema é o caso típico;
  aponte `TJS_HOME` para um diretório que ele possa escrever.
* **O `localStorage` carrega tudo na RAM ao abrir** e não expira nada sozinho.
  Ótimo para configuração, ruim para volume. O `sqliteStorage` não tem nenhum dos
  dois comportamentos.
* **`delete localStorage[k]` não apaga** (o proxy do runtime não tem trap de
  `delete`); use `removeItem` — que é o que a `webStorage` acima faz.

-----

## 🔬 Testando no runtime real

`tsc`, lint e teste não executam no txiki, então uma porta pode passar nos três e
falhar ao servir a primeira página. O package já tem o lugar certo para isso:
[`test/tjs/main.ts`](../test/tjs/main.ts), rodado por `bun run test:tjs`.

Acrescente as suas asserções lá, e lembre do `--external` — o `tjs:sqlite` é
resolvido pelo runtime, não pelo bundler:

```bash
bun build ./test/tjs/main.ts --outfile ./test/tjs/.bundle.mjs --target=node --external "tjs:*"
tjs run ./test/tjs/.bundle.mjs
```

Uma bateria que sirva às três implementações é o que prova que elas são
intercambiáveis — ida e volta, sobrescrita, `delete`, `keys` por prefixo,
expiração pelo TTL, unicode e um valor grande:

```ts
async function bateria(nome: string, s: StoragePort): Promise<void> {
  await s.set('a', 'valor');
  ok((await s.get('a')) === 'valor', 'ida e volta');
  await s.set('curta', 'x', { ttlMs: 300 });
  await new Promise((r) => setTimeout(r, 400));
  ok((await s.get('curta')) === undefined, 'TTL expirado some');
  // …
}
```

-----

## 📚 Fontes

* [`src/runtime.ts`](../src/runtime.ts) — o padrão de portas que este documento
  estende.
* `src/js/polyfills/storage.js` no [txiki.js](https://github.com/saghul/txiki.js)
  — o que `localStorage` e `sessionStorage` de fato são no runtime.
* [SQLite: Write-Ahead Logging](https://www.sqlite.org/wal.html) e
  [PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous).
