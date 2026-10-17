/**
 * Capacidades de ADMINISTRAR a operação por chave de API (fase 3 da API, 17/10/2026): respostas
 * prontas, follow-ups, roteadores, regras automáticas, roteamento de atendimento, material de
 * conhecimento e equipe/funis.
 *
 * Texto para o HUMANO que configura o agente; o que vai ao modelo é a `description` do handler em
 * `lib/mcp/tools/administracao-fase3.ts`. Todas `apenasHumano`: o papel exigido é o da tela
 * equivalente, e baixar daí daria à IA um poder que o produto não dá a uma pessoa.
 */
import { declararTools } from "./tipos";

export const TOOLS_ADMINISTRACAO_FASE3 = declararTools([
  {
    name: "crm_create_message_template",
    category: "write",
    rotulo: "Criar uma resposta pronta da empresa",
    explicacao:
      "Cadastra uma resposta pronta compartilhada com toda a equipe. Quem atende passa a ver o texto no atalho da conversa na hora.",
    oQueToca: "Respostas prontas",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_message_template",
    category: "write",
    rotulo: "Alterar uma resposta pronta da empresa",
    explicacao:
      "Muda o título, o texto ou o atalho de uma resposta pronta compartilhada. A equipe passa a usar o texto novo na hora.",
    oQueToca: "Respostas prontas",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_delete_message_template",
    category: "write",
    rotulo: "Apagar uma resposta pronta da empresa",
    explicacao:
      "Remove uma resposta pronta compartilhada. A equipe deixa de vê-la na lista; as mensagens que já saíram com ela não mudam.",
    oQueToca: "Respostas prontas",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_list_followup_flows",
    category: "read",
    rotulo: "Ver os fluxos de follow-up",
    explicacao:
      "Mostra os fluxos de acompanhamento da empresa, se cada um está no ar, em rascunho ou desativado, e qual versão está valendo.",
    oQueToca: "Fluxo de follow-up",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_get_followup_flow",
    category: "read",
    rotulo: "Ver um fluxo de follow-up por dentro",
    explicacao:
      "Mostra os passos, o gatilho que dispara o fluxo, a política de passagem para a equipe e o histórico de versões de um follow-up.",
    oQueToca: "Fluxo de follow-up",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_create_followup_flow",
    category: "write",
    rotulo: "Criar um fluxo de follow-up (rascunho)",
    explicacao:
      "Cria um fluxo de acompanhamento vazio em rascunho. Ele não envia nada até ser montado e publicado.",
    oQueToca: "Fluxo de follow-up",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_followup_flow",
    category: "write",
    rotulo: "Editar o rascunho de um fluxo de follow-up",
    explicacao:
      "Muda o nome, o gatilho, a política de passagem para a equipe ou os passos do rascunho. O que está no ar não muda até publicar.",
    oQueToca: "Fluxo de follow-up",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_delete_followup_flow",
    category: "write",
    rotulo: "Apagar um fluxo de follow-up",
    explicacao:
      "Remove o fluxo, as versões dele e as inscrições em andamento: quem ainda ia receber mensagens deixa de receber. Não dá para desfazer.",
    oQueToca: "Fluxo de follow-up",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_duplicate_followup_flow",
    category: "write",
    rotulo: "Duplicar um fluxo de follow-up",
    explicacao:
      "Cria uma cópia do fluxo em rascunho, com os mesmos passos e gatilho. A cópia não envia nada até ser publicada.",
    oQueToca: "Fluxo de follow-up",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_publish_followup_flow",
    category: "write",
    rotulo: "Publicar um fluxo de follow-up",
    explicacao:
      "Coloca o fluxo no ar: a partir daí contatos entram nele e recebem as mensagens dos passos, de verdade, no WhatsApp.",
    oQueToca: "Fluxo de follow-up",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_disable_followup_flow",
    category: "write",
    rotulo: "Desativar um fluxo de follow-up",
    explicacao:
      "Faz o fluxo parar de aceitar contatos novos. Quem já estava dentro segue as regras do próprio fluxo.",
    oQueToca: "Fluxo de follow-up",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_rollback_followup_flow",
    category: "write",
    rotulo: "Voltar um fluxo de follow-up para uma versão anterior",
    explicacao:
      "Troca a versão que está valendo por uma mais antiga do mesmo fluxo. As mensagens novas passam a seguir a versão escolhida.",
    oQueToca: "Fluxo de follow-up",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_list_ai_routers",
    category: "read",
    rotulo: "Ver os roteadores de atendimento",
    explicacao:
      "Mostra, para cada número de WhatsApp, se há um roteador que escolhe qual agente de IA atende cada conversa e quantas intenções ele conhece.",
    oQueToca: "Roteador de agentes",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_get_ai_router",
    category: "read",
    rotulo: "Ver um roteador de atendimento por dentro",
    explicacao:
      "Mostra as intenções de um roteador: para cada tipo de pedido do cliente, qual agente atende e com quais exemplos o roteador reconhece.",
    oQueToca: "Roteador de agentes",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_create_ai_router",
    category: "write",
    rotulo: "Criar um roteador de atendimento",
    explicacao:
      "Cria um roteador para um número de WhatsApp. Ele nasce sem intenções e só passa a decidir quem atende quando as intenções forem definidas.",
    oQueToca: "Roteador de agentes",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_ai_router",
    category: "write",
    rotulo: "Alterar um roteador de atendimento",
    explicacao:
      "Muda o nome, o agente de reserva ou liga e desliga o roteador de um número. Desligar faz as conversas voltarem ao atendimento padrão na hora.",
    oQueToca: "Roteador de agentes",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_delete_ai_router",
    category: "write",
    rotulo: "Apagar um roteador de atendimento",
    explicacao:
      "Remove o roteador e as intenções dele. As conversas daquele número passam a ser atendidas sem roteador.",
    oQueToca: "Roteador de agentes",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_set_ai_router_members",
    category: "write",
    rotulo: "Definir as intenções de um roteador de atendimento",
    explicacao:
      "Troca a lista inteira de intenções do roteador: cada pedido do cliente passa a ir para o agente escolhido. Muda na hora quem atende as conversas.",
    oQueToca: "Roteador de agentes",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_create_automation_rule",
    category: "write",
    rotulo: "Criar uma regra automática (pausada)",
    explicacao:
      "Monta uma regra do tipo 'quando acontecer X, faça Y'. Ela nasce pausada e não faz nada até ser ligada.",
    oQueToca: "Regra automática",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_automation_rule",
    category: "write",
    rotulo: "Alterar uma regra automática",
    explicacao:
      "Muda o gatilho, as condições ou as ações de uma regra, ou a liga e desliga. Regra ligada age sozinha em todo evento que casar, inclusive mandando mensagem a clientes ou dados para fora.",
    oQueToca: "Regra automática",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_delete_automation_rule",
    category: "write",
    rotulo: "Apagar uma regra automática",
    explicacao:
      "Remove a regra e para o que ela fazia sozinha. O histórico do que ela já executou permanece.",
    oQueToca: "Regra automática",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_get_attendance_routing",
    category: "read",
    rotulo: "Ver a distribuição de atendimento",
    explicacao:
      "Mostra como as conversas são repartidas entre a equipe, quanto tempo uma conversa parada com uma pessoa espera antes de voltar para a IA e o que cada atendente enxerga.",
    oQueToca: "Distribuição de atendimento",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_attendance_routing",
    category: "write",
    rotulo: "Alterar a distribuição de atendimento",
    explicacao:
      "Muda como as conversas novas são repartidas, quando voltam para a IA e o que cada atendente enxerga. Vale na hora para toda a equipe: restringir a visibilidade esconde dos atendentes o que não é deles.",
    oQueToca: "Distribuição de atendimento",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_get_knowledge_source",
    category: "read",
    rotulo: "Ver o conteúdo de um material de conhecimento",
    explicacao:
      "Mostra um material do acervo da empresa e, no caso de uma FAQ, as perguntas e respostas que ele contém.",
    oQueToca: "Material de conhecimento",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_create_knowledge_source",
    category: "write",
    rotulo: "Cadastrar um material de conhecimento",
    explicacao:
      "Adiciona ao acervo uma FAQ ou um documento de texto. Os assistentes só passam a usá-lo depois que a versão publicada deles incluir o material.",
    oQueToca: "Material de conhecimento",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_knowledge_source",
    category: "write",
    rotulo: "Editar um material de conhecimento",
    explicacao:
      "Muda o nome ou as perguntas e respostas de um material. O que os assistentes respondem a partir dele muda depois que o material é reindexado.",
    oQueToca: "Material de conhecimento",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_archive_knowledge_source",
    category: "write",
    rotulo: "Arquivar um material de conhecimento",
    explicacao:
      "Tira o material do acervo: os assistentes que o usavam deixam de consultá-lo. Os arquivos originais não são apagados.",
    oQueToca: "Material de conhecimento",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_invite_team_members",
    category: "write",
    rotulo: "Convidar pessoas para a equipe",
    explicacao:
      "Manda convites por e-mail, em nome da empresa, para entrar com o papel escolhido. Convidar alguém como administrador dá a essa pessoa o controle da empresa.",
    oQueToca: "Equipe",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_change_team_member_role",
    category: "write",
    rotulo: "Mudar o papel de um membro da equipe",
    explicacao:
      "Promove ou rebaixa uma pessoa da equipe. Vale na hora: muda o que ela pode ver e fazer, inclusive administrar a empresa.",
    oQueToca: "Equipe",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_revoke_team_member",
    category: "write",
    rotulo: "Tirar o acesso de um membro da equipe",
    explicacao:
      "A pessoa perde a entrada na empresa na hora, as chaves de integração que ela criou deixam de valer e as conversas abertas dela voltam para a fila.",
    oQueToca: "Equipe",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_reactivate_team_member",
    category: "write",
    rotulo: "Devolver o acesso a um membro da equipe",
    explicacao:
      "Reativa uma pessoa que tinha sido tirada da equipe, com o mesmo papel de antes. As chaves de integração dela continuam canceladas.",
    oQueToca: "Equipe",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_create_pipeline",
    category: "write",
    rotulo: "Criar um funil de vendas",
    explicacao:
      "Cria um funil novo já com as etapas de partida, ganho e perda. Aparece na lista e nos seletores de funil na hora.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_pipeline",
    category: "write",
    rotulo: "Editar um funil de vendas",
    explicacao:
      "Muda o nome, a descrição, a ordem na lista ou qual funil é o padrão. Trocar o padrão muda para onde vão os negócios criados sem funil escolhido.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_delete_pipeline",
    category: "write",
    rotulo: "Arquivar ou excluir um funil de vendas",
    explicacao:
      "Tira o funil da lista e dos seletores. Só passa se nenhum formulário ou automação ainda mandar negócio para ele; excluir de vez só vale para funil sem negócio.",
    oQueToca: "Funil de vendas",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_list_channel_sessions",
    category: "read",
    rotulo: "Ver os números de WhatsApp conectados",
    explicacao:
      "Mostra os números de WhatsApp da empresa, se cada um está conectado e com qual limite diário. Não mostra nenhuma senha ou chave de acesso.",
    oQueToca: "Conexões de canal",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_list_ai_credentials",
    category: "read",
    rotulo: "Ver as chaves de IA cadastradas",
    explicacao:
      "Mostra quais provedores de IA a empresa já configurou, se a chave foi validada e quais modelos ela libera. Nunca mostra a chave nem pedaço dela.",
    oQueToca: "Chaves de provedor de IA",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
]);
