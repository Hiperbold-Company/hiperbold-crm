/**
 * O ÚNICO lugar do sistema que pode conhecer a diferença entre os canais.
 *
 * Feature nenhuma pergunta *com quem* falamos — pergunta *o que o canal permite*
 * (invariante 1 de `docs/doctrine/restricao-de-canal.md`). Cada capability abaixo
 * nasce de uma diferença real e medida entre WAHA e Meta Cloud; capability que
 * ninguém consome é código morto, e o teste de matriz reprova.
 */
import type { AnexosDeSaida, ChannelCapabilities, ChannelProvider, ProviderDeMensagem } from "./types";

export type { AnexosDeSaida, ChannelProvider, ChannelCapabilities, ProviderDeMensagem };

/**
 * A matriz descreve o que um canal de MENSAGEM permite — por isso a chave é
 * `ProviderDeMensagem`, não `ChannelProvider`. Perguntar a uma linha de voz se
 * ela manda texto fora da janela de 24h é erro de categoria, e responder
 * qualquer coisa (inclusive tudo `false`) faria a pergunta parecer legítima.
 * `capabilitiesOf` segue falhando fechado para quem não está aqui.
 */
/** O que os canais de WhatsApp enviam: tudo que o composer oferece. */
const TODOS_OS_ANEXOS: AnexosDeSaida = { imagem: true, video: true, audio: true, documento: true, contato: true };

