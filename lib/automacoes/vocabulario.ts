/**
 * Vocabulário das AUTOMAÇÕES em português — rótulos de campo, operador, ação e
 * gatilho, e as frases que o card, o histórico da execução e o publish leem.
 *
 * Puro e sem `t()`: a tela passa cada rótulo pelo `t()` (o dicionário tem as
 * versões em inglês e espanhol); o histórico, que é texto do servidor, fica em
 * português como o resto de `eventos-legiveis.ts`.
 */
import type { NovaConditionCheck, QuestionValidation } from "@/lib/followup/graph-schema";

import type {
  AutomacaoTriggerKind,
  EventoDeAgendamento,
  ModoDaPalavraChave,
  CrmAction,
  CrmActionType,
  FieldOp,
  FieldRef,
  OperadorDeCampo,
} from "./schemas";

/** Nome de etapa/funil/pessoa a partir do id — quem tem a lista injeta. */
export interface NomesDaAutomacao {
  etapa?: (id: string) => string | null;
  funil?: (id: string) => string | null;
  pessoa?: (id: string) => string | null;
}

export const CAMPOS_PADRAO_DO_CONTATO: Record<Extract<FieldRef, { scope: "contact" }>["key"], string> = {
  name: "Nome do contato",
  email: "E-mail do contato",
  phone_number: "Telefone do contato",
  birthdate: "Data de nascimento",
  tags: "Tags do contato",
};

export const CAMPOS_PADRAO_DO_NEGOCIO: Record<Extract<FieldRef, { scope: "lead" }>["key"], string> = {
  title: "Título do negócio",
  value_cents: "Valor do negócio (centavos)",
  stage_id: "Etapa do negócio",
  pipeline_id: "Funil do negócio",
  status: "Situação do negócio",
  owner_user_id: "Responsável do negócio",
  source: "Origem do negócio",
  tags: "Tags do negócio",
  expected_close_date: "Previsão de fechamento",
};

export const OPERADORES: Record<OperadorDeCampo, string> = {
  eq: "é igual a",
  neq: "é diferente de",
  contains: "contém",
  not_contains: "não contém",
  starts_with: "começa com",
  has_value: "tem valor",
  empty: "está vazio",
  gt: "é maior que",
  gte: "é maior ou igual a",
  lt: "é menor que",
  lte: "é menor ou igual a",
};

export const OPERADORES_SEM_VALOR: readonly OperadorDeCampo[] = ["has_value", "empty"];

export const ACOES_DE_CRM: Record<CrmActionType, string> = {
  create_deal: "Criar negócio",
  move_deal: "Mover negócio",
  win_deal: "Marcar como ganho",
  lose_deal: "Marcar como perdido",
  add_tags: "Adicionar tags",
  remove_tags: "Remover tags",
  set_owner: "Definir responsável",
  notify: "Avisar a equipe",
  create_task: "Criar tarefa",
  add_note: "Adicionar nota",
};

export const OPERACOES_DE_CAMPO: Record<FieldOp["op"], string> = {
  set: "Definir",
  clear: "Limpar",
  append: "Acrescentar ao texto",
  increment: "Somar ao número",
};

export const GATILHOS_DA_AUTOMACAO: Record<AutomacaoTriggerKind, string> = {
  manual: "Manual (iniciar para um contato)",
  lead_created: "Negócio criado",
  stage_entered: "Entrou na etapa",
  message_received: "Mensagem recebida",
  tag_added: "Tag adicionada",
  appointment: "Agendamento",
  birthday: "Aniversário do contato",
  date_field: "Data de um campo do negócio",
  no_reply: "Contato sem resposta",
  case_opened: "Caso aberto na Central",
};

/** Como a palavra-chave da mensagem recebida é comparada. */
export const MODOS_DA_PALAVRA_CHAVE_ROTULOS: Record<ModoDaPalavraChave, string> = {
  any: "Qualquer mensagem",
  contains: "Contém a palavra ou frase",
  equals: "É exatamente",
  starts_with: "Começa com",
};

/** Os acontecimentos da agenda do gatilho "Agendamento". */
export const EVENTOS_DE_AGENDAMENTO_ROTULOS: Record<EventoDeAgendamento, string> = {
  created: "Horário marcado",
  confirmed: "Horário confirmado",
  rescheduled: "Horário remarcado",
  cancelled: "Horário cancelado",
  completed: "Contato compareceu",
  no_show: "Contato faltou",
};

export const REGRAS_NOVAS: Record<NovaConditionCheck["kind"], string> = {
  field: "Campo",
  tag: "Tag",
  stage: "Etapa do negócio",
  open_deal_in_pipeline: "Tem negócio aberto no funil",
  deal_exists: "Contato já tem negócio",
  deal_status: "Situação do negócio",
};

