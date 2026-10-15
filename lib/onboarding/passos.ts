/**
 * OS PASSOS DO WIZARD — uma definição só.
 *
 * Eram três listas que discordavam entre si: a ORDEM vivia numa cascata de
 * `if`s no roteador, os RÓTULOS numa lista fixa no indicador de progresso, e o
 * RESUMO final numa terceira lista. O resultado, em 100% das instalações pelo
 * kit (onde a integração de loja vem desligada):
 *
 *  - o indicador mostrava um passo "Loja" que não existia naquela instalação;
 *  - ele aparecia CONCLUÍDO enquanto a pessoa estava no passo seguinte, porque
 *    "feito" era só "índice menor que o atual";
 *  - e a tela final listava "Loja Nuvemshop (pulado)" — o wizard acusando o
 *    usuário de ter deixado de fazer uma tela que nunca lhe foi oferecida.
 *
 * Aqui, quem decide se um passo EXISTE é o próprio passo, e a mesma resposta
 * alimenta o roteador, o indicador e o resumo. Um passo que não se aplica não
 * aparece em lugar nenhum — nem como pendência, nem como culpa.
 */
import type { OnboardingState } from "@/lib/schemas/onboarding";

export interface PassoDoOnboarding {
  /** Segmento da rota em `app/onboarding/<segmento>`. */
  segmento: string;
  /** O nome da PEÇA que a pessoa está montando, não o nome do sistema. */
  rotulo: string;
  /**
   * O passo existe nesta instalação? Integração desligada não vira passo
   * fantasma.
   */
  existe: (ctx: ContextoDoPasso) => boolean;
  /** Já foi resolvido? (inclusive quando a pessoa escolheu pular) */
  cumprido: (state: OnboardingState) => boolean;
  /** Foi resolvido de verdade, ou a pessoa pulou? Alimenta o resumo final. */
  pulado: (state: OnboardingState) => boolean;
}

export interface ContextoDoPasso {
  /** A integração de loja está ligada nesta instalação? */
  lojaLigada: boolean;
  /**
   * Esta organização precisa pagar o plano antes de configurar? Vem de
   * `precisaPagarAntesDeConfigurar` (`lib/onboarding/precisa-pagar.ts`), a mesma noção de
   * `app/app/layout.tsx`. Verdadeiro só enquanto o pagamento não foi confirmado.
   */
  precisaPagar: boolean;
  /**
   * O caminho "paga primeiro" vale nesta instalação? É a compra pelo próprio cliente LIGADA
   * (`compraPeloClienteDisponivel`). Ligada, o wizard inteiro se reduz ao pagamento: o aceite dos
   * Termos acontece na própria tela de pagamento e tudo o que era configuração (WhatsApp, treinar,
   * funil, testar, equipe) virou item da tela Início. Desligada (instalação própria, CI), o wizard
   * completo segue exatamente como era.
   */
  pagarPrimeiro: boolean;
}

/** Um passo marcado no estado — com ou sem `skipped`. */
function marcado(valor: unknown): boolean {
  return Boolean(valor);
}

function foiPulado(valor: { skipped?: boolean } | undefined): boolean {
  return Boolean(valor?.skipped);
}

