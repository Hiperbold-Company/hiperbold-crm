/**
 * A configuração da INSTALAÇÃO: banco primeiro, `.env` como piso.
 *
 * Este é o único módulo que fala com `public.platform_config`. A regra de quem
 * vence e de quando o `.env` promove mora em `config-resolve.ts`, puro e
 * testável sem Postgres.
 *
 * ── O memo: 30 s, em processo, invalidado pela escrita ───────────────────────
 *
 * Esta configuração quase nunca muda e era lida do banco a cada uso: ~2 mil
 * leituras/dia de `platform_config` numa instalação parada (e-mail, cobrança,
 * marca de saída, webhook da instalação). `lerLinha` passa por `comCacheCurto`
 * (`lib/auth/cache-curto.ts`, o mesmo cache de 30 s da autorização), uma entrada
 * por chave: `config:<chave>`.
 *
 * O que fica guardado é a LINHA CRUA — com o envelope CIFRADO, nunca o texto em
 * claro. Abrir o envelope (AES-GCM) é barato e continua a cada leitura; assim o
 * mapa em memória não passa a conter segredo decifrado. O valor nunca é logado.
 *
 * Invalidação: `gravarPelaTela`, `voltarAoAmbiente` e `gravarSeAusente`
 * invalidam a chave logo depois de uma escrita bem-sucedida, e a leitura em voo
 * que começou antes da escrita não regrava o valor velho (guarda de geração do
 * `comCacheCurto`). No MESMO processo, a próxima leitura já vê o novo.
 *
 * ⚠️ O que o memo NÃO alcança: o `worker` e qualquer outra réplica são OUTROS
 * processos e não veem a invalidação do `app`. Trocar a chave pela tela vale
 * para eles em até 30 s (`TTL_CURTO_MS`) — não mais "até alguém reiniciar", como
 * seria um memo sem TTL. Escrita direta por SQL (DBA, migration) tem o mesmo
 * teto. Quem precisa do valor exato — a tela (`estadoParaTela`) e a leitura
 * depois de gravar — lê FRESCO (`lerLinha(chave, { fresca: true })`).
 *
 * "erro" (banco recusou / transporte falhou) fica FORA do memo: erro é incidente,
 * não estado, e uma falha de rede não pode virar fato por um TTL inteiro. Já
 * "a linha não existe" (`null`) entra: é o caso comum (chave só no `.env`), e a
 * escrita que cria a linha invalida.
 *
 * (Até 2026-11-09 este módulo não tinha memo, por medo de o `worker` usar a
 * chave antiga sem aviso. O TTL resolve: a janela é de 30 s, não infinita.)
 *
 * ── Nada aqui lança ──────────────────────────────────────────────────────────
 *
 * Mesmo contrato do resolvedor da marca: "o banco não falou" degrada para o
 * `.env`, com aviso no log. Uma exceção neste caminho seria 500 na tela onde
 * alguém corrigiria o que quebrou. Falha fechada na AÇÃO (não grava sem cifra),
 * aberta na INFORMAÇÃO (a tela abre e diz o que falta).
 */
