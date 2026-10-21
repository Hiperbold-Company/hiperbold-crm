/**
 * PERMISSÕES POR PERFIL — o catálogo (fonte única).
 *
 * O administrador da ORGANIZAÇÃO liga e desliga, por capacidade, o que Gerente,
 * Atendente e Leitor podem fazer. Administrador pode tudo e não aparece aqui:
 * ele é implícito em toda capacidade, e não há como tirá-lo.
 *
 * Três regras que este arquivo carrega e que ninguém mais repete:
 *
 *  1. `padrao` é EXATAMENTE o comportamento de antes desta feature. Uma
 *     organização que nunca abriu a tela de permissões opera como sempre.
 *  2. `liberavel` é o teto do que a tela oferece. Fora dele a célula é travada,
 *     com o motivo — e o motivo é sempre verdadeiro: ou a RLS/função do banco
 *     exige papel mais alto (liberar na rota não adiantaria, o banco recusaria),
 *     ou a tela que mostra a capacidade não tem porta para aquele perfil. Esta
 *     versão NÃO mexe em RLS nem em schema; só libera abaixo do piso antigo onde
 *     o banco já permite.
 *  3. A permissão vale no SERVIDOR (`lib/permissoes/servidor.ts`); a tela só
 *     esconde o botão (`usePermission`). Ler sempre pelo resolvedor
 *     (`lib/permissoes/resolver.ts`), nunca o jsonb cru.
 *
 * Os textos são pt-BR e são CHAVE do dicionário (`lib/i18n/dicionario.ts`): a
 * tela os passa por `t()`.
 */
import type { Role } from "@/lib/auth/types";

/** Os perfis que a tela configura. `admin` fica de fora: pode tudo, sempre. */
export const PAPEIS_CONFIGURAVEIS = ["manager", "agent", "viewer"] as const;
export type PapelConfiguravel = (typeof PAPEIS_CONFIGURAVEIS)[number];

export const CATEGORIAS_DE_PERMISSAO = [
  "Contatos",
  "Pipeline",
  "Chat",
  "Relatórios",
  "Automações",
] as const;
export type CategoriaDePermissao = (typeof CATEGORIAS_DE_PERMISSAO)[number];

/** A RLS ou a função do banco exige papel mais alto: liberar só na rota daria erro. */
export const MOTIVO_EXIGE_BANCO = "Exige mudança no banco — chega numa próxima versão";
/** O banco permitiria, mas a tela que mostra isto não tem porta para este perfil. */
export const MOTIVO_SEM_PORTA =
  "A tela disto ainda não abre para este perfil — chega numa próxima versão";
/** Decisão de escopo desta primeira versão, sem impedimento técnico. */
export const MOTIVO_FORA_DA_VERSAO = "Não disponível para este perfil nesta versão";

export interface Capacidade {
  readonly chave: string;
  readonly categoria: CategoriaDePermissao;
  readonly rotulo: string;
  readonly descricao: string;
  /** Quem tem hoje. Sempre ⊆ `liberavel`. */
  readonly padrao: readonly PapelConfiguravel[];
  /** Quem PODE receber. Fora disso a célula é travada. */
  readonly liberavel: readonly PapelConfiguravel[];
  /** Motivo da trava por perfil; ausente = `MOTIVO_EXIGE_BANCO`. */
  readonly motivoDaTrava?: Partial<Record<PapelConfiguravel, string>>;
}