export const CHANNEL_CAPABILITIES: Record<ProviderDeMensagem, ChannelCapabilities> = {
  // Auto-restrição: falo quando quiser, mas o WhatsApp me bane se eu abusar.
  waha: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    // Não há WABA por trás: não existe definição aprovada para gerir.
    canManageTemplates: false,
    banRisk: true,
    minIntervalMs: null,
    voiceNote: "server-convert",
    groups: "full",
    costPerMessage: false,
    alteraMensagemEnviada: true,
    anexosDeSaida: TODOS_OS_ANEXOS,
    // WhatsApp comum por QR: botão e lista não têm envio estável fora da API
    // oficial, então as opções saem como texto numerado.
    interactive: "none",
    // É a linha que conversa com um APARELHO pareado: a agenda salva no
    // celular está lá dentro, e o `contacts/all` a devolve paginada (#2736).
    phonebook: true,
  },
  // Hetero-restrição: não me banem, mas a Meta me proíbe e me cobra.
  meta_cloud: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    // A Graph API cria e edita definições; o repo hoje só ESPELHA, e é essa
    // lacuna que a capability torna visível em vez de deixar implícita.
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    anexosDeSaida: TODOS_OS_ANEXOS,
    // A Cloud API desenha botões (até 3) e lista (até 10) dentro da janela de
    // 24h e devolve o id da opção tocada (`button_reply`/`list_reply`).
    interactive: "native",
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
  },
  // Mesma hetero-restrição do canal oficial, por baixo: é um BSP: a WABA é da
  // Meta, os templates são aprovados pela Meta e a janela de 24h é da Meta. O
  // intermediário muda o TRANSPORTE (quem endereça, como se autentica), não o
  // que o WhatsApp permite — e capability descreve o permitido, não o encanamento.
  //
  // As duas diferenças reais, medidas na doc do provider, não na intuição:
  //
  //  - `voiceNote: "opus-only"`. O provider tem um `voiceNote: true` no envio,
  //    mas exige ogg/opus mono explicitamente e NÃO converte — mesma restrição
  //    do canal oficial. Ler o campo booleano como "ele resolve para mim" é o
  //    erro que manda mp3 e entrega anexo de música.
  //  - `groups: "limited"`. Existe API de grupos, mas só em plano de uso e só
  //    para números fora de coexistência. Capability é o que a instalação MÉDIA
  //    pode fazer; prometer "full" aqui quebraria em quem não paga o plano.
  // `freeformOutsideWindow: false` está MEDIDO, não deduzido. A API aceita o
  // envio livre (200 + wamid) e a Meta recusa a ENTREGA depois, pelo webhook:
  //
  //   131047 Re-engagement message — "The 24-hour customer service window for
  //   this contact is closed. Send an approved template to re-open the
  //   conversation, or wait for the contact to message you first."
  //
  // O detalhe que engana: mandar um template NÃO abre a janela. Só o cliente
  // abre, respondendo. Quem ler o 200 como "enviado" acha que funciona.
  zernio_social: {
    freeformOutsideWindow: false,
    requiresTemplates: false,
    canManageTemplates: false,
    banRisk: false,
    minIntervalMs: 1000,
    voiceNote: "server-convert",
    groups: "none",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    anexosDeSaida: TODOS_OS_ANEXOS,
    // Instagram/Messenger intermediado: sem envio de opções neste adapter.
    interactive: "none",
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
  },
  // Instagram Direct e Messenger pela Meta, sem intermediário (0984). A mesma
  // física do canal social intermediado: só se responde dentro de 24h da
  // última mensagem do cliente (HUMAN_AGENT, 7 dias, fica fora por ora), não há
  // definição aprovada, não há grupo e não há risco de banimento por volume.
  //
  // O envio deste canal hoje é TEXTO e IMAGEM (o adapter recusa o resto), então
  // a matriz diz isso: sem voz, vídeo, áudio, documento nem cartão de contato.
  // Declarar o que o adapter não cumpre faria a tela oferecer um anexo que
  // volta como falha depois do clique.
  meta_social: {
    freeformOutsideWindow: false,
    requiresTemplates: false,
    canManageTemplates: false,
    banRisk: false,
    minIntervalMs: 1000,
    voiceNote: "none",
    groups: "none",
    costPerMessage: false,
    alteraMensagemEnviada: false,
    anexosDeSaida: { imagem: true, video: false, audio: false, documento: false, contato: false },
    // O adapter deste canal envia texto e imagem; opções viram texto numerado.
    interactive: "none",
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
  },
  zernio: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    anexosDeSaida: TODOS_OS_ANEXOS,
    // A WABA é da Meta e permite opções, mas o adapter deste intermediário fala
    // outro dialeto (`message` no corpo) e não monta `interactive`. Declarar
    // `native` sem o adapter cumprir faria o botão sumir no envio; até lá,
    // texto numerado, que o contato lê igual.
    interactive: "none",
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
  },
  // Parceiro homologado pela Meta que espelha a Cloud API (recorte do #1130):
  // a WABA, a janela de 24h e o custo são da Meta. O parceiro muda o TRANSPORTE
  // (host, token), não o que o WhatsApp permite — então o perfil é o do canal
  // oficial.
  //
  // `canManageTemplates: true`: os modelos são os da Cloud API e o parceiro
  // expõe os mesmos endpoints de catálogo; a tela cria e sincroniza por lá.
  // `requiresTemplates: true` porque a regra da Meta é real: fora da janela de
  // 24h, só modelo aprovado passa.
  datafy: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    anexosDeSaida: TODOS_OS_ANEXOS,
    // Espelha a Cloud API e reusa o MESMO montador de corpo do adapter oficial
    // (`interactivePayload` de adapters/meta-cloud.ts): opções nativas.
    interactive: "native",
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
  },
  // A mesma física do canal por QR, por outro transporte: a instância é um
  // aparelho pareado ao WhatsApp comum, sem WABA por trás. Não existe janela de
  // 24h nem definição aprovada, e o risco é o banimento por volume ou padrão,
  // então throttle, warm-up e cap armam.
  //
  // `voiceNote: "server-convert"`: o envio de mídia do tipo mensagem de voz
  // aceita mp3/ogg e o servidor entrega como bolha de voz, sem precisarmos
  // transcodificar para opus antes.
  uazapi: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    canManageTemplates: false,
    banRisk: true,
    minIntervalMs: null,
    voiceNote: "server-convert",
    groups: "full",
    costPerMessage: false,
    // O adapter ainda não implementa editMessage/revokeMessage: declarar
    // false aqui é o que impede a tela de oferecer editar/apagar sem o
    // canal saber cumprir.
    alteraMensagemEnviada: false,
    anexosDeSaida: TODOS_OS_ANEXOS,
    // Aparelho pareado, sem WABA: opções saem como texto numerado (o inbound
    // deste canal também não trata resposta de botão).
    interactive: "none",
    // Aparelho pareado, mas o adapter da UAZAPI ainda não lê a agenda do
    // celular: `true` aqui seria um botão que só falha.
    phonebook: false,
  },
};