import { comCacheCurto, invalidarChave } from "@/lib/auth/cache-curto";
import { byteaToBuffer, bufToBytea, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

import { ttlDoMemoDaInstalacaoMs } from "./memo";
import { precisaSemear, resolver, type EstadoDaLinha, type Fonte } from "./config-resolve";

// ⚠️ O nome da tabela é escrito por EXTENSO em cada `.from()`, e não numa
// constante, de propósito. `tests/invariants/on-conflict-aponta-para-constraint-real.test.ts`
// varre cada `onConflict` e resolve a tabela pelo `.from("<literal>")` mais
// próximo acima — `.from(variavel)` fica NÃO-RESOLVIDO e reprova. A varredura
// existe para garantir que todo `onConflict` aponte para uma constraint que
// existe de verdade; uma constante aqui a cega, e o custo de cegá-la é maior que
// o de repetir a string três vezes.

/** O que a linha traz do banco. O envelope só é aberto aqui dentro. */
interface LinhaCrua {
  chave: string;
  valor: string | null;
  ciphertext: string | null;
  iv: string | null;
  tag: string | null;
  last4: string | null;
  eh_segredo: boolean;
  semeado_do_env: boolean;
}

export interface ValorDaInstalacao {
  readonly valor: string | null;
  readonly fonte: Fonte;
}

/**
 * O que a TELA pode ver. Note o que não está aqui: o valor.
 *
 * `lib/crypto/aes_gcm.ts` escreve a regra no topo — o plaintext nunca é logado,
 * persistido em claro nem devolvido em resposta; só o `last4` é exposto. A
 * credencial do Google (0201) já provou que dá para operar assim: quem configura
 * confere pelos últimos quatro caracteres e substitui quando quer trocar.
 */
export interface EstadoParaTela {
  readonly chave: string;
  readonly fonte: Fonte;
  readonly configurado: boolean;
  readonly last4: string | null;
  readonly ehSegredo: boolean;
  /** Preenchido só para knob — segredo nunca devolve valor. */
  readonly valorVisivel: string | null;
}

function doAmbiente(chave: string): string | null {
  const fonte = env as unknown as Record<string, unknown>;
  const bruto = fonte[chave] ?? process.env[chave];
  return typeof bruto === "string" ? bruto : null;
}

/**
 * O dado adicional da cifra de um segredo da configuração (D-168, parte 2): prende o envelope à CHAVE
 * (`platform_config:<chave>`). Antes o envelope era cifrado sem dado adicional com a mesma `AI_CRED_AES_KEY`
 * das credenciais de IA, e a cifra de uma chave copiada para outra abria. A leitura segue aceitando o
 * formato antigo (iv de 12 bytes ignora o contexto); a linha antiga vira nova quando a chave é salva de novo
 * pela tela.
 */
export function aadDaConfiguracao(chave: string): string {
  return `platform_config:${chave}`;
}

function aviso(chave: string, o_que: string, erro: unknown) {
  // Logger estruturado do projeto: nunca o valor, só a chave e o motivo.
  console.warn(
    `[instalacao/config] ${o_que} para "${chave}" — usando o .env. ` +
      `${erro instanceof Error ? erro.message : String(erro)}`,
  );
}

/**
 * Abre o envelope. Devolve `null` — nunca lança — quando a chave de cifra não
 * está configurada ou o envelope não abre.
 *
 * Os dois casos degradam igual de propósito: para quem opera a VPS, "a chave
 * `AI_CRED_AES_KEY` sumiu do `.env`" e "este envelope foi cifrado com outra
 * chave" têm o mesmo remédio — repor a chave certa —, e nenhum dos dois pode
 * derrubar a tela que mostra o problema.
 */
function abrirEnvelope(linha: LinhaCrua): string | null {
  if (!linha.ciphertext || !linha.iv || !linha.tag) return null;
  try {
    return decryptKey(
      {
        ciphertext: byteaToBuffer(linha.ciphertext),
        iv: byteaToBuffer(linha.iv),
        tag: byteaToBuffer(linha.tag),
      },
      { aad: aadDaConfiguracao(linha.chave) },
    );
  } catch (erro) {
    aviso(linha.chave, "o segredo guardado não abriu", erro);
    return null;
  }
}

function emClaro(linha: LinhaCrua): EstadoDaLinha {
  return {
    valor: linha.eh_segredo ? abrirEnvelope(linha) : linha.valor,
    semeadoDoEnv: linha.semeado_do_env,
  };
}

/** A chave do memo de uma linha de `platform_config`. */
function chaveDoMemo(chave: string): string {
  return `config:${chave}`;
}

/** Esquece o memo desta chave neste processo. Chamar logo depois de uma escrita bem-sucedida. */
export function invalidarConfiguracao(chave: string): void {
  invalidarChave(chaveDoMemo(chave));
}

async function lerLinhaDoBanco(chave: string): Promise<LinhaCrua | null | "erro"> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_config")
      .select("chave, valor, ciphertext, iv, tag, last4, eh_segredo, semeado_do_env")
      .eq("chave", chave)
      // Fora da deduplicação de `fetch` do Next dentro de um render: sem o `signal`,
      // uma 2ª leitura do MESMO render, feita depois de uma escrita ter invalidado o
      // memo, recebe a resposta de ANTES dela e a memoiza. O porquê inteiro está em
      // `lerLinha` de `lib/branding/instalacao.ts` (#1218). Nunca é abortado.
      .abortSignal(new AbortController().signal)
      .maybeSingle();
    if (error) {
      // `42P01` é o rollback pela outra ponta: imagem nova sobre schema velho,
      // o que acontece quando o baseline ainda não foi aplicado. Degrada igual.
      aviso(chave, "o banco recusou a leitura", error.message);
      return "erro";
    }
    return (data as LinhaCrua | null) ?? null;
  } catch (erro) {
    aviso(chave, "a leitura do banco falhou", erro);
    return "erro";
  }
}

