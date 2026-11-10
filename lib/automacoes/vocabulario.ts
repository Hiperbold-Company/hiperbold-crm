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
  ModoDoComentario,
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
  /** Nome de outra automação da organização (ação "Iniciar automação"). */
  automacao?: (id: string) => string | null;
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
  start_automation: "Iniciar outra automação",
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
  started_by_automation: "Iniciada por outra automação",
  instagram_comment: "Comentário no Instagram",
};

/** Como a palavra-chave do comentário é comparada. */
export const MODOS_DO_COMENTARIO_ROTULOS: Record<ModoDoComentario, string> = {
  any: "Qualquer comentário",
  contains: "Contém uma das palavras",
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
    case "start_automation":
      return `Iniciar a automação ${aspas(nomes.automacao?.(acao.pointer_id) ?? "escolhida")}`;
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

/**
 * O desfecho de cada bloco do Instagram, como o histórico da execução o lê.
 * A chave é o `resultado` do detalhe do efeito (o status que o canal
 * devolveu); `erro` prefixa a frase do erro. Nunca o texto do comentário.
 */
export const DESFECHOS_DO_INSTAGRAM = {
  instagram_private_reply: {
    na_fila: "Resposta privada enviada",
    ja_pedida: "Resposta privada já tinha sido enviada para este comentário",
    expirada: "Resposta privada não enviada: prazo de 7 dias vencido",
    erro: "Resposta privada",
  },
  instagram_public_reply: {
    na_fila: "Resposta pública enviada",
    ja_pedida: "Resposta pública já tinha sido enviada para este comentário",
    erro: "Resposta pública",
  },
  instagram_check_follow: {
    segue: "Segue o perfil",
    nao_segue: "Não segue o perfil",
    indefinido: "Não deu para saber se segue o perfil",
    erro: "Confere se segue",
  },
} as const;

/** Códigos de erro dos efeitos em português (histórico da execução). */
export const ERROS_DO_EFEITO: Record<string, string> = {
  janela_fechada: "janela de 24h fechada",
  teto_por_hora: "limite de 30 mensagens por hora",
  teto_indisponivel: "não foi possível conferir o limite de mensagens por hora",
  sem_conversa_whatsapp: "contato sem conversa de WhatsApp",
  sem_conversa_direct: "a conversa do Direct ainda não abriu: a pessoa precisa responder primeiro",
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
  tag_vazia: "a tag ficou vazia depois de preencher as variáveis",
  texto_longo_com_opcoes: "texto passou do limite de 1024 caracteres depois de preencher as variáveis",
  texto_longo: "texto passou do limite de 4096 caracteres depois de preencher as variáveis",
  texto_longo_instagram:
    "texto passou do limite do Instagram (1000 bytes, contando as opções numeradas; acento e emoji contam mais de um)",
  // Ação "Iniciar outra automação" (lote 3): o que impediu o início.
  automacao_propria: "a automação não pode iniciar a si mesma",
  automacao_inexistente: "a automação escolhida não existe mais nesta conta",
  automacao_inativa: "a automação escolhida não está ativa",
  automacao_nao_aceita: "a automação escolhida só pode ser iniciada pelas automações da lista dela",
  automacao_ciclo: "a automação escolhida já está nesta cadeia, e iniciá-la de novo fecharia um ciclo",
  automacao_cadeia_longa: "a cadeia de automações passou de 5 passos e foi cortada",
  automacao_contato_invalido: "o contato não pode entrar em automações (removido ou anonimizado)",
  automacao_em_espera: "o contato está no tempo de espera da automação escolhida",
  automacao_limite_por_hora: "o contato já entrou 10 vezes na automação escolhida na última hora",
  automacao_limite_da_organizacao: "a conta passou de 5000 automações iniciadas na última hora",
  automacao_sem_inicio: "a automação escolhida não tem bloco de Início",
  // Blocos do Instagram (comentários).
  sem_comentario: "a execução não começou por um comentário do Instagram",
  comentario_nao_encontrado: "o comentário não foi encontrado nesta conta (ou a conexão do Instagram não está ligada)",
  texto_invalido: "o texto ficou vazio ou passou de 1000 caracteres depois de preencher as variáveis",
  // Bloco "Requisição HTTP" (lote 4). Nunca o valor da chave nem a resposta.
  http_url_invalida: "o endereço (URL) não é válido depois de preencher as variáveis",
  http_https_obrigatorio: "o endereço precisa começar com https://",
  http_destino_recusado:
    "endereço recusado: o servidor não chama endereços internos (localhost, rede interna, 169.254.169.254) nem nomes que não existem",
  http_segredo_na_url: "a chave secreta não pode ir no endereço (URL): use um cabeçalho",
  http_segredo_no_texto: "a chave secreta não pode ser escrita no texto: guarde-a em Chaves secretas e escolha a chave no bloco",
  http_limite_atingido: "a conta passou de 120 chamadas HTTP por minuto; a chamada não foi feita",
  http_limite_por_execucao: "esta execução já fez 30 chamadas HTTP, o máximo por execução; a chamada não foi feita",
  http_cabecalho_proibido: "um dos cabeçalhos não pode ser definido pela automação",
  http_cabecalho_invalido: "um dos cabeçalhos ficou com valor inválido (quebra de linha ou caractere especial)",
  http_corpo_invalido: "o corpo não é um JSON válido",
  http_tempo_esgotado: "o outro sistema não respondeu dentro do tempo limite",
  http_redirecionamento: "o outro sistema respondeu com redirecionamento, e redirecionamento não é seguido",
  http_resposta_grande: "a resposta passou do tamanho máximo (2 MB)",
  http_resposta_nao_json: "a resposta não é JSON, então não deu para guardar os campos",
  http_saida_grande: "os valores guardados das respostas passaram do limite desta execução",
  http_falha_de_rede: "não foi possível conectar ao outro sistema",
  http_status: "o outro sistema respondeu com erro",
  segredo_inexistente: "a chave secreta escolhida não existe mais",
  segredo_indisponivel: "não foi possível abrir a chave secreta (a cifra do servidor está indisponível)",
};

/**
 * O DESFECHO da resposta (privada ou pública) que a fila do canal mandou ou
 * desistiu de mandar (`instagram.resposta_enviada` / `instagram.resposta_falhou`),
 * como o histórico da execução o lê. A chave é a base do `motivo` (antes do `:`).
 */
export const TITULOS_DO_DESFECHO_DA_RESPOSTA = {
  resposta_privada: { saiu: "Resposta privada saiu", falhou: "Resposta privada falhou" },
  resposta_publica: { saiu: "Resposta pública saiu", falhou: "Resposta pública falhou" },
} as const;

export const MOTIVOS_DO_DESFECHO_DA_RESPOSTA: Record<string, string> = {
  prazo_de_7_dias: "passou o prazo de 7 dias do comentário",
  comentario_desconhecido: "o comentário não existe mais no Instagram",
  inelegivel: "o Instagram não aceita resposta privada para este comentário",
  conta_indisponivel: "a conexão do Instagram não está disponível",
  envio_sem_confirmacao: "o Instagram não confirmou o envio, e ele não foi repetido para não chegar duas vezes",
};

/** O motivo do `instagram.resposta_falhou` em português; código da Meta desconhecido vira "o Instagram recusou (código N)". */
export function fraseDoMotivoDaResposta(motivo: string | null | undefined): string {
  if (!motivo) return "o Instagram não informou o motivo";
  const base = motivo.split(":")[0] ?? motivo;
  const frase = MOTIVOS_DO_DESFECHO_DA_RESPOSTA[base];
  if (frase) return frase;
  const codigo = motivo.includes(":") ? motivo.slice(motivo.lastIndexOf(":") + 1) : null;
  return codigo ? `o Instagram recusou o envio (código ${codigo})` : "o Instagram recusou o envio";
}

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

/** Métodos do bloco "Requisição HTTP": o nome técnico é o rótulo (é o que a documentação de toda API usa). */
export const METODOS_HTTP_ROTULOS: Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", string> = {
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE",
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
  MODOS_DO_COMENTARIO_ROTULOS,
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
  METODOS_HTTP_ROTULOS,
];