/**
 * O que assumir quando o banco NÃO diz qual é o canal — só quando a linha de
 * `channel_sessions` não pôde ser lida (a coluna é `not null default 'waha'`,
 * então uma sessão que existe sempre responde).
 *
 * Espelha o default da coluna de propósito: é o que mantém o comportamento
 * idêntico ao dos literais que as Tasks 4b/5 deixaram no código. E é o canal
 * CONSERVADOR dos dois — banRisk armado, throttle e warm-up ligados; errar para
 * o lado do meta_cloud desarmaria o anti-ban num número que pode ser banido.
 */
export const DEFAULT_CHANNEL_PROVIDER: ChannelProvider = "waha";

/**
 * Constantes nomeadas dos providers. Existem para que nenhum arquivo fora deste
 * módulo precise escrever a string — é o que o `scripts/lint-channels.ts` cobra.
 */
export const CHANNEL_PROVIDER_WAHA: ChannelProvider = "waha";
export const CHANNEL_PROVIDER_META: ChannelProvider = "meta_cloud";
export const CHANNEL_PROVIDER_SOCIAL: ChannelProvider = "zernio_social";
export const CHANNEL_PROVIDER_ZERNIO: ChannelProvider = "zernio";
/** Instância de WhatsApp num servidor de API não oficial, conectada por token. */
export const CHANNEL_PROVIDER_UAZAPI: ChannelProvider = "uazapi";
/** Parceiro que espelha a Cloud API — canal opcional da instalação, desligado por padrão. */
export const CHANNEL_PROVIDER_DATAFY: ChannelProvider = "datafy";
/** Chamada de voz WhatsApp (spec 18). Não transporta mensagem — ver abaixo. */
export const CHANNEL_PROVIDER_WACALLS: ChannelProvider = "wacalls";
/** Instagram Direct e Messenger pela conexão oficial e direta com a Meta. */
export const CHANNEL_PROVIDER_META_SOCIAL: ChannelProvider = "meta_social";

/**
 * Os providers de REDE SOCIAL (Instagram Direct, Messenger) — o intermediado e
 * o oficial direto. Existe porque a tela de números de WhatsApp lista as
 * sessões de mensagem e precisa deixar estas de fora: uma conta do Instagram
 * não é "número", e os botões de lá (Reconectar por QR, Excluir pelo
 * transporte do WhatsApp) não servem para ela. Cada uma tem a própria aba.
 */
export const PROVIDERS_SOCIAIS = ["zernio_social", "meta_social"] as const satisfies readonly ProviderDeMensagem[];

/** `true` quando a sessão é de rede social, não de WhatsApp. */
export function ehCanalSocial(provider: string | null | undefined): boolean {
  return (PROVIDERS_SOCIAIS as readonly string[]).includes(provider ?? "");
}

/**
 * O provider em que o NÚMERO é a conexão: pareado por QR, a linha só vira
 * conexão quando um aparelho lê o código. A linha morta (`FAILED`/`STOPPED`)
 * sem número, ali, é QR que ninguém leu e não ocupa a vaga do plano (#3416);
 * nos outros provedores o número não identifica a conexão. É a mesma régua dos
 * gatilhos `fn_trava_canais_do_plano` e `fn_vaga_ao_reviver_canal`.
 */
export const PROVIDER_EM_QUE_O_NUMERO_E_A_CONEXAO: ChannelProvider = CHANNEL_PROVIDER_WAHA;

/**
 * Os providers por onde MENSAGEM entra e sai — a única lista que responde
 * "este canal serve para conversar?".
 *
 * Existe porque `channel_sessions` deixou de ser só a tabela dos transportes de
 * texto quando a voz entrou nela, e ~39 leituras daquela tabela não filtram
 * provider nenhum: elas dizem "canal" e querem dizer "canal de mensagem". Sem
 * esta lista, uma organização que pareia voz vê a linha de voz virar opção no
 * seletor "Número conectado", nascer amarrada ao primeiro agente publicado,
 * contar como canal conectado no retrato da instalação e ser escolhida por uma
 * automação para mandar texto — por um canal que não manda texto.
 *
 * `satisfies` e não anotação solta: um provider novo que não seja de mensagem
 * precisa ser DECIDIDO aqui, não esquecido.
 */