async function lerLinha(
  chave: string,
  opcoes: { fresca?: boolean } = {},
): Promise<LinhaCrua | null | "erro"> {
  if (opcoes.fresca) return lerLinhaDoBanco(chave);
  return comCacheCurto<LinhaCrua | null | "erro">({
    chave: chaveDoMemo(chave),
    ttlMs: ttlDoMemoDaInstalacaoMs(),
    // "erro" não é estado: não entra no memo.
    guardar: (linha) => linha !== "erro",
    carregar: () => lerLinhaDoBanco(chave),
  });
}

/**
 * O valor em vigor para uma chave — o que o código deve chamar em vez de
 * `env.X` quando a chave é configurável pela tela.
 */
export async function valorDaInstalacao(chave: string): Promise<ValorDaInstalacao> {
  const linha = await lerLinha(chave);
  if (linha === "erro") {
    const doEnv = doAmbiente(chave);
    return resolver(null, doEnv);
  }
  return resolver(linha ? emClaro(linha) : null, doAmbiente(chave));
}

/**
 * O estado de uma chave para a tela — sem nunca devolver segredo.
 */
export async function estadoParaTela(
  chave: string,
  ehSegredo: boolean,
): Promise<EstadoParaTela> {
  // Fresca: a tela mostra o que ACABOU de ser salvo, inclusive por outro processo.
  const linha = await lerLinha(chave, { fresca: true });
  const cru = linha === "erro" ? null : linha;
  const { valor, fonte } = resolver(cru ? emClaro(cru) : null, doAmbiente(chave));
  return {
    chave,
    fonte,
    configurado: valor !== null,
    last4: cru?.last4 ?? (valor !== null && ehSegredo ? valor.slice(-4) : null),
    ehSegredo,
    valorVisivel: ehSegredo ? null : valor,
  };
}

export type ResultadoDaEscrita =
  | { ok: true }
  | { ok: false; motivo: "sem_chave_de_cifra" | "banco_recusou"; detalhe: string };

/**
 * Grava pela tela. Zera `semeado_do_env` — a partir daqui o `.env` não
 * sobrescreve mais, inclusive se o valor for apagado depois.
 *
 * Falha FECHADA: sem chave de cifra, não grava e diz por quê. Gravar um segredo
 * em claro porque a cifra não estava disponível seria o pior desfecho possível,
 * e é o que a rota do Google já recusa.
 */
