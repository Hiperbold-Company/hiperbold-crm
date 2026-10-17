/**
 * Capacidades de ADMINISTRAR a empresa por chave de API (fase 1 da API,
 * 17/10/2026): configuração do funil, entradas automáticas de contatos
 * (editar e apagar) e dados da empresa.
 *
 * Texto para o HUMANO que configura o agente; o que vai ao modelo é a
 * `description` do handler em `lib/mcp/tools/administracao.ts`. Todas
 * `apenasHumano`: o papel exigido (admin/gerente) é o da tela equivalente, e
 * baixar daí daria à IA um poder que o produto não dá a uma pessoa.
 * Sem jargão: funil, etapa, entrada automática de contatos.
 */
import { declararTools } from "./tipos";

export const TOOLS_ADMINISTRACAO = declararTools([
  {
    name: "crm_get_pipeline_config",
    category: "read",
    rotulo: "Ver a configuração de um funil",
    explicacao:
      "Mostra os campos personalizados, os motivos de ganho e de perda, os nomes usados no funil e o que acontece quando um negócio encerrado volta.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_pipeline_config",
    category: "write",
    rotulo: "Alterar a configuração de um funil",
    explicacao:
      "Muda campos personalizados, motivos de ganho e de perda e os nomes usados no funil. Quem atende passa a ver as mudanças na hora, nos cartões e nos formulários.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_list_pipeline_fields",
    category: "read",
    rotulo: "Ver os campos personalizados de um funil",
    explicacao:
      "Mostra os campos extras que os negócios de um funil carregam (como origem, orçamento ou procedimento), com o tipo de cada um e quando passam a ser obrigatórios.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_create_pipeline_field",
    category: "write",
    rotulo: "Criar um campo personalizado no funil",
    explicacao:
      "Acrescenta um campo novo aos negócios de um funil, sem mexer nos que já existem. Quem atende passa a ver o campo nos cartões e formulários na hora.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_pipeline_field",
    category: "write",
    rotulo: "Alterar um campo personalizado do funil",
    explicacao:
      "Muda o nome, as opções ou a obrigatoriedade de um campo extra do funil. O tipo do campo não muda depois de criado.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_delete_pipeline_field",
    category: "write",
    rotulo: "Remover um campo personalizado do funil",
    explicacao:
      "Tira um campo extra dos cartões e formulários do funil. O que já foi preenchido continua guardado nos negócios, mas deixa de aparecer.",
    oQueToca: "Funil de vendas",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_webhook_source",
    category: "write",
    rotulo: "Editar uma entrada automática de contatos",
    explicacao:
      "Troca o nome, o funil e a etapa de destino ou liga e desliga uma origem de contatos. Muda na hora para onde a gente de fora vai parar.",
    oQueToca: "Entrada automática de contatos",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_delete_webhook_source",
    category: "write",
    rotulo: "Apagar uma entrada automática de contatos",
    explicacao:
      "Remove o endereço de uma origem. O formulário do site que ainda o usa para de trazer contatos e ninguém do outro lado é avisado.",
    oQueToca: "Entrada automática de contatos",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_rotate_webhook_source_secret",
    category: "write",
    rotulo: "Girar o segredo de uma entrada automática de contatos",
    explicacao:
      "Cria um segredo novo para assinar os envios de uma origem de contatos e mostra o texto uma única vez. O segredo antigo para de valer na hora: o formulário que ainda o usa deixa de trazer contatos até ser atualizado.",
    oQueToca: "Entrada automática de contatos",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_list_ai_agents",
    category: "read",
    rotulo: "Ver os agentes de IA",
    explicacao:
      "Mostra os agentes de IA da empresa, se cada um está no ar ou pausado e qual modelo usa.",
    oQueToca: "Agente de IA",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_get_ai_agent",
    category: "read",
    rotulo: "Ver um agente de IA e as versões dele",
    explicacao:
      "Mostra o texto de instrução, as capacidades liberadas e o histórico de versões de um agente de IA.",
    oQueToca: "Agente de IA",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_create_ai_agent",
    category: "write",
    rotulo: "Criar um agente de IA (rascunho)",
    explicacao:
      "Cria um agente novo com a primeira versão em rascunho. Ele não atende ninguém até ser publicado.",
    oQueToca: "Agente de IA",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_create_ai_agent_version",
    category: "write",
    rotulo: "Salvar uma versão nova de um agente de IA",
    explicacao:
      "Guarda uma nova versão em rascunho do agente, como o botão Salvar da tela. A versão que está no ar não muda até publicar.",
    oQueToca: "Agente de IA",
    risco: "atencao",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_publish_ai_agent_version",
    category: "write",
    rotulo: "Publicar uma versão de agente de IA",
    explicacao:
      "Coloca a versão escolhida no ar: o agente passa a responder clientes de verdade com ela, no lugar da anterior.",
    oQueToca: "Agente de IA",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_pause_ai_agent",
    category: "write",
    rotulo: "Pausar um agente de IA",
    explicacao:
      "Tira o agente do ar na hora: ele deixa de responder clientes e a conversa fica com a equipe.",
    oQueToca: "Agente de IA",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_get_organization_settings",
    category: "read",
    rotulo: "Ver os dados da empresa",
    explicacao:
      "Mostra o nome, o país, o fuso, a moeda, o contato de privacidade e o texto que descreve o que a empresa faz.",
    oQueToca: "Dados da empresa",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_organization_settings",
    category: "write",
    rotulo: "Alterar os dados da empresa",
    explicacao:
      "Muda nome, país, fuso, moeda, contato de privacidade, o texto sobre o que a empresa faz e as áreas do menu. Vale para todo o time.",
    oQueToca: "Dados da empresa",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
]);
