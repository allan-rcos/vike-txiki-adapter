/**
 * O teste de contrato do runtime: as portas do txiki contra o txiki de verdade.
 *
 * Ele mora aqui, e não no `wts-logger`, porque quem faz as suposições sobre o
 * `tjs` é este package — o logger só declara `FileSystemPort` e `SignalPort` e
 * não sabe quem as preenche. A suíte do vitest do logger cobre a lógica
 * (rotação, fila, poda) contra uma porta em memória, e é a cobertura certa
 * para isso.
 *
 * O que ela **não pode** cobrir é se a API do txiki é como foi lida:
 * `tjs.makeDir` aceita `recursive`, o handle de `tjs.open(path,'a')` tem mesmo
 * `write`/`sync`/`close`, `tjs.rename` move um arquivo aberto, e o handler de
 * `SIGTERM` chega a terminar um I/O assíncrono antes de o processo morrer.
 * Cada uma dessas é uma suposição que, se estiver errada, só aparece em
 * produção — que foi exatamente como o SSR ficou quatro defeitos no escuro.
 *
 * Roda com `bun run test:tjs`.
 *
 * @packageDocumentation
 */
import { createLoggerFactory, fileSink, type LogEvent } from 'wts-logger';

import { installTxikiRuntime } from '../../src/runtime.js';

// As portas do txiki entram ANTES do primeiro sink: é justamente o encaixe
// entre elas e a API real do runtime que este arquivo existe para provar.
installTxikiRuntime();

/** O global do txiki, na parte que este teste usa. */
declare const tjs: {
  args: string[];
  pid: number;
  exit(code: number): void;
  tmpDir: string;
  makeTempDir(template: string): Promise<string>;
  makeDir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  remove(path: string): Promise<void>;
  spawn(
    command: string[],
    options?: { stdout?: string; stderr?: string },
  ): { pid: number; kill(signal: string): void; wait(): Promise<{ exit_status: number }> };
};

/** Quantas asserções passaram. */
let passaram = 0;

/** As falhas encontradas. */
const falhas: string[] = [];

/**
 * Registra o resultado de uma asserção.
 *
 * @param descricao O que estava sendo verificado.
 * @param condicao  Se passou.
 * @param detalhe   O que foi observado, quando falha.
 */
function verificar(descricao: string, condicao: boolean, detalhe = ''): void {
  if (condicao) {
    passaram += 1;
    console.log(`  ok  ${descricao}`);
    return;
  }
  falhas.push(descricao);
  console.log(`FALHA  ${descricao}${detalhe === '' ? '' : ` — ${detalhe}`}`);
}

/**
 * Uma linha de log.
 *
 * @param message A mensagem.
 */
function evento(message: string): LogEvent {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    name: 'contrato',
    message,
    fields: { runtime: 'txiki' },
  };
}

/**
 * Lê um arquivo como texto, ou devolve vazio se ele não existir.
 *
 * @param path Caminho do arquivo.
 */
async function ler(path: string): Promise<string> {
  try {
    return new TextDecoder().decode(await tjs.readFile(path));
  } catch {
    return '';
  }
}

/**
 * Se um caminho existe.
 *
 * @param path Caminho a verificar.
 */