export async function gravarPelaTela(
  chave: string,
  valor: string,
  opcoes: { ehSegredo: boolean; ator: string | null },
): Promise<ResultadoDaEscrita> {
  const linha: Record<string, unknown> = {
    chave,
    eh_segredo: opcoes.ehSegredo,
    semeado_do_env: false,
    updated_by: opcoes.ator,
    updated_at: new Date().toISOString(),
  };

  if (opcoes.ehSegredo) {
    try {
      const envelope = encryptKey(valor, { aad: aadDaConfiguracao(chave) });
      linha.ciphertext = bufToBytea(envelope.ciphertext);
      linha.iv = bufToBytea(envelope.iv);
      linha.tag = bufToBytea(envelope.tag);
      linha.last4 = envelope.last4;
      linha.valor = null;
    } catch (erro) {
      return {
        ok: false,
        motivo: "sem_chave_de_cifra",
        detalhe: erro instanceof Error ? erro.message : String(erro),
      };
    }
  } else {
    linha.valor = valor;
    linha.ciphertext = null;
    linha.iv = null;
    linha.tag = null;
    linha.last4 = null;
  }

  try {
    // `upsert` e nunca `update`: a linha pode não existir ainda, e um `update`
    // que casa zero linhas devolve sucesso sem ter escrito nada — armadilha que
    // este projeto já pagou em `organizations`.
    const { error } = await createAdminClient().from("platform_config").upsert(linha, { onConflict: "chave" });
    if (error) return { ok: false, motivo: "banco_recusou", detalhe: error.message };
    invalidarConfiguracao(chave);
    return { ok: true };
  } catch (erro) {
    return {
      ok: false,
      motivo: "banco_recusou",
      detalhe: erro instanceof Error ? erro.message : String(erro),
    };
  }
}

/**
 * Volta ao padrão: apaga a linha e deixa o `.env` responder de novo (e poder
 * semear outra vez). É por isso que `delete` está no grant da tabela.
 */
export async function voltarAoAmbiente(chave: string): Promise<ResultadoDaEscrita> {
  try {
    const { error } = await createAdminClient().from("platform_config").delete().eq("chave", chave);
    if (error) return { ok: false, motivo: "banco_recusou", detalhe: error.message };
    invalidarConfiguracao(chave);
    return { ok: true };
  } catch (erro) {
    return {
      ok: false,
      motivo: "banco_recusou",
      detalhe: erro instanceof Error ? erro.message : String(erro),
    };
  }
}

/**
 * Grava SÓ se a chave ainda não tem linha, e devolve o valor que ficou — o
 * gravado agora ou o que outra escrita pôs antes. É para o valor que o próprio
 * sistema gera uma vez (o segredo de um webhook da instalação): duas primeiras
 * gravações simultâneas com `gravarPelaTela` deixariam vencer a última, e o
 * provedor assinaria com o segredo da outra.
 *
 * `null` quando nada ficou: sem chave de cifra (falha fechada, como a da tela)
 * ou banco que recusou.
 */
export async function gravarSeAusente(
  chave: string,
  valor: string,
  opcoes: { ehSegredo: boolean },
): Promise<string | null> {
  const linha: Record<string, unknown> = {
    chave,
    eh_segredo: opcoes.ehSegredo,
    semeado_do_env: false,
  };
  if (opcoes.ehSegredo) {
    try {
      const envelope = encryptKey(valor);
      linha.ciphertext = bufToBytea(envelope.ciphertext);
      linha.iv = bufToBytea(envelope.iv);
      linha.tag = bufToBytea(envelope.tag);
      linha.last4 = envelope.last4;
    } catch (erro) {
      aviso(chave, "sem chave de cifra, nada gravado", erro);
      return null;
    }
  } else {
    linha.valor = valor;
  }
  try {
    const { error } = await createAdminClient()
      .from("platform_config")
      .upsert(linha, { onConflict: "chave", ignoreDuplicates: true });
    if (error) {
      aviso(chave, "o banco recusou a gravação", error.message);
      return null;
    }
  } catch (erro) {
    aviso(chave, "a gravação falhou", erro);
    return null;
  }
  // Pode ter criado a linha (ou perdido a corrida para quem criou): esquece o memo
  // e lê FRESCO para devolver o valor que de fato ficou.
  invalidarConfiguracao(chave);
  const gravada = await lerLinha(chave, { fresca: true });
  if (gravada === null || gravada === "erro") return null;
  return emClaro(gravada)?.valor ?? null;
}

/** Reexportado para quem semeia a partir do `.env` na primeira leitura. */
export { precisaSemear };
