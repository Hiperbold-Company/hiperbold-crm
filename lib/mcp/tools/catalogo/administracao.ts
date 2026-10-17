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