export const PROVIDERS_DE_MENSAGEM = [
  "waha",
  "meta_cloud",
  "zernio",
  "uazapi",
  "zernio_social",
  "datafy",
  "meta_social",
] as const satisfies readonly ProviderDeMensagem[];

/**
 * Os providers que alcançam um APARELHO: o endereço é o TELEFONE.
 *
 * É um recorte de `PROVIDERS_DE_MENSAGEM`, e a diferença é a das REDES SOCIAIS
 * (`zernio_social`): o Instagram e o Facebook só falam com quem já escreveu, o
 * contato de lá é outro endereço (handle) e não existe telefone a discar. Quem
 * tem um número na mão e escolhe a sessão social escolheu um canal que NÃO
 * alcança o destino — e o envio fora da janela de 24h é recusado (#3358,
 * medido: "O canal recusou o envio. Confira a conexão em Conexões.").
 *
 * `satisfies` sobre o recorte declara a relação entre as duas listas: um
 * provider que não seja de mensagem não pode entrar aqui, e um provider social
 * que apareça nesta lista reprova em compilação, não em produção.
 */
export const PROVIDERS_DE_TELEFONE = [
  "waha",
  "meta_cloud",
  "zernio",
  "datafy",
] as const satisfies readonly Exclude<(typeof PROVIDERS_DE_MENSAGEM)[number], "zernio_social">[];

/**
 * `true` quando a linha de `channel_sessions` é um canal de mensagem.
 *
 * Aceita `string | null | undefined` de propósito: quem chama está lendo uma
 * coluna do banco, que pode trazer um provider mais novo que este código (um
 * clone que atualizou o schema antes da imagem). Provider desconhecido responde
 * `false` — falhar fechado aqui significa "não use este canal para mandar
 * recado", que é o erro barato; o caro é mandar por um canal que não entrega.
 * A coluna é `not null default 'waha'`, então `null` só aparece quando a linha
 * não pôde ser lida, e aí também não há canal a usar.
 */
export function transportaMensagem(provider: string | null | undefined): boolean {
  return (PROVIDERS_DE_MENSAGEM as readonly string[]).includes(provider ?? "");
}

/**
 * Os providers que ESTE código conhece e que, sabidamente, não conversam.
 *
 * A diferença para `!transportaMensagem(p)` é a que separa "categoria" de
 * "falha", e ela decide o que o vigia de conexão faz com a linha:
 *
 *   - `wacalls` está aqui: ignorar em silêncio é o certo, e um aviso por sessão
 *     de voz a cada minuto seria ruído perpétuo.
 *   - um provider que o CHECK do banco já aceita e esta imagem ainda não conhece
 *     (o clone que aplicou o baseline antes de puxar a imagem nova) NÃO está
 *     aqui — ele tem de fazer barulho, porque uma conexão sem vigia e sem
 *     rastro é exatamente o buraco mudo que ninguém descobre.
 *
 * `transportaMensagem` responde `false` para os dois, e é o que se quer lá: na
 * hora de escolher por onde mandar recado, o desconhecido é tão inútil quanto a
 * voz. Aqui a pergunta é outra.
 */
export const PROVIDERS_SEM_MENSAGEM = ["wacalls"] as const;

/**
 * Erro de COMPILAÇÃO enquanto sobrar provider fora das duas listas. Provider
 * novo obriga a decidir se ele conversa — esquecer não é uma opção disponível.
 */
type ProviderNaoClassificado = Exclude<
  ChannelProvider,
  (typeof PROVIDERS_DE_MENSAGEM)[number] | (typeof PROVIDERS_SEM_MENSAGEM)[number]
>;
const _todoProviderFoiClassificado: ProviderNaoClassificado extends never ? true : never = true;
void _todoProviderFoiClassificado;