/** O nome do campo como a pessoa o lê. */
export function nomeDoCampo(ref: FieldRef): string {
  switch (ref.scope) {
    case "contact":
      return CAMPOS_PADRAO_DO_CONTATO[ref.key];
    case "lead":
      return CAMPOS_PADRAO_DO_NEGOCIO[ref.key];
    case "contact_custom":
      return `Campo do contato “${ref.key}”`;
    case "lead_custom":
      return `Campo do negócio “${ref.key}”`;
    case "var":
      return `Variável {{${ref.path}}}`;
  }
}

const aspas = (v: unknown) => `“${String(v)}”`;

/** A regra inteira em uma frase. */
export function fraseDaRegraNova(check: NovaConditionCheck, nomes: NomesDaAutomacao = {}): string {
  switch (check.kind) {
    case "field": {
      const campo = nomeDoCampo(check.field);
      if (OPERADORES_SEM_VALOR.includes(check.op)) return `${campo} ${OPERADORES[check.op]}`;
      return `${campo} ${OPERADORES[check.op]} ${aspas(check.value ?? "")}`;
    }
    case "tag": {
      const dono = check.target === "lead" ? "O negócio" : "O contato";
      const lista = check.tags.map(aspas).join(", ");
      if (check.op === "has_any") return `${dono} tem alguma das tags ${lista}`;
      if (check.op === "has_all") return `${dono} tem todas as tags ${lista}`;
      return `${dono} não tem as tags ${lista}`;
    }
    case "stage": {
      const etapas = check.stage_ids.map((id) => nomes.etapa?.(id) ?? "etapa").join(", ");
      return check.op === "in" ? `O negócio está em ${etapas}` : `O negócio não está em ${etapas}`;
    }
    case "open_deal_in_pipeline":
      return `Tem negócio aberto no funil ${nomes.funil?.(check.pipeline_id) ?? "escolhido"}`;
    case "deal_exists":
      return "O contato já tem algum negócio";
    case "deal_status":
      return `O negócio está ${check.status === "open" ? "em aberto" : check.status === "won" ? "ganho" : "perdido"}`;
  }
}

/** Uma ação de CRM numa frase (card do bloco e histórico). */
export function fraseDaAcao(acao: CrmAction, nomes: NomesDaAutomacao = {}): string {
  switch (acao.type) {
    case "create_deal":
      return `Criar negócio em ${nomes.etapa?.(acao.stage_id) ?? "etapa escolhida"}`;
    case "move_deal":
      return `Mover para ${nomes.etapa?.(acao.stage_id) ?? "etapa escolhida"}`;
    case "win_deal":
      return "Marcar o negócio como ganho";
    case "lose_deal":
      return "Marcar o negócio como perdido";
    case "add_tags":
      return `Adicionar ${acao.tags.map(aspas).join(", ")}`;
    case "remove_tags":
      return `Remover ${acao.tags.map(aspas).join(", ")}`;
    case "set_owner":
      return acao.mode.m === "user"
        ? `Responsável: ${nomes.pessoa?.(acao.mode.user_id) ?? "pessoa escolhida"}`
        : "Responsável por rodízio";
    case "notify":
      return "Avisar a equipe";
    case "create_task":
      return `Criar tarefa ${aspas(acao.title)}`;
    case "add_note":
      return "Adicionar nota";
  }
}

export function fraseDaOperacao(op: FieldOp): string {
  const campo = nomeDoCampo(op.target);
  switch (op.op) {
    case "set":
      return `${campo} = ${aspas(op.value ?? "")}`;
    case "clear":
      return `Limpar ${campo}`;
    case "append":
      return `${campo} + ${aspas(op.value ?? "")}`;
    case "increment":
      return `${campo} + ${op.value ?? ""}`;
  }
}

/** Como a resposta de uma pergunta é conferida (formulário e card). */
export const VALIDACOES_DA_PERGUNTA: Record<QuestionValidation, string> = {
  text: "Texto",
  phone: "Telefone",
  email: "E-mail",
  number: "Número",
  cpf: "CPF",
  date: "Data",
};

/** Tipo das opções do bloco de mensagem. */
export const TIPOS_DE_OPCAO: Record<"buttons" | "list", string> = {
  buttons: "Botões (até 3)",
  list: "Lista (até 10)",
};

