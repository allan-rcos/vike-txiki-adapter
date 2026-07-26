// vike-txiki-adapter
// ===================
// Adapter agnóstico que serve QUALQUER build de produção do Vike no
// runtime txiki.js (`tjs`), usando apenas APIs Web-standard (WinterTC).
//
// Não conhece nada do projeto: recebe o `renderPage` do Vike (já com o
// global context registrado pelo `dist/server/entry.mjs` do projeto) e,
// opcionalmente, o diretório de assets estáticos. Assim funciona para
// qualquer app Vike, independente de framework de UI (Solid, React, etc).

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

  const MIME = { ...DEFAULT_MIME, ...(options.mimeTypes ?? {}) };
  const baseUrl = options.staticDir ? toBaseUrl(options.staticDir) : null;

  async function serveStatic(pathname: string): Promise<Response | null> {
    if (!baseUrl) return null;
    const fileUrl = new URL('.' + pathname, baseUrl);
    try {
      const data = await tjs.readFile(fileUrl.pathname);
      const dot = pathname.lastIndexOf('.');
      const ext = dot === -1 ? '' : pathname.slice(dot);
      return new Response(data, {
        headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' }
      });
    } catch {
      return null; // arquivo não existe -> deixa o Vike tentar
    }
  }

  return async function fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    // 1. Assets estáticos do build.
    if (pathname !== '/' && !pathname.endsWith('/')) {
      const asset = await serveStatic(pathname);
      if (asset) return asset;
    }

    // 2. SSR do Vike.
    //
    // `headersOriginal` é obrigatório, não opcional: é dele que o Vike deriva
    // `pageContext.headers`. Sem repassá-lo o servidor renderiza toda rota como
    // anônima (o cookie de sessão nunca chega) e o `vike-solid` também nunca
    // detecta bot pelo `user-agent`.
    let pageContext: VikePageContext;
    try {
      pageContext = await renderPage({
        urlOriginal: request.url,
        headersOriginal: request.headers,
      });
    } catch (error) {
      // O txiki imprime só o stack de exceções não tratadas, sem a mensagem —
      // o que transforma qualquer falha de render num 500 mudo. Logar aqui é a
      // diferença entre "500" e saber o que quebrou.
      const err = error as { message?: string; stack?: string };
      console.error(
        `[vike-txiki-adapter] falha ao renderizar ${pathname}: ${err?.message ?? String(error)}`
      );
      if (err?.stack) console.error(err.stack);
      return new Response('Internal Server Error', { status: 500 });
    }

    const { httpResponse } = pageContext;
    if (!httpResponse) {
      return new Response('Not Found', { status: 404 });
    }

    const body = await httpResponse.getBody();
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
  const port = options.port ?? Number(tjs.env.PORT ?? 3000);
  const fetch = createFetchHandler(options);
  return tjs.serve({ port, fetch });
}

export default serve;