/** `true` só para provider conhecido cuja natureza não é mensagem. */
export function canalConhecidoSemMensagem(provider: string | null | undefined): boolean {
  return (PROVIDERS_SEM_MENSAGEM as readonly string[]).includes(provider ?? "");
}

/**
 * Como uma CAMPANHA fala por este canal: texto livre (`text`), modelo aprovado
 * (`template`) ou não fala (`null`).
 *
 * Campanha é contato que a empresa inicia — quase sempre fora das 24 horas da
 * última mensagem do cliente. Por isso a pergunta é `freeformOutsideWindow`, e
 * não "aceita texto": o número oficial aceita texto, mas só dentro da janela.
 * Canal que nem manda texto fora da janela nem tem modelo (as redes sociais)
 * não serve para campanha nenhuma.
 *
 * Tolerante como `transportaMensagem`: provider que esta imagem não conhece
 * responde `null` em vez de lançar — a tela de campanha lista conexões, e um
 * throw apagaria a lista inteira.
 */
export function modoDeCampanhaDoCanal(provider: string | null | undefined): "text" | "template" | null {
  if (!transportaMensagem(provider)) return null;
  try {
    const caps = capabilitiesOf(provider as ProviderDeMensagem);
    if (caps.freeformOutsideWindow) return "text";
    if (caps.requiresTemplates) return "template";
    return null;
  } catch {
    return null;
  }
}

/**
 * O canal corre risco de banimento por volume (número por QR)? É o que liga o
 * aquecimento e o teto anti-ban do ritmo. Desconhecido responde `true`: no
 * ritmo, errar para o lado de mandar devagar é o erro barato.
 */
export function canalTemRiscoDeBanimento(provider: string | null | undefined): boolean {
  if (!transportaMensagem(provider)) return true;
  try {
    return capabilitiesOf(provider as ProviderDeMensagem).banRisk;
  } catch {
    return true;
  }
}

export function capabilitiesOf(provider: ChannelProvider): ChannelCapabilities {
  const caps = CHANNEL_CAPABILITIES[provider as ProviderDeMensagem];
  // Fail-closed: provider fora da matriz não herda o default do WAHA. O tipo
  // barra em compilação; isto barra o que vem do banco em runtime.
  if (!caps) throw new Error(`unknown_channel_provider: ${provider}`);
  return caps;
}

/**
 * O que a tela de conversa OFERECE para anexar, pelo canal da conversa.
 *
 * Provider desconhecido ou ausente (conversa sem canal lido, clone com
 * provider mais novo que esta imagem) oferece TUDO — é o comportamento de antes
 * desta capability, e o adapter segue recusando o que não cumpre.
 */
export function anexosOferecidos(provider: string | null | undefined): AnexosDeSaida & { voz: boolean } {
  if (!transportaMensagem(provider)) return { ...TODOS_OS_ANEXOS, voz: true };
  const c = capabilitiesOf(provider as ChannelProvider);
  return { ...c.anexosDeSaida, voz: c.voiceNote !== "none" && c.anexosDeSaida.audio };
}

/**
 * Teto do texto de UMA mensagem, em bytes UTF-8, quando o canal tem um menor
 * que o do WhatsApp — hoje o Direct do Instagram (1000 bytes, o mesmo teto que
 * o adapter do canal social usa para cortar o texto e o da resposta privada,
 * `TETO_DO_TEXTO_DA_RESPOSTA_BYTES`). `null` = o canal não declara teto aqui.
 *
 * Quem envia sozinho (as automações) confere ANTES de mandar: o adapter
 * dividiria o texto em pedaços, e uma mensagem com opções numeradas partida no
 * meio não serve para responder.
 */
export const TETO_DO_TEXTO_DO_DIRECT_BYTES = 1000;

export function tetoDoTextoEmBytes(provider: string | null | undefined): number | null {
  return ehCanalSocial(provider) ? TETO_DO_TEXTO_DO_DIRECT_BYTES : null;
}

/** O canal desenha as opções de verdade (`interactive: "native"`)? Provider desconhecido: não. */
export function opcoesNativas(provider: string | null | undefined): boolean {
  return (
    transportaMensagem(provider) &&
    capabilitiesOf(provider as ChannelProvider).interactive === "native"
  );
}
