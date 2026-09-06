// vike-txiki-adapter
// ===================
// Adapter agnóstico que serve QUALQUER build de produção do Vike no
// runtime txiki.js (`tjs`), usando apenas APIs Web-standard (WinterTC).
//
// Não conhece nada do projeto: recebe o `renderPage` do Vike (já com o
// global context registrado pelo `dist/server/entry.mjs` do projeto) e,
// opcionalmente, o diretório de assets estáticos. Assim funciona para
// qualquer app Vike, independente de framework de UI (Solid, React, etc).
//
// O adapter também é o LUGAR ÚNICO onde o logger do servidor nasce. Ele monta
// um logger por requisição e o entrega no `pageContextInit`, de onde a
// aplicação o recolhe — sem nunca importar este package. É o que permite que
// uma falha ANTES do código da aplicação (um asset que não abre, um render que
// explode) apareça no mesmo log, com o mesmo `requestId`, e não num
// `console.error` solto.
import {
  consoleSink,
  createLoggerFactory,
  jsonFormatter,
  runtimeEnv,
  textFormatter,
  type Logger,
} from 'wts-logger';

import { installTxikiRuntime } from './runtime.js';

/** Global do runtime txiki.js. Só existe quando rodando em `tjs`. */
declare const tjs: {
  env: Record<string, string | undefined>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  serve(options: {
    port?: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): { port?: number };
};

/** Subconjunto do HttpResponse do Vike que usamos. */
export interface VikeHttpResponse {
  statusCode: number;
  headers: [string, string][];
  getBody(): Promise<string>;
}

export interface VikePageContext {
  httpResponse: VikeHttpResponse | null;
}

/** Assinatura de `renderPage` importado de `vike/server`. */
export type RenderPage = (pageContextInit: {
  urlOriginal: string;
  /**
   * Cabeçalhos crus da requisição. O Vike normaliza para `pageContext.headers`
   * (nomes em minúsculas). Sem isto o `pageContext.headers` chega `null` e o
   * servidor nunca enxerga o cookie de sessão nem o `user-agent`.
   */
  headersOriginal?: unknown;
  /**
   * O logger daquela requisição, repassado ao `pageContext`.
   *
   * O `renderPage` do Vike é genérico no `pageContextInit` e preserva o que
   * recebe, então qualquer propriedade posta aqui reaparece em
   * `pageContext.logger` do lado do servidor. É por este canal que a aplicação
   * recebe um logger já com `requestId`, `method` e `url` dentro, sem conhecer
   * o adapter e sem que nada precise ser passado de mão em mão.
   *
   * **Não** pode entrar em `passToClient`: um logger não é serializável, e o
   * navegador tem o seu.
   */
  logger?: Logger;
  /**
   * O identificador desta requisição, repassado ao `pageContext`.
   *
   * Vai como string simples e não dentro do logger porque este é o único campo
   * que precisa **chegar ao navegador**: a tela de erro o mostra para que quem
   * viu a falha possa citá-lo ao suporte, e quem opera ache a linha exata do
   * log. Um identificador opaco não revela nada sobre o servidor.
   *
   * Para aparecer no cliente, a aplicação precisa declará-lo em `passToClient`.
   */
  requestId?: string;
}) => Promise<VikePageContext>;

export interface AdapterOptions {
  /** `renderPage` importado de `vike/server`. */
  renderPage: RenderPage;
  /**
   * Base dos assets estáticos do build (`dist/client`). Recomenda-se passar
   * uma URL: `new URL('../client/', import.meta.url)`. Se omitido, nada é
   * servido estaticamente (útil atrás de um CDN/reverse-proxy).
   */
  staticDir?: URL | string;
  /** Porta HTTP. Default: 3000. */
  port?: number;
  /** Overrides/extensões do mapa de MIME por extensão de arquivo. */
  mimeTypes?: Record<string, string>;
  /**
   * O logger raiz do servidor.
   *
   * Omitido, o adapter monta um sobre o console, no nível de `LOG_LEVEL`. Quem
   * quiser outro destino (ou um `fileSink`) passa o seu — o adapter não decide
   * para onde o log vai, só garante que ele exista.
   */
  logger?: Logger;
}

const DEFAULT_MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Esquema com que o cliente chegou, segundo o `X-Forwarded-Proto`.
 * Retorna `null` quando o cabeçalho não veio (ou veio com valor que não é
 * `http`/`https`), para que se caia no esquema da conexão recebida.
 *
 * Atrás de um proxy que termina TLS, a conexão que chega até aqui é sempre
 * `http://` — quem sabe que o cliente veio por `https://` é só o proxy, e é
 * isso que ele diz neste cabeçalho. Ignorá-lo faz toda URL absoluta derivada
 * de `urlOriginal` sair em texto claro: o `Location` de um `+redirects`, por
 * exemplo, joga o navegador para fora do TLS e cobra dele os saltos de volta.
 *
 * Confiar no cabeçalho só é seguro enquanto nada alcançar este servidor senão
 * o proxy (escuta em loopback, porta fechada para fora). Exposto diretamente,
 * ele passa a ser entrada de usuário e não vale mais como fonte.
 */
function forwardedProto(request: Request): 'http' | 'https' | null {
  const header = request.headers.get('x-forwarded-proto');
  if (!header) return null;
  // Uma cadeia de proxies acumula valores (`https, http`); o primeiro é o do
  // cliente, os demais são saltos internos.
  const proto = header.split(',')[0]!.trim().toLowerCase();
  return proto === 'http' || proto === 'https' ? proto : null;
}

/**
 * O logger raiz quando o consumidor não passa um.
 *
 * Console e nada mais: quem serve o processo é que decide para onde o stdout
 * vai. Um adapter que abrisse arquivo por conta própria disputaria com o
 * supervisor o caminho do log.
 *
 * O formato padrão é **JSON**, porque o destino de um servidor é um coletor e
 * não um par de olhos. `LOG_FORMAT=text` troca para o formato legível, que é o
 * que se quer no terminal durante o desenvolvimento.
 *
 * `runtimeEnv` e não `tjs.env` direto: a leitura passa pela porta que
 * `installTxikiRuntime` instalou, que é a mesma por onde o logger lê o
 * `LOG_LEVEL`. Um caminho só para o ambiente é o que impede as duas variáveis
 * de divergirem em qual runtime consultam.
 */
function defaultLogger(): Logger {
  const formatter = runtimeEnv('LOG_FORMAT') === 'text' ? textFormatter : jsonFormatter;
  return createLoggerFactory({ sinks: [consoleSink({ formatter })] }).create('vike-txiki');
}

function toBaseUrl(staticDir: URL | string): URL {
  if (staticDir instanceof URL) return staticDir;
  const withSlash = staticDir.endsWith('/') ? staticDir : `${staticDir}/`;
  return new URL(withSlash, 'file://');
}

/**
 * Cria o handler `fetch` (Request -> Response) que adapta o Vike.
 * Web-standard: pode ser usado com qualquer servidor WinterTC, não só o tjs.
 */
export function createFetchHandler(
  options: AdapterOptions
): (request: Request) => Promise<Response> {
  const { renderPage } = options;
  if (typeof renderPage !== 'function') {
    throw new TypeError('vike-txiki-adapter: `renderPage` é obrigatório (importe de "vike/server").');
  }

  // Antes de qualquer logger: é isto que faz `LOG_LEVEL`/`LOG_FORMAT` saírem de
  // `tjs.env` em vez de um `process.env` que não existe aqui.
  installTxikiRuntime();

  const MIME = { ...DEFAULT_MIME, ...(options.mimeTypes ?? {}) };
  const baseUrl = options.staticDir ? toBaseUrl(options.staticDir) : null;
  const root = options.logger ?? defaultLogger();

  async function serveStatic(pathname: string, log: Logger): Promise<Response | null> {
    if (!baseUrl) return null;
    const fileUrl = new URL('.' + pathname, baseUrl);
    try {
      const data = await tjs.readFile(fileUrl.pathname);
      const dot = pathname.lastIndexOf('.');
      const ext = dot === -1 ? '' : pathname.slice(dot);
      log.trace('asset servido do disco', { bytes: data.byteLength });
      return new Response(data, {
        headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' }
      });
    } catch {
      return null; // arquivo não existe -> deixa o Vike tentar
    }
  }

  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // O contexto da requisição nasce aqui, e viaja no logger. Não há
    // `AsyncLocalStorage` no txiki, e uma variável de módulo seria lida pela
    // requisição errada assim que duas chegassem juntas.
    const requestId = crypto.randomUUID();
    const log = root.with({ requestId, method: request.method, url: pathname });

    // O esquema do cliente vem do proxy quando ele o informa; senão, é o da
    // conexão recebida. O `Host` já chega correto e não é tocado.
    const proto = forwardedProto(request);
    if (proto) url.protocol = `${proto}:`;

    // 1. Assets estáticos do build.
    if (pathname !== '/' && !pathname.endsWith('/')) {
      const asset = await serveStatic(pathname, log);
      if (asset) return asset;
    }

    // 2. SSR do Vike.
    //
    // `headersOriginal` é obrigatório, não opcional: é dele que o Vike deriva
    // `pageContext.headers`. Sem repassá-lo o servidor renderiza toda rota como
    // anônima (o cookie de sessão nunca chega) e o `vike-solid` também nunca
    // detecta bot pelo `user-agent`.
    //
    // `logger` desce junto e reaparece em `pageContext.logger`: é assim que a
    // aplicação recebe o contexto desta requisição sem conhecer o adapter.
    let pageContext: VikePageContext;
    try {
      pageContext = await renderPage({
        urlOriginal: url.href,
        headersOriginal: request.headers,
        logger: log,
        requestId,
      });
    } catch (error) {
      // O txiki imprime só o stack de exceções não tratadas, sem a mensagem —
      // o que transforma qualquer falha de render num 500 mudo. Registrar aqui
      // é a diferença entre "500" e saber o que quebrou.
      log.error('falha ao renderizar', { error });
      return new Response('Internal Server Error', { status: 500 });
    }

    const { httpResponse } = pageContext;
    if (!httpResponse) {
      log.warn('nenhuma rota casou', { status: 404 });
      return new Response('Not Found', { status: 404 });
    }

    const body = await httpResponse.getBody();
    log.info('página servida', { status: httpResponse.statusCode });
    return new Response(body, {
      status: httpResponse.statusCode,
      headers: httpResponse.headers
    });
  };
}

/**
 * Sobe o servidor HTTP nativo do txiki.js (`tjs.serve`) servindo o Vike.
 * Retorna o objeto do servidor (com `.port`).
 */
export function serve(options: AdapterOptions): { port?: number } {
  installTxikiRuntime();

  const port = options.port ?? Number(runtimeEnv('PORT') ?? 3000);
  const root = options.logger ?? defaultLogger();
  const fetch = createFetchHandler({ ...options, logger: root });
  const server = tjs.serve({ port, fetch });

  // A linha de boot sai pelo mesmo logger que tudo o mais, e não por um
  // `console.log` no entry gerado: assim ela respeita o nível e o formato
  // configurados, e um coletor não recebe uma linha solta que não sabe ler.
  root.info('servidor no ar', { port: server.port ?? port });

  return server;
}

export {
  installTxikiRuntime,
  txikiEnv,
  txikiFs,
  txikiSignals,
} from './runtime.js';

export default serve;