export const PASSOS: readonly PassoDoOnboarding[] = [
  {
    segmento: "welcome",
    rotulo: "Seu negócio",
    // Caminho "paga primeiro": o aceite dos Termos é dado na tela de pagamento (e, vindo do cadastro
    // por e-mail, já foi dado no formulário); o que o negócio faz passa a ser item do Início.
    existe: (ctx) => !ctx.pagarPrimeiro,
    // O que marca o passo como cumprido é o ACEITE (`accepted_at`, gravado por `acceptWelcome`), não a mera
    // existência de `welcome`: a tela Início grava `welcome.o_que_faz` sozinho (`atualizarPerfilDaEmpresa`), e
    // esse `welcome` parcial não pode contar como "boas-vindas feitas" no wizard antigo.
    cumprido: (s) => marcado(s.welcome?.accepted_at),
    pulado: () => false,
  },
  {
    segmento: "plano",
    // Hiperbold (15/10/2026): o cliente novo paga ANTES de configurar o CRM. O passo NÃO se pula e
    // não se "marca": ele existe enquanto o pagamento é exigido e some (= cumprido) quando a
    // confirmação chega — contrato ativo, plano liberado pelo admin, compra desligada ou modo que
    // não cobra nunca o mostram. Por isso `cumprido` é sempre falso: quem o resolve é o banco
    // (Pix/cartão confirmados pelo webhook do Asaas), nunca um botão da tela.
    rotulo: "Seu plano",
    existe: (ctx) => ctx.precisaPagar,
    cumprido: () => false,
    pulado: () => false,
  },
  {
    segmento: "connect-whatsapp",
    // O telefone é a primeira peça concreta do funcionário, e é o passo que
    // pede o celular na mão — o instalador já avisa para deixá-lo aberto.
    rotulo: "O telefone dele",
    existe: (ctx) => !ctx.pagarPrimeiro,
    cumprido: (s) => marcado(s.whatsapp),
    pulado: (s) => foiPulado(s.whatsapp),
  },
  {
    segmento: "connect-nuvemshop",
    rotulo: "Sua loja",
    existe: (ctx) => ctx.lojaLigada && !ctx.pagarPrimeiro,
    cumprido: (s) => marcado(s.nuvemshop),
    pulado: (s) => foiPulado(s.nuvemshop),
  },
  {
    segmento: "setup-ai",
    rotulo: "Treinar",
    existe: (ctx) => !ctx.pagarPrimeiro,
    cumprido: (s) => marcado(s.ai),
    pulado: (s) => foiPulado(s.ai),
  },
  {
    segmento: "funil",
    // O quadro vem DEPOIS de treinar de propósito: a sugestão sai da chave que a
    // pessoa acabou de confirmar funcionando, e é o mesmo cérebro que vai
    // atender. Pedir o quadro antes obrigaria a montá-lo no escuro.
    rotulo: "Onde ele organiza",
    existe: (ctx) => !ctx.pagarPrimeiro,
    cumprido: (s) => marcado(s.funil),
    pulado: (s) => foiPulado(s.funil),
  },
  {
    segmento: "testar",
    // O wizard terminava entregando a pessoa num inbox vazio. Ver o
    // funcionário responder ANTES de acabar é o que transforma "configurei um
    // sistema" em "contratei alguém" — e é onde o erro aparece antes do
    // primeiro cliente real, não depois.
    rotulo: "Ver ele atender",
    existe: (ctx) => !ctx.pagarPrimeiro,
    cumprido: (s) => marcado(s.teste),
    pulado: (s) => foiPulado(s.teste),
  },
  {
    segmento: "invite-team",
    rotulo: "Quem trabalha com ele",
    existe: (ctx) => !ctx.pagarPrimeiro,
    cumprido: (s) => marcado(s.team),
    pulado: (s) => foiPulado(s.team),
  },
] as const;

/** Os passos que existem NESTA instalação, na ordem. */
export function passosVisiveis(ctx: ContextoDoPasso): PassoDoOnboarding[] {
  return PASSOS.filter((p) => p.existe(ctx));
}

/**
 * O primeiro passo ainda não resolvido — ou `null` quando não falta nenhum.
 * É a única definição de ordem do wizard.
 */
export function proximoPasso(
  state: OnboardingState,
  ctx: ContextoDoPasso,
): PassoDoOnboarding | null {
  return passosVisiveis(ctx).find((p) => !p.cumprido(state)) ?? null;
}

export interface ItemDoResumo {
  segmento: string;
  rotulo: string;
  feito: boolean;
  pulado: boolean;
}

/**
 * O resumo final. Só lista o que a pessoa realmente encontrou pela frente —
 * um passo que não existe nesta instalação não vira linha, muito menos linha
 * marcada como pulada.
 */
export function resumoDoOnboarding(
  state: OnboardingState,
  ctx: ContextoDoPasso,
): ItemDoResumo[] {
  return passosVisiveis(ctx).map((p) => ({
    segmento: p.segmento,
    rotulo: p.rotulo,
    feito: p.cumprido(state) && !p.pulado(state),
    pulado: p.pulado(state),
  }));
}