export const CAPACIDADES = [
  {
    // POST /api/v1/contacts/export — lê `contacts` pela SESSÃO, e a policy de
    // select de contacts é de membro: o Leitor alcança o mesmo que já vê na lista.
    chave: "contatos.exportar",
    categoria: "Contatos",
    rotulo: "Exportar contatos (CSV)",
    descricao:
      "Baixar a lista de contatos em planilha. O arquivo leva dado pessoal para fora do sistema.",
    padrao: ["manager"],
    liberavel: ["manager", "agent", "viewer"],
  },
  {
    // POST /api/v1/contacts/bulk-delete — a policy de delete de contacts é
    // `agent`, MAS a função `fn_excluir_contatos_em_lote` (migration 0971)
    // recusa abaixo de `manager`. Liberar para o Atendente na rota daria
    // `insufficient_role` do banco: fica travado.
    chave: "contatos.excluir_em_lote",
    categoria: "Contatos",
    rotulo: "Excluir contatos em lote",
    descricao: "Apagar vários contatos de uma vez, com as conversas deles. Não tem como desfazer.",
    padrao: ["manager"],
    liberavel: ["manager"],
  },
  {
    // POST /api/v1/contacts/import e POST /api/v1/leads/import — insert em
    // contacts e crm_leads é `agent` na RLS.
    chave: "contatos.importar",
    categoria: "Contatos",
    rotulo: "Importar planilhas de contatos e de negócios",
    descricao: "Subir uma planilha para criar contatos ou negócios de uma vez.",
    padrao: ["manager", "agent"],
    liberavel: ["manager", "agent"],
  },
  {
    // POST /api/v1/leads/[id]/move, /win e /lose.
    chave: "negocios.mover",
    categoria: "Pipeline",
    rotulo: "Mover negócios entre etapas",
    descricao: "Arrastar o negócio no quadro e marcar como ganho ou perdido.",
    padrao: ["manager", "agent"],
    liberavel: ["manager", "agent"],
  },
  {
    // POST /api/v1/leads/[id]/activities e /api/v1/leads/[id]/itens*.
    chave: "negocios.registrar",
    categoria: "Pipeline",
    rotulo: "Registrar eventos e produtos no negócio",
    descricao: "Anotar o que aconteceu na ficha do negócio e mexer nos produtos dele.",
    padrao: ["manager", "agent"],
    liberavel: ["manager", "agent"],
  },
  {
    // POST /api/v1/pipelines, PATCH/DELETE /pipelines/[id], POST /stages,
    // PATCH/DELETE /stages/[stageId]. A RLS de crm_pipelines/crm_stages é manager.
    chave: "funis.editar",
    categoria: "Pipeline",
    rotulo: "Criar e editar funis e etapas",
    descricao: "Criar funil, renomear, arquivar e excluir, e mexer nas etapas.",
    padrao: ["manager"],
    liberavel: ["manager"],
  },
  {
    // POST /api/v1/messages e POST /api/v1/conversations/[id]/media.
    chave: "chat.responder",
    categoria: "Chat",
    rotulo: "Responder conversas",
    descricao: "Escrever e mandar mensagens, áudios e arquivos para o cliente.",
    padrao: ["manager", "agent"],
    liberavel: ["manager", "agent"],
  },
  {
    // GET /api/v1/metrics/lost — lê com o client admin e organization_id
    // explícito; o painel mora em Desempenho, tela aberta a todos.
    chave: "relatorios.perdas",
    categoria: "Relatórios",
    rotulo: "Ver o relatório de perdas",
    descricao: "Por que os negócios foram perdidos, em quantidade e valor, do funil inteiro.",
    padrao: ["manager"],
    liberavel: ["manager", "agent"],
    motivoDaTrava: { viewer: MOTIVO_FORA_DA_VERSAO },
  },
  {
    // GET /api/v1/ads/meta/campaigns e /accounts. A tela /app/ads/meta só tem
    // porta no menu para gerente (`lib/navigation/catalogo.ts`), então liberar
    // para o Atendente abriria uma rota sem tela: fica travado nesta versão.
    chave: "relatorios.anuncios",
    categoria: "Relatórios",
    rotulo: "Ver o resultado dos anúncios (Meta Ads)",
    descricao: "Quanto custou cada resultado das campanhas, com orçamento da empresa inteira.",
    padrao: ["manager"],
    liberavel: ["manager"],
    motivoDaTrava: { agent: MOTIVO_SEM_PORTA, viewer: MOTIVO_SEM_PORTA },
  },
  {
    // Escritas de /api/v1/automation-rules* e /api/v1/webhook-sources*. RLS manager.
    chave: "automacoes.gerenciar",
    categoria: "Automações",
    rotulo: "Criar e editar automações e webhooks",
    descricao: "Regras que agem sozinhas e as entradas de leads de sites e formulários.",
    padrao: ["manager"],
    liberavel: ["manager"],
  },
] as const satisfies readonly Capacidade[];

export type ChaveDePermissao = (typeof CAPACIDADES)[number]["chave"];

export const CHAVES_DE_PERMISSAO: readonly ChaveDePermissao[] = CAPACIDADES.map((c) => c.chave);

const POR_CHAVE: ReadonlyMap<string, Capacidade> = new Map(CAPACIDADES.map((c) => [c.chave, c]));

export function capacidade(chave: ChaveDePermissao): Capacidade {
  return POR_CHAVE.get(chave)!;
}

export function ehChaveDePermissao(valor: string): valor is ChaveDePermissao {
  return POR_CHAVE.has(valor);
}

export function motivoDaTrava(chave: ChaveDePermissao, papel: PapelConfiguravel): string {
  return capacidade(chave).motivoDaTrava?.[papel] ?? MOTIVO_EXIGE_BANCO;
}

const RANK: Record<PapelConfiguravel, number> = { viewer: 1, agent: 2, manager: 4 };

/**
 * O menor papel que PODE ter a capacidade — o piso que a rota pede ao
 * `requireRole` antes de consultar a escolha da organização.
 */
export function pisoDaPermissao(chave: ChaveDePermissao): Role {
  const [menor] = [...capacidade(chave).liberavel].sort((a, b) => RANK[a] - RANK[b]);
  return menor ?? "admin";
}

/**
 * O que é SÓ do administrador e a tela mostra como informação, com cadeado.
 * Não é configurável nesta versão — e não é por esquecimento: são as portas
 * que mudam quem entra, o que custa dinheiro ou o que responde a direito legal.
 */
export const SO_ADMINISTRADOR = [
  {
    rotulo: "Equipe e convites",
    descricao: "Convidar pessoas, trocar o perfil de alguém e tirar acesso.",
  },
  { rotulo: "Conexão do WhatsApp", descricao: "Conectar, trocar e desconectar os números." },
  { rotulo: "Agentes de IA", descricao: "Publicar agentes e mexer nas credenciais de IA." },
  { rotulo: "Plano e cobrança", descricao: "Trocar de plano e ver as faturas." },
  { rotulo: "LGPD", descricao: "Atender pedidos de dados e anonimizar contatos." },
  {
    rotulo: "Marca e chaves de API",
    descricao: "Logo, cores e as chaves que integram outros sistemas.",
  },
] as const;
