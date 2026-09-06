// vike-txiki-adapter/runtime
// ==========================
// As portas de runtime do txiki.js, para o `wts-logger`.
//
// O logger é genérico e não conhece runtime nenhum: ele declara portas
// (`RuntimePorts`) e quem as preenche é a raiz de composição. Aqui é essa raiz,
// porque este package é o único do conjunto que já sabe que está sob o `tjs`.
//
// O que o txiki tem de diferente, e que motiva cada porta:
//
// - **não há `process`** — o ambiente vive em `tjs.env`. Ler `process.env` num
//   runtime sem `process` foi o defeito que manteve o SSR sem credencial de API
//   até alguém rodar o servidor de verdade: `tsc`, lint, teste e build passavam
//   todos, porque nenhum deles executa no runtime de destino;
// - **o sistema de arquivos é próprio** (`tjs.open`/`tjs.stat`/`tjs.rename`), e
//   a ausência de um arquivo chega como exceção, não como valor;
// - **os sinais têm API própria** (`tjs.addSignalListener`), e — medido — o
//   handler chega a terminar um I/O assíncrono antes de o processo sair.
//
// O contrato dessas suposições é provado no runtime real por `test/tjs/main.ts`.
import { configureRuntime, type FileHandlePort, type FileSystemPort, type SignalPort } from 'wts-logger';

/** A parte do global do txiki que estas portas usam. */
interface TxikiGlobal {
  env?: Record<string, string | undefined>;
  makeDir?(path: string, options?: { recursive?: boolean }): Promise<void>;
  open?(
    path: string,
    flags: string,
  ): Promise<{
    write(data: Uint8Array): Promise<number>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  stat?(path: string): Promise<{ size: number }>;
  rename?(from: string, to: string): Promise<void>;
  remove?(path: string): Promise<void>;
  addSignalListener?(signal: string, handler: () => void): void;
  removeSignalListener?(signal: string, handler: () => void): void;
  exit?(code: number): void;
}

/** O global do txiki, quando existe. */
function txiki(): TxikiGlobal | undefined {
  return (globalThis as { tjs?: TxikiGlobal }).tjs;
}

/**
 * Exige o global do txiki, com uma mensagem que diz o que fazer.
 *
 * @param what O que estava sendo montado quando ele faltou.
 */
function requireTxiki(what: string): TxikiGlobal {
  const tjs = txiki();
  if (tjs === undefined) {
    throw new Error(
      `vike-txiki-adapter: ${what} precisa do runtime txiki.js (global \`tjs\`). ` +
        'Em Node/Bun, forneça as suas próprias portas ao wts-logger.',
    );
  }
  return tjs;
}

/** Lê uma variável de ambiente do txiki. */
export function txikiEnv(): (name: string) => string | undefined {
  return (name) => txiki()?.env?.[name];
}

/**
 * O sistema de arquivos do txiki, na forma da porta do logger.
 *
 * `size` e `exists` compartilham o `stat`, que é a única forma de perguntar
 * pelos dois: o txiki não tem um `access`, e a ausência do arquivo chega como
 * exceção — daí `exists` ser um `stat` embrulhado, e não uma checagem barata.
 */
export function txikiFs(): FileSystemPort {
  return {
    async makeDir(path, options) {
      await requireTxiki('o fileSink').makeDir?.(path, { recursive: options.recursive });
    },
    async open(path, flags): Promise<FileHandlePort> {
      const handle = await requireTxiki('o fileSink').open?.(path, flags);
      if (handle === undefined) {
        throw new Error('vike-txiki-adapter: `tjs.open` não está disponível.');
      }
      return {
        write: (data) => handle.write(data),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    async size(path) {
      const stat = await requireTxiki('o fileSink').stat?.(path);
      return stat?.size ?? 0;
    },
    async rename(from, to) {
      await requireTxiki('o fileSink').rename?.(from, to);
    },
    async remove(path) {
      try {
        await requireTxiki('o fileSink').remove?.(path);
      } catch {
        // Apagar o que já não existe é o resultado desejado, não um erro.
      }
    },
    async exists(path) {
      try {
        await requireTxiki('o fileSink').stat?.(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Os sinais de parada do txiki, na forma da porta do logger. */
export function txikiSignals(): SignalPort {
  return {
    add: (signal, handler) => txiki()?.addSignalListener?.(signal, handler),
    remove: (signal, handler) => txiki()?.removeSignalListener?.(signal, handler),
    exit: (code) => txiki()?.exit?.(code),
  };
}

/**
 * Instala as portas do txiki no `wts-logger`.
 *
 * Idempotente e barato: só troca referências. `serve` e `createFetchHandler` o
 * chamam antes de montar qualquer logger, para que o `LOG_LEVEL` e o
 * `LOG_FORMAT` já saiam de `tjs.env` na primeira linha.
 *
 * Os sinais só entram quando o runtime de fato os oferece: fora do `tjs` a
 * porta ficaria inerte e o `fileSink` instalaria handler que nunca dispara —
 * pior do que não instalar, porque parece proteção.
 */
export function installTxikiRuntime(): void {
  const tjs = txiki();
  configureRuntime({
    env: txikiEnv(),
    ...(tjs?.open !== undefined ? { fs: txikiFs() } : {}),
    ...(tjs?.addSignalListener !== undefined ? { signals: txikiSignals() } : {}),
  });
}