/** O que um bloco de conversa fez num passo (histórico da execução). */
export const ENVIOS_DA_CONVERSA: Record<"mensagem" | "nova_tentativa" | "tempo_esgotado" | "resposta", string> = {
  mensagem: "Mensagem",
  nova_tentativa: "Nova tentativa",
  tempo_esgotado: "Aviso de tempo esgotado",
  resposta: "Resposta do contato",
};

/** Códigos de erro dos efeitos em português (histórico da execução). */
export const ERROS_DO_EFEITO: Record<string, string> = {
  janela_fechada: "janela de 24h fechada",
  teto_por_hora: "limite de 30 mensagens por hora",
  teto_indisponivel: "não foi possível conferir o limite de mensagens por hora",
  sem_conversa_whatsapp: "contato sem conversa de WhatsApp",
  contato_bloqueado: "o contato pediu para não receber mensagens",
  envio_falhou: "o envio da mensagem falhou",
  organizacao_bloqueada: "a conta não pode enviar nem mudar o CRM agora",
  sem_negocio: "o contato não tem negócio para esta ação",
  sem_contato: "o contato não foi encontrado",
  efeito_interrompido: "a execução foi interrompida no meio desta ação, e ela não foi repetida",
  efeitos_indisponiveis: "as ações não estão disponíveis neste servidor",
  efeito_falhou: "a ação falhou",
  valor_invalido: "o valor não serve para o campo",
  sem_responsavel: "nenhum atendente disponível",
  plano_limite_atingido: "o limite de negócios do plano foi atingido",
  campo_desconhecido: "o campo não existe no funil",
  texto_longo_com_opcoes: "texto passou do limite de 1024 caracteres depois de preencher as variáveis",
  texto_longo: "texto passou do limite de 4096 caracteres depois de preencher as variáveis",
};

export function fraseDoErro(codigo: string | undefined): string {
  if (!codigo) return "erro";
  const base = codigo.split(":")[0] ?? codigo;
  return ERROS_DO_EFEITO[base] ?? codigo;
}

export const VIAS_DA_ETAPA: Record<"any" | "created" | "moved", string> = {
  any: "Criado ou movido para a etapa",
  created: "Só quando o negócio nasce na etapa",
  moved: "Só quando o negócio é movido para a etapa",
};

export const POLITICAS_DE_REENTRADA: Record<"skip_if_running" | "restart", string> = {
  skip_if_running: "Ignorar se o contato já estiver nesta automação",
  restart: "Recomeçar do início",
};

export const ALVOS: Record<"lead" | "contact", string> = {
  lead: "Negócio",
  contact: "Contato",
};

export const OPERADORES_DE_TAG: Record<"has_any" | "has_all" | "has_none", string> = {
  has_any: "tem alguma das tags",
  has_all: "tem todas as tags",
  has_none: "não tem as tags",
};

export const OPERADORES_DE_ETAPA: Record<"in" | "not_in", string> = {
  in: "está em",
  not_in: "não está em",
};

export const SITUACOES_DO_NEGOCIO: Record<"open" | "won" | "lost", string> = {
  open: "Em aberto",
  won: "Ganho",
  lost: "Perdido",
};

export const SE_JA_TEM_NEGOCIO: Record<"skip" | "move" | "create_new", string> = {
  skip: "Não criar (seguir com o negócio que já existe)",
  move: "Mover o negócio que já existe para a etapa",
  create_new: "Criar outro negócio mesmo assim",
};

export const SE_DER_ERRO: Record<"route" | "continue", string> = {
  route: "Parar e sair por “Erro”",
  continue: "Seguir com as próximas ações",
};

/** Todos os mapas de rótulo deste módulo — o teste de cobertura do vocabulário de wire os lê. */
export const MAPAS_DA_AUTOMACAO: ReadonlyArray<Record<string, string>> = [
  CAMPOS_PADRAO_DO_CONTATO,
  CAMPOS_PADRAO_DO_NEGOCIO,
  OPERADORES,
  ACOES_DE_CRM,
  OPERACOES_DE_CAMPO,
  GATILHOS_DA_AUTOMACAO,
  MODOS_DA_PALAVRA_CHAVE_ROTULOS,
  EVENTOS_DE_AGENDAMENTO_ROTULOS,
  REGRAS_NOVAS,
  VIAS_DA_ETAPA,
  POLITICAS_DE_REENTRADA,
  ALVOS,
  OPERADORES_DE_TAG,
  OPERADORES_DE_ETAPA,
  SITUACOES_DO_NEGOCIO,
  SE_JA_TEM_NEGOCIO,
  SE_DER_ERRO,
  VALIDACOES_DA_PERGUNTA,
  TIPOS_DE_OPCAO,
  ENVIOS_DA_CONVERSA,
];