async function existe(path: string): Promise<boolean> {
  try {
    await tjs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** O caminho deste próprio bundle, para o `spawn` do teste de sinal. */
function esteArquivo(): string {
  return new URL(import.meta.url).pathname;
}

/** O papel de filho: escreve e fica esperando o `SIGTERM` do pai. */
async function comoFilho(): Promise<void> {
  // O argumento vem DEPOIS de `--filho`, e não num índice fixo: o argv do txiki
  // já começa com `tjs run <script>`, e contar posições daria um caminho
  // `undefined` que só apareceria como um teste falhando sem motivo visível.
  const destino = tjs.args[tjs.args.indexOf('--filho') + 1] as string;

  // O diretório é criado aqui, e não deixado para o sink: ele só o cria na
  // drenagem, e este teste existe justamente para NÃO drenar antes do sinal.
  await tjs.makeDir(destino.slice(0, destino.lastIndexOf('/')), { recursive: true });

  const sink = fileSink({ path: destino, maxBytes: 0 });
  sink.emit(evento('antes do sinal 1'));
  sink.emit(evento('antes do sinal 2'));

  // Marca que já emitiu — sem flush. Se o handler de sinal não funcionar, o
  // arquivo de log fica vazio e o pai acusa.
  await tjs.writeFile(`${destino}.pronto`, new TextEncoder().encode('1'));

  // Só existe para o processo não sair sozinho antes do sinal chegar.
  setTimeout(() => tjs.exit(9), 10_000);
}

/** O papel de pai: roda as asserções e comanda o teste de sinal. */
async function comoPai(): Promise<void> {
  // O template é obrigatório e o caminho precisa ser absoluto: sem argumento
  // o txiki devolve EINVAL, e com um template relativo ele cria o diretório no
  // CWD — que num teste é o diretório do repositório.
  const base = await tjs.makeTempDir(`${tjs.tmpDir}/wts-logger-XXXXXX`);
  console.log(`wts-logger — contrato do runtime txiki (${base})\n`);

  // --- makeDir recursivo, e a escrita de verdade -------------------------
  const aninhado = `${base}/var/log/flow/app.log`;
  const sink = fileSink({ path: aninhado, maxBytes: 0, flushOnSignal: false });
  sink.emit(evento('primeira'));
  sink.emit(evento('segunda'));
  await sink.flush?.();

  const conteudo = await ler(aninhado);
  verificar('tjs.makeDir cria a árvore de diretórios', conteudo !== '');
  verificar(
    'as duas linhas chegaram ao disco',
    conteudo.split('\n').filter(Boolean).length === 2,
    conteudo,
  );
  verificar('a linha é um JSON válido', (() => {
    try {
      const primeira = JSON.parse(conteudo.split('\n')[0] as string) as { msg: string };
      return primeira.msg === 'primeira';
    } catch {
      return false;
    }
  })());
  await sink.close?.();

  // --- rotação com rename de verdade ------------------------------------
  const rotativo = `${base}/rot/app.log`;
  const pequeno = fileSink({
    path: rotativo,
    maxBytes: 120,
    maxFiles: 2,
    flushOnSignal: false,
  });
  for (let indice = 0; indice < 12; indice += 1) {
    pequeno.emit(evento(`linha-${indice}`));
    await pequeno.flush?.();
  }
  await pequeno.close?.();

  verificar('tjs.rename produziu o arquivo .1', await existe(`${rotativo}.1`));
  verificar('tjs.rename produziu o arquivo .2', await existe(`${rotativo}.2`));
  verificar('maxFiles descartou o .3', !(await existe(`${rotativo}.3`)));
  verificar(
    'o arquivo ativo respeita maxBytes',
    (await tjs.stat(rotativo)).size <= 120,
    `${(await tjs.stat(rotativo)).size} bytes`,
  );

  // --- reabrir continua do tamanho em disco ------------------------------
  const retomado = `${base}/retomado/app.log`;
  const antes = fileSink({ path: retomado, maxBytes: 0, flushOnSignal: false });
  antes.emit(evento('do processo anterior'));
  await antes.close?.();
  const tamanhoAntes = (await tjs.stat(retomado)).size;

  const depois = fileSink({ path: retomado, maxBytes: 0, flushOnSignal: false });
  depois.emit(evento('do processo novo'));
  await depois.close?.();

  const texto = await ler(retomado);
  verificar(
    "tjs.open(path,'a') acrescenta em vez de truncar",
    texto.includes('do processo anterior') && texto.includes('do processo novo'),
    texto,
  );
  verificar(
    'o tamanho retomado veio do disco',
    (await tjs.stat(retomado)).size > tamanhoAntes,
  );

  // --- a fábrica inteira, com o loglevel dentro do QuickJS ---------------
  //
  // O `loglevel` é a base do gerenciamento de nível, e ele é um UMD escrito
  // para navegador e Node. Que ele carregue e filtre sob o QuickJS é suposição
  // demais para ficar só numa conferência manual.
  const pilha = `${base}/pilha/app.log`;
  const arquivo = fileSink({ path: pilha, maxBytes: 0, flushOnSignal: false });
  const factory = createLoggerFactory({ level: 'info', sinks: [arquivo] });

  const log = factory.create('http').with({ requestId: 'r-42' });
  log.debug('não deve sair');
  log.info('requisição servida', { status: 200 });
  log.child('render').warn('lento');
  await factory.flush();

  const linhas = (await ler(pilha)).split('\n').filter(Boolean);
  verificar('o loglevel filtra por nível dentro do QuickJS', linhas.length === 2, `${linhas.length} linhas`);

  const primeira = JSON.parse(linhas[0] ?? '{}') as {
    logger: string;
    msg: string;
    fields: { requestId: string; status: number };
  };
  verificar('o nome do logger acompanha a linha', primeira.logger === 'http');
  verificar(
    'os campos do logger e do instante se somam',
    primeira.fields.requestId === 'r-42' && primeira.fields.status === 200,
    JSON.stringify(primeira.fields),
  );
  verificar(
    'child() deriva o nome',
    (JSON.parse(linhas[1] ?? '{}') as { logger: string }).logger === 'http.render',
  );
  await factory.close();

  // --- descarga no SIGTERM, num processo de verdade ----------------------
  const doSinal = `${base}/sinal/app.log`;
  const filho = tjs.spawn(['tjs', 'run', esteArquivo(), '--filho', doSinal], {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const limite = Date.now() + 5_000;
  while (!(await existe(`${doSinal}.pronto`)) && Date.now() < limite) {
    await new Promise((resolva) => setTimeout(resolva, 50));
  }

  const emitiu = await existe(`${doSinal}.pronto`);
  verificar('o processo filho emitiu e sinalizou que estava pronto', emitiu);

  if (emitiu) {
    filho.kill('SIGTERM');
    const status = await filho.wait();

    const salvo = await ler(doSinal);
    verificar(
      'o handler de SIGTERM descarregou a fila antes de o processo sair',
      salvo.includes('antes do sinal 1') && salvo.includes('antes do sinal 2'),
      salvo === '' ? '(arquivo vazio)' : salvo,
    );
    verificar('o filho saiu limpo, e não foi morto pelo sinal', status.exit_status === 0);
  }

  console.log(`\n${passaram} asserções passaram, ${falhas.length} falharam.`);
  if (falhas.length > 0) {
    tjs.exit(1);
  }
}

if (tjs.args.includes('--filho')) {
  await comoFilho();
} else {
  await comoPai();
}
