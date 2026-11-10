import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { TABLES } from "./rls-isolation.test";

/**
 * VARREDURA de completude de RLS — o buraco que o próprio `rls-isolation.test.ts`
 * confessa no cabeçalho da sua lista `TABLES` (linha ~208):
 *
 *     ⚠️ LISTA FIXA — tabela tenant-aware nova que NÃO entrar aqui passa verde
 *     sem RLS. Não existe varredura genérica do tipo "toda tabela com
 *     organization_id tem relrowsecurity = true".
 *
 * ## Por que NÃO basta olhar só o catálogo (`relrowsecurity` + "tem policy")
 *
 * Porque uma policy pode estar sabotada e ainda assim passar em qualquer
 * checagem de catálogo. Medido de verdade neste repo: `org_guardrail_layers`
 * tinha `relrowsecurity = true` e uma policy — e a policy dizia
 * `organization_id in (select fn_user_org_ids()) or true`, que devolve a
 * organização INTEIRA do vizinho. RLS ligada e policy presente não é isolamento;
 * é só a forma que o isolamento tem que ter. A prova real só existe simulando o
 * JWT de um usuário de verdade e CONTANDO linhas cross-tenant — o que
 * `rls-isolation.test.ts` já faz, por tabela, na lista `TABLES`.
 *
 * ## O que ESTA varredura fecha, então
 *
 * `TABLES` é mantida à mão. Quem cria uma tabela nova com `organization_id` e
 * esquece de acrescentar a linha ali (no MESMO commit da migration, como o
 * comentário de lá já pede) não quebra nada: o CI segue verde, e a tabela fica
 * sem NENHUMA prova de isolamento — nem de catálogo, nem de comportamento.
 * Ninguém percebe até alguém vazar dado do vizinho em produção.
 *
 * Esta varredura DERIVA a lista de tabelas tenant-aware do catálogo (não há o
 * que esquecer de acrescentar) e reprova qualquer uma que não apareça em
 * `TABLES` nem numa exceção nomeada — forçando toda tabela nova a ganhar o
 * teste comportamental de verdade antes que o gate deixe passar.
 *
 * ## As duas listas de exceção, e por que são duas coisas diferentes
 *
 * Não existe uma varredura anterior a esta, então aplicar a regra "está em
 * TABLES ou reprova" de uma vez batia em 73 tabelas que já existem hoje, têm
 * RLS ligada, mas nunca ganharam um teste `set role authenticated` + contagem
 * cross-org num arquivo dedicado — dívida herdada, não introduzida por esta
 * mudança. Fingir que elas "passam" seria mentir; fazer o gate nascer vermelho
 * em 73 tabelas de uma vez não é tratável nesta sessão (cada uma exigiria seed
 * + fixture própria). A saída honesta é DISTINGUIR as duas classes:
 *
 *   - `PROVA_PROPRIA`: tabela fora de `TABLES`, mas com teste comportamental
 *     real (JWT simulado + contagem cross-org) em outro arquivo — o mesmo
 *     padrão de `webhook_lead_captures`, que já vivia assim antes desta
 *     varredura existir. Cada entrada cita o arquivo que prova.
 *   - `DEBITO_CONHECIDO`: tabela SEM prova comportamental nenhuma, encontrada
 *     por esta varredura no dia em que ela nasceu (2026-08-27). Não é uma
 *     declaração de segurança — é a fotografia da dívida, para o gate proteger
 *     dali para frente sem fingir que o passado está resolvido. Tabela NOVA
 *     nunca entra aqui: entra em `TABLES` ou em `PROVA_PROPRIA`, com teste de
 *     verdade. Reduzir esta lista com o tempo (escrevendo o teste que falta e
 *     movendo a tabela para `TABLES`) é o caminho — não engordá-la.
 *
 * Em ambas, `relrowsecurity = true` é reconferido pela própria varredura: uma
 * exceção — de qualquer das duas listas — cuja tabela sumiu ou perdeu RLS
 * reprova, na hora, em vez de continuar "documentando" uma proteção que já não
 * existe.
 */

interface Excecao {
  readonly tabela: string;
  readonly razao: string;
}

/**
 * Tabelas fora de `TABLES` com teste comportamental de verdade em outro
 * arquivo — verificado lendo cada um: `set role authenticated` (ou
 * `countAs`/`writeCountAs`, que fazem o mesmo) + JWT do usuário + contagem de
 * linhas da OUTRA organização, não uma leitura como superusuário.
 */
const PROVA_PROPRIA: readonly Excecao[] = [
  { tabela: "meta_social_comentarios", razao: "tests/invariants/instagram-comentarios.test.ts — dois tenants reais por JWT (agent): leitura positiva local e ZERO do vizinho nos dois sentidos, a tabela inteira sem filtro igual à própria, anon sem privilégio, e update/delete de authenticated recusados (só o servidor grava)." },
  { tabela: "meta_social_fila_de_envio", razao: "tests/invariants/instagram-comentarios.test.ts — mesmo laço da linha acima, nas duas tabelas da 0991." },
  { tabela: "automacao_segredos", razao: "tests/invariants/automacao-segredos-cofre.test.ts — dois tenants reais por JWT (manager): leitura positiva local e ZERO do vizinho, atendente da própria organização vê zero, valor_cifrado negado a authenticated e anon por grant de coluna, e insert/update/delete de authenticated recusados (só o servidor grava)." },
  { tabela: "user_preferences", razao: "tests/invariants/preferencias-por-usuario-rls.test.ts — dois tenants e dois usuários reais por JWT: cada um lê e grava só a própria linha na própria organização; vizinho e colega da mesma organização recebem zero; anon recusado." },
  ...["calendar_resources", "calendar_service_schedule", "calendar_service_professionals", "calendar_service_resources", "calendar_service_calendar_sources", "calendar_service_occurrences", "calendar_service_occurrence_resources", "calendar_service_blocks"].map(tabela => ({ tabela, razao: "tests/invariants/agenda-servicos.test.ts — oito tabelas com linhas positivas no tenant próprio, JWT authenticated de duas organizações e contagem zero do vizinho; INSERT/UPDATE/DELETE diretos recusados mesmo para manager. As RPCs mantêm ator, revisão e FKs compostas." })),
  ...["attendant_sectors", "attendant_sector_members"].map(tabela => ({ tabela, razao: "tests/invariants/setores-de-atendimento.test.ts — JWT authenticated de duas organizações: cada uma lê só as próprias linhas (controle positivo nos dois lados); INSERT/DELETE diretos recusados até para manager; FK composta recusa setor de outra organização." })),
  { tabela: "jev_router_decisions", razao: "tests/invariants/jev-roteador-decisoes.test.ts — dois tenants por JWT: leitura local, zero do vizinho; anon sem leitura, authenticated sem escrita; poda com piso no banco." },
  { tabela: "golden_candidates", razao: "tests/invariants/golden-candidates.test.ts — dois tenants reais por JWT (agent): leitura positiva local e ZERO do vizinho nos dois sentidos, a tabela inteira sem filtro igual à própria, anon recusado, e insert/update/delete de authenticated sem efeito (só o servidor grava)." },
  { tabela: "jev_observacoes", razao: "tests/invariants/jev-observacoes.test.ts — dois tenants reais por JWT (agent): leitura positiva local e ZERO do vizinho nos dois sentidos, a tabela inteira sem filtro igual à própria, anon recusado, e insert/update/delete de authenticated sem efeito (só o servidor grava)." },
  { tabela: "automation_rule_contact_claims", razao: "tests/invariants/automation-claims-so-servidor.test.ts (migration 0740, #3267) — tabela exclusiva do servidor: RLS de pe e NENHUMA policy, anon/authenticated sem privilegio (nem da propria org, recusado por JWT), service_role com select/insert para o dreno." },
  { tabela: "prospecting_settings", razao: "tests/invariants/prospecting.test.ts — tabela exclusiva do servidor, ACL e RLS verificadas; FK composta e comandos autenticados cercam a organização." },
  { tabela: "prospecting_campaigns", razao: "tests/invariants/prospecting.test.ts — tabela exclusiva do servidor, ACL e RLS verificadas; FK composta e comandos autenticados cercam a organização." },
  { tabela: "prospecting_candidates", razao: "tests/invariants/prospecting.test.ts — tabela exclusiva do servidor, ACL e RLS verificadas; FK composta e comandos autenticados cercam a organização." },
  { tabela: "lgpd_marcas_de_apagamento", razao: "tests/invariants/lgpd-marca-de-apagamento.test.ts — tabela exclusiva do servidor (migration 0750): RLS ligada, zero policies, anon/authenticated sem privilégio; membro da própria organização com JWT authenticated recebe permission denied; a pergunta fn_titular_apagado_a_pedido não responde sim para a mesma pessoa noutra organização." },
  { tabela: "importacoes_de_historico", razao: "tests/invariants/importacoes-de-historico-rls.test.ts (migration 0761, #999, teste de @sergiobragah) — dois tenants reais por JWT: membro lê a importação da própria organização e zero da outra, nos dois sentidos; authenticated e anon sem insert/update/delete (escrita só pelo service_role); uma importação rodando por número." },
  { tabela: "crm_lead_attachments", razao: "tests/invariants/anexo-de-lead-isolamento-e-poda.test.ts e anexo-de-lead-caminho-e-escopo.test.ts (migration 0731): membro com JWT authenticated lê os anexos da própria organização e zero do vizinho, e não grava, altera nem apaga na linha dele; viewer lê mas não anexa nem apaga; anon sem privilégio de leitura; leitura e escrita seguem a visibilidade do negócio pai; storage_path preso à organização, ao negócio e ao campo da própria linha." },
  { tabela: "channel_integrations", razao: "tests/invariants/social-native.test.ts — credencial exclusiva do servidor: SELECT com JWT authenticated recusado para as duas organizações, além de ACL e RLS habilitada." },
  { tabela: "config_aviso_de_caso", razao: "tests/invariants/aviso-de-caso-escrita.test.ts — dois tenants reais por JWT: admin lê só a própria organização, agent e viewer não leem nada, e a escrita direta por authenticated é negada (a única porta é fn_definir_aviso_de_caso, que revalida papel, suporte e MFA)" },
  { tabela: "entregas_de_aviso_de_caso", razao: "tests/invariants/aviso-de-caso-escrita.test.ts — manager lê o histórico da própria organização e zero do vizinho; viewer lê zero; escrita direta por authenticated negada nos três verbos, e apagar a channel_sessions apontada não falha e deixa a configuração desligada" },
  { tabela: "config_aviso_de_agendamento", razao: "tests/invariants/aviso-de-agendamento-escrita.test.ts — dois tenants reais por JWT: admin lê só a própria organização, agent e viewer não leem nada, e a escrita direta por authenticated é negada nos três verbos (a única porta é fn_definir_aviso_de_agendamento, que revalida papel, suporte e MFA)" },
  { tabela: "entregas_de_aviso_de_agendamento", razao: "tests/invariants/aviso-de-agendamento-escrita.test.ts — manager lê o histórico da própria organização e zero do vizinho; viewer lê zero; escrita direta por authenticated negada nos três verbos" },
  { tabela: "organization_extensions", razao: "tests/invariants/extensoes-declarativas.test.ts — dois tenants com vínculos reais: leitura positiva local/negativa cruzada por JWT, revogação de membership e escrita direta negada" },
  { tabela: "extension_operations", razao: "tests/invariants/extensoes-declarativas.test.ts — recibo de instância fechado a anon/authenticated, inclusive configure com organização; RPCs service-only revalidam ator e papel" },
  { tabela: "channel_routing_policies", razao: "tests/invariants/channel-routing.test.ts — dois tenants reais, leitura positiva local e negativa cruzada por JWT; FK composta rejeita canal de outra org" },
  { tabela: "channel_routing_responsibles", razao: "tests/invariants/channel-routing.test.ts — JWT do tenant B não lê responsáveis de A; revogação remove vínculo e claim revalida membro ativo" },
  { tabela: "channel_connection_requests", razao: "tests/invariants/channel-routing.test.ts — recibo privado sem SELECT authenticated; reserva admin com MFA e finalização service-only cercada por org e lease" },
  { tabela: "appointment_recovery_receipts", razao: "tests/invariants/agenda-presenca-acl.test.ts — leitura/escrita direta anon/authenticated negadas, escrita service_role negada e RPC service-only valida a tupla org/evento nos dois sentidos A/B" },
  { tabela: "meta_social_envios", razao: "tests/invariants/meta-social-envios-server-side.test.ts — deny-all (0987): RLS ligada, zero policies, grants revogados de anon/authenticated, permission denied sob set role; só o servidor grava e lê os mids do próprio envio, filtrando organization_id" },
  { tabela: "event_service_origins", razao: "tests/invariants/service-event-origin.test.ts — recibo server-only, authenticated sem leitura/escrita, RPC rejeita tenant B real" },
  { tabela: "platform_support_sessions", razao: "tests/invariants/suporte-temporario.test.ts — grant por sessão, readonly e nenhuma escrita direta authenticated" },
  {
    tabela: "crm_proposal_counters",
    razao:
      "tests/invariants/proposta-contador-e-server-side.test.ts — server-side " +
      "only (RLS ligada, zero policies, revoke all de anon/authenticated, " +
      "migration 0466): authenticated e anon barrados com `permission denied` " +
      "em leitura e escrita, não zero linhas. Não entra em TABLES pelo mesmo " +
      "motivo do eixo de anúncios: lá o caso viraria `permission denied` e a " +
      "'correção' natural seria abrir policy — expondo pelo PostgREST o " +
      "contador que decide a numeração jurídica da proposta (D9).",
  },
  {
    tabela: "proposal_templates",
    razao:
      "tests/invariants/proposta-templates-isolamento-entre-organizacoes.test.ts " +
      "— isolamento cross-org com `countAs` real (membro da org A não vê a " +
      "cópia de modelo da org B) + `writeCountAs` provando o piso de papel na " +
      "escrita (viewer barrado, agent permitido), migration 0471 (M0).",
  },
  {
    tabela: "webhook_lead_captures",
    razao:
      "tests/invariants/historico-de-captacao-rls.test.ts prova isolamento " +
      "cross-tenant E o gate de papel (viewer não lê). Fica fora de TABLES " +
      "de propósito: o usuário semeado em rls-isolation.test.ts é `agent`, e " +
      "a policy desta tabela exige `manager` — o controle positivo falharia " +
      "por ACERTO ali.",
  },
  {
    tabela: "meta_templates",
    razao:
      "tests/invariants/meta-templates-rls.test.ts (\"membro da org B NÃO vê " +
      "o template da org A\") prova isolamento com `countAs` real.",
  },
  {
    tabela: "webhook_sources",
    razao:
      "tests/invariants/webhooks-rls.test.ts (\"manager B (org B) NÃO vê " +
      "webhook_source/automation_rule da org A\") prova isolamento com " +
      "`countAs` real.",
  },
  {
    tabela: "automation_rules",
    razao: "tests/invariants/webhooks-rls.test.ts — mesmo caso da linha acima.",
  },
  {
    tabela: "automation_rule_runs",
    razao:
      "tests/invariants/webhooks-rls.test.ts (\"service_role insere " +
      "automation_rule_runs na org A; manager B não vê, manager A vê\").",
  },
  {
    tabela: "calendar_event_types",
    razao:
      "tests/invariants/agenda-rls.test.ts — `TABELAS_DA_AGENDA`, com " +
      "`it.each` provando 0 linhas cross-org nos dois sentidos (A→B e B→A).",
  },
  {
    tabela: "calendar_appointments",
    razao: "tests/invariants/agenda-rls.test.ts — mesmo `it.each` de TABELAS_DA_AGENDA.",
  },
  {
    tabela: "calendar_availability_exceptions",
    razao: "tests/invariants/agenda-rls.test.ts — mesmo `it.each` de TABELAS_DA_AGENDA.",
  },
  {
    tabela: "calendar_connections",
    razao:
      "tests/invariants/agenda-rls.test.ts — TABELAS_DA_AGENDA prova o " +
      "isolamento cross-org, e o describe seguinte (\"o gate de papel que as " +
      "outras cinco não têm\") ainda prova o gate de dono/role por cima.",
  },
  {
    tabela: "calendar_connection_calendars",
    razao: "tests/invariants/agenda-rls.test.ts — mesmo `it.each` de TABELAS_DA_AGENDA.",
  },
  {
    tabela: "calendar_external_events",
    razao: "tests/invariants/agenda-rls.test.ts — mesmo `it.each` de TABELAS_DA_AGENDA.",
  },
  {
    tabela: "calendar_locations",
    razao: "tests/invariants/agenda-rls.test.ts — mesmo `it.each` de TABELAS_DA_AGENDA.",
  },
  {
    tabela: "followup_flow_versions",
    razao:
      "tests/invariants/followup-schema.test.ts — `FOLLOWUP_TABLES`, com " +
      "\"user of org A reads 0 rows of org B\" por tabela (mesmo molde de " +
      "rls-isolation.test.ts).",
  },
  {
    tabela: "followup_flow_pointers",
    razao: "tests/invariants/followup-schema.test.ts — mesmo laço de FOLLOWUP_TABLES.",
  },
  {
    tabela: "followup_enrollments",
    razao: "tests/invariants/followup-schema.test.ts — mesmo laço de FOLLOWUP_TABLES.",
  },
  {
    tabela: "followup_enrollment_events",
    razao: "tests/invariants/followup-schema.test.ts — mesmo laço de FOLLOWUP_TABLES.",
  },
  {
    tabela: "user_organizations",
    razao:
      "tests/invariants/gov-1b-team-manager-read.test.ts (\"cross-org: " +
      "manager da org A NÃO lê linhas da org B (0 rows)\") prova isolamento " +
      "com `countAs` real, além do self-read do agent.",
  },
  {
    tabela: "team_invites",
    razao:
      "tests/invariants/convites-de-time-rls.test.ts — isolamento cross-tenant " +
      "(manager A lê 0 de B, sem porta dos fundos) + gate de papel (agent/viewer " +
      "leem 0; manager não revoga, só admin). Fora de TABLES de propósito: o " +
      "usuário semeado em rls-isolation.test.ts é `agent`, e `team_invites_select` " +
      "exige `manager` — o controle positivo falharia por ACERTO ali.",
  },
  {
    tabela: "billing_usage_counters",
    razao:
      "tests/invariants/planos-trava-avisa.test.ts, caso 12 (fork Hiperbold, 0905): " +
      "gerente de A lê a própria linha e não a de B, agente da mesma organização " +
      "lê 0. Fora de TABLES pelo mesmo motivo de team_invites: a leitura exige " +
      "gerente (achado B5 da auditoria da F2, o total de leads abertos da empresa " +
      "não é para quem só vê os próprios leads) e o usuário semeado em " +
      "rls-isolation.test.ts é agent, então o controle positivo falharia por ACERTO.",
  },
  {
    tabela: "billing_token_wallets",
    razao:
      "tests/invariants/planos-carteira.test.ts, caso 1 (fork Hiperbold, 0906, " +
      "decisão 19): mesmo molde de billing_usage_counters, acima. Gerente de A lê " +
      "a própria carteira e 0 linhas da B; agente da MESMA organização A lê 0 " +
      "(leitura exige gerente). Fora de TABLES pelo mesmo motivo: o usuário " +
      "semeado lá é agent, e a policy exige fn_role_at_least(...,'manager').",
  },
  {
    tabela: "billing_token_consumo_diario",
    razao:
      "tests/invariants/planos-carteira.test.ts, caso 1 (fork Hiperbold, 0906, " +
      "decisão 19): mesmo caso da linha acima, para o agregado diário que o " +
      "extrato lê, gerente de A lê o próprio agregado e 0 de B; agente de A lê 0.",
  },
  // ─── As três do eixo de anúncios (migrations 0213/0214) ───
  //
  // ⚠️ PROVA DE OUTRO TIPO, e a diferença está escrita de propósito: as demais
  // entradas desta lista citam um teste que SIMULA JWT e CONTA linhas cross-org.
  // Estas três não contam linha nenhuma — elas provam que `authenticated` não
  // alcança a tabela DE JEITO NENHUM (privilégio NENHUM em
  // `role_table_grants` + `permission denied` medido sob `set role`), que é a
  // postura de `platform_google_oauth` (0201): RLS ligada, ZERO policies,
  // grants revogados de anon/authenticated.
  //
  // É MAIS restritivo que isolamento por tenant, não menos: sem privilégio não
  // há regra para errar. E é por isso que elas não podem entrar em `TABLES` —
  // lá o `countAs` receberia `permission denied` em vez de `0`, o caso ficaria
  // vermelho, e a "correção" natural seria criar uma policy: isto é, passar a
  // SERVIR pelo PostgREST justamente a tabela que guarda o token da conta de
  // anúncios do cliente. O teste citado tem um caso que reprova essa migração.
  //
  // NÃO é DEBITO_CONHECIDO: há prova comportamental, escrita no mesmo PR.
  {
    tabela: "ad_platform_connections",
    razao:
      "tests/invariants/credencial-de-anuncios-e-server-side.test.ts — privilégio " +
      "NENHUM para anon e authenticated, `permission denied` medido sob `set role`, " +
      "RLS ligada, zero policies, e `organization_id` NOT NULL com FK em cascata. " +
      "Deny-all em vez de policy de tenant porque a linha guarda o token que ESCREVE " +
      "conversões na conta de anúncios do cliente.",
  },
  {
    tabela: "ad_insights_connections",
    razao:
      "tests/invariants/credencial-de-anuncios-e-server-side.test.ts — mesmo " +
      "`describe.each` da linha acima. Guarda o token `ads_read`, que expõe " +
      "orçamento, criativo e performance de quem anuncia.",
  },
  {
    tabela: "ai_mcp_connections",
    razao:
      "tests/invariants/credencial-mcp-e-server-side.test.ts — privilégio NENHUM para " +
      "anon e authenticated, `permission denied` medido sob `set role`, RLS ligada, zero " +
      "policies. Deny-all porque a linha guarda a chave de acesso ao servidor MCP da " +
      "organização (fork Hiperbold, 0901).",
  },
  {
    tabela: "ai_agent_mcp_servers",
    razao:
      "tests/invariants/servidores-mcp-por-agente-server-side.test.ts — privilégio " +
      "NENHUM para anon e authenticated, `permission denied` sob `set role` com JWT " +
      "de admin da própria organização E de outra, RLS ligada, zero policies. Guarda chave e client_secret cifrados dos servidores MCP do agente (9095).",
  },
  {
    tabela: "mcp_oauth_pedidos",
    razao:
      "tests/invariants/servidores-mcp-por-agente-server-side.test.ts — privilégio " +
      "NENHUM para anon e authenticated, `permission denied` sob `set role` com JWT " +
      "de admin da própria organização E de outra, RLS ligada, zero policies. Guarda o state de uso único e o code_verifier cifrado do OAuth por contato (9095).",
  },
  {
    tabela: "contato_mcp_credenciais",
    razao:
      "tests/invariants/servidores-mcp-por-agente-server-side.test.ts — privilégio " +
      "NENHUM para anon e authenticated, `permission denied` sob `set role` com JWT " +
      "de admin da própria organização E de outra, RLS ligada, zero policies. Guarda o access e o refresh token cifrados do CONTATO num terceiro (9095).",
  },
  {
    tabela: "map_provider_credentials",
    razao:
      "tests/invariants/credencial-de-mapas-e-server-side.test.ts — privilégio " +
      "NENHUM para anon e authenticated, `permission denied` sob `set role`, RLS " +
      "ligada, zero policies, `organization_id` NOT NULL com FK em cascata. Guarda " +
      "a chave do Google da organização (0504), que só o servidor lê.",
  },
  {
    tabela: "ad_conversion_dispatches",
    razao:
      "tests/invariants/credencial-de-anuncios-e-server-side.test.ts — mesmo " +
      "`describe.each`. Não guarda segredo, mas é o livro-razão de quais leads " +
      "da organização viraram venda, e quem o lê é o servidor com o admin client " +
      "filtrando organization_id à mão (a tela `/app/settings/conversoes`).",
  },
  { tabela: "meta_ctwa_click_dispatches", razao: "tests/invariants/meta-lead-por-clique.test.ts — deny-all como ad_conversion_dispatches (doc 199): anon e authenticated levam `permission denied` ao ler, inserir, alterar e apagar; service_role lê (controle positivo). Livro dos cliques CTWA; só o servidor lê, filtrando organization_id à mão." },
  {
    tabela: "ad_hierarchy_cache",
    razao:
      "tests/invariants/credencial-de-anuncios-e-server-side.test.ts — mesmo " +
      "`describe.each` das três acima. Guarda o nome da campanha, do conjunto e " +
      "do anúncio de quem anuncia: a estratégia de mídia, não um segredo de " +
      "autenticação. Quem a lê é o servidor com o admin client filtrando " +
      "organization_id à mão.",
  },
  {
    tabela: "google_ads_landing_pages",
    razao:
      "tests/invariants/captura-de-clique-e-server-side.test.ts — mesmo desenho " +
      "deny-all de ad_platform_connections (0213): RLS ligada, zero policies, " +
      "grants revogados de anon/authenticated, organization_id NOT NULL com FK " +
      "em cascata. Guarda para qual WhatsApp e com qual texto a landing page " +
      "de captura de gclid redireciona.",
  },
  {
    tabela: "google_ads_conversion_rules",
    razao:
      "tests/invariants/captura-de-clique-e-server-side.test.ts — RLS ligada, " +
      "zero policies, privilégios revogados e permission denied sob set role " +
      "anon/authenticated. O servidor aplica organization_id às regras por etapa. " +
      "tests/invariants/google-regras-etapa-isoladas.test.ts também prova a FK " +
      "composta que recusa etapa de outra organização.",
  },
  {
    tabela: "meta_ads_conversion_rules",
    razao:
      "tests/invariants/captura-de-clique-e-server-side.test.ts — RLS ligada, " +
      "zero policies, privilégios revogados e permission denied sob set role " +
      "anon/authenticated. O servidor aplica organization_id às regras por etapa " +
      "da Meta (0524). tests/invariants/meta-regras-etapa-isoladas.test.ts prova a " +
      "FK composta que recusa etapa de outra organização.",
  },
  {
    tabela: "ad_tracking_links",
    razao:
      "tests/invariants/captura-de-clique-e-server-side.test.ts — mesmo teste " +
      "comportamental deny-all, com controle positivo de service_role. " +
      "tests/invariants/links-rastreaveis-isolados.test.ts prova as FKs compostas " +
      "e o isolamento das métricas por organização.",
  },
  {
    tabela: "google_ads_click_refs",
    razao:
      "tests/invariants/captura-de-clique-e-server-side.test.ts — mesmo " +
      "`describe.each` da linha acima. Guarda o `gclid` de cada clique de " +
      "anúncio e o token que o liga à mensagem do WhatsApp.",
  },
  {
    tabela: "meta_ads_landing_pages",
    razao:
      "tests/invariants/captura-de-clique-e-server-side.test.ts — mesmo " +
      "`describe.each` das duas linhas acima. É o par da migration 0381: " +
      "guarda para qual WhatsApp e com qual texto a rota pública de captura " +
      "de UTM redireciona.",
  },
  {
    tabela: "meta_ads_click_refs",
    razao:
      "tests/invariants/captura-de-clique-e-server-side.test.ts — mesmo " +
      "`describe.each`. Guarda as UTMs de cada clique no botão da landing " +
      "page e o ref curto que as liga à mensagem do WhatsApp.",
  },
  // ─── As três do livro-caixa de tokens de IA (migration 0906, fork Hiperbold) ───
  //
  // Mesmo desenho deny-all das nove linhas acima (molde ad_platform_connections,
  // 0213): decisão 19 da fase F2-B, livro-caixa e adicionais são privilégio
  // NENHUM para `authenticated`, só a plataforma pelo servidor com service_role.
  // `permission denied` medido sob `set role`, não contagem cross-org.
  {
    tabela: "billing_token_ledger",
    razao:
      "tests/invariants/planos-carteira.test.ts, caso 2 (fork Hiperbold, 0906, " +
      "decisão 19): privilégio NENHUM para `authenticated`, `permission denied` " +
      "medido sob `set role`, e um caso à parte prova que nem `service_role` tem " +
      "update/delete/truncate (o livro-caixa é só de acréscimo, decisão 7).",
  },
  {
    tabela: "billing_token_adicionais",
    razao:
      "tests/invariants/planos-carteira.test.ts, caso 2, mesmo desenho da linha " +
      "acima: catálogo das contratações ativas, escrito só pelas funções do " +
      "admin da plataforma (decisão 16).",
  },
  {
    tabela: "billing_token_avisos_emitidos",
    razao:
      "tests/invariants/planos-carteira.test.ts, caso 2, mesmo desenho: marca de " +
      "dedup dos avisos de carteira (decisões 14 e 15), só de acréscimo, sem " +
      "policy nenhuma para `authenticated`.",
  },
  // ─── billing_payments (migration 0908, fork Hiperbold, fase F4) ───
  //
  // Mesmo desenho deny-all de billing_token_ledger, acima: privilégio NENHUM
  // para `authenticated`, a tela lê pelo servidor com `service_role`.
  // `billing_token_pacotes` (mesma migração, decisão 10) NÃO entra aqui: é um
  // CATÁLOGO global, sem coluna `organization_id` (não aparece no
  // `inventario()` desta varredura), embora também tenha privilégio NENHUM
  // para `authenticated` (provado no mesmo arquivo, caso 6).
  {
    tabela: "billing_payments",
    razao:
      "tests/invariants/planos-assinatura-estados.test.ts, caso 1 (fork Hiperbold, " +
      "0908, decisão 1): `authenticated` barrado por `permission denied` ao " +
      "SELECT e ao INSERT (medido sob `set role`/JWT real), e um caso à parte " +
      "prova que nem `service_role` tem update/delete (o livro-caixa de " +
      "pagamentos é só de acréscimo, mesmo desenho de billing_token_ledger).",
  },
  // ─── billing_contract_eventos (migration 0908, correção revisão F4, item 4) ───
  //
  // Mesmo desenho deny-all de billing_payments, acima: RLS ligada, ZERO
  // policy, privilégio NENHUM para `authenticated` (a tela lê pelo servidor
  // com `service_role`). Registro de autor/motivo das transições da
  // assinatura, só de acréscimo (nem `service_role` tem update/delete).
  {
    tabela: "billing_contract_eventos",
    razao:
      "tests/invariants/planos-assinatura-estados.test.ts, describe " +
      "'`authenticated` não lê nem grava billing_contract_eventos' (fork " +
      "Hiperbold, 0908, correção revisão F4 item 4): `authenticated` barrado " +
      "por `permission denied` ao SELECT e ao INSERT (medido sob `set " +
      "role`/JWT real), mesmo desenho deny-all de billing_payments.",
  },
  // ─── billing_customers e billing_orders (migration 0909, fork Hiperbold, fase F5) ───
  //
  // Mesmo desenho deny-all de billing_payments/billing_contract_eventos,
  // acima: RLS ligada, ZERO policy, privilégio NENHUM para `anon`,
  // `authenticated` e `agent_worker` (medido por `set role`); `service_role`
  // só SELECT, a escrita é só por função (Tarefa 3 em diante, fora da
  // migration 0909).
  {
    tabela: "billing_customers",
    razao:
      "tests/invariants/planos-asaas.test.ts (fork Hiperbold, 0909, Tarefa " +
      "2): `anon`, `authenticated` e `agent_worker` barrados por `permission " +
      "denied` ao SELECT (medido sob `set role`), `service_role` com SELECT " +
      "e sem nenhum privilégio de escrita, mesmo desenho deny-all de " +
      "billing_payments.",
  },
  {
    tabela: "billing_orders",
    razao:
      "tests/invariants/planos-asaas.test.ts (fork Hiperbold, 0909, Tarefa " +
      "2): mesmo describe.each da linha acima. O pedido de compra (assinatura " +
      "ou pacote de tokens), ponte entre o CRM e o Asaas.",
  },
  {
    tabela: "asaas_webhook_events",
    razao:
      "tests/invariants/planos-asaas.test.ts (fork Hiperbold, 0909, Tarefa " +
      "2): mesmo describe.each das duas linhas acima. organization_id aqui é " +
      "NULLABLE e SEM chave estrangeira (de propósito: o roteamento do " +
      "webhook pode não achar organização nenhuma), mas o mesmo deny-all vale.",
  },
  // ─── billing_avisos_de_renovacao (migration 0946, fork Hiperbold, D-177 parte 2) ───
  //
  // Mesmo desenho deny-all das tabelas de billing acima: RLS ligada, ZERO policy, privilégio NENHUM
  // para anon e authenticated; service_role lê, insere e altera, sem delete nem truncate.
  {
    tabela: "billing_avisos_de_renovacao",
    razao:
      "tests/invariants/regua-de-renovacao-banco.test.ts, item 8 (fork Hiperbold, 0946): " +
      "anon e authenticated barrados por permission denied ao SELECT, INSERT, UPDATE e DELETE " +
      "(medido sob set role), RLS ligada sem nenhuma policy, service_role sem delete/truncate.",
  },
  // ─── billing_emails_enviados (migration 0952, fork Hiperbold, e-mails de conta e de cobrança) ───
  {
    tabela: "billing_emails_enviados",
    razao:
      "tests/invariants/emails-de-conta-e-cobranca-banco.test.ts, item 5 (fork Hiperbold, 0952): " +
      "anon e authenticated barrados por permission denied ao SELECT, INSERT, UPDATE e DELETE " +
      "(medido sob set role), RLS ligada sem nenhuma policy, service_role sem delete/truncate.",
  },
  // ─── billing_cancel_feedback e billing_refund_requests (migration 0957, fork Hiperbold) ───
  {
    tabela: "billing_cancel_feedback",
    razao:
      "tests/invariants/reembolso-do-cliente-banco.test.ts (fork Hiperbold, 0957): admin da org A lê " +
      "só os motivos da própria organização (controle positivo) e ZERO da B por JWT simulado, agent da " +
      "mesma org lê zero, anon barrado, e authenticated não insere nem altera (só a função service_role).",
  },
  {
    tabela: "billing_refund_requests",
    razao:
      "tests/invariants/reembolso-do-cliente-banco.test.ts (fork Hiperbold, 0957): admin da org A lê " +
      "só os pedidos da própria organização (controle positivo) e ZERO da B por JWT simulado, agent da " +
      "mesma org lê zero, anon barrado, authenticated não escreve e service_role não apaga.",
  },
  // ─── org_exclusoes_programadas (migration 0959, fork Hiperbold, D-209) ───
  {
    tabela: "org_exclusoes_programadas",
    razao:
      "tests/invariants/exclusao-de-dados-apos-cancelamento.test.ts, item 4 (fork Hiperbold, 0959): " +
      "anon e authenticated barrados por permission denied ao SELECT, inclusive o membro (admin) da " +
      "PRÓPRIA organização com JWT simulado, RLS ligada sem nenhuma policy; service_role só lê e só " +
      "escreve os dois marcadores de aviso (a escrita é das funções).",
  },
  // ─── billing_trigger_alarmes (migration 0910, fork Hiperbold, fase F7, D-055) ───
  //
  // Mesmo desenho deny-all de billing_payments/billing_contract_eventos,
  // acima: RLS ligada, ZERO policy, privilégio NENHUM para anon/authenticated/
  // agent_worker, service_role só select+insert (rastro consultável de falha
  // de gatilho, só de acréscimo).
  {
    tabela: "billing_trigger_alarmes",
    razao:
      "tests/invariants/planos-saneamento.test.ts (fork Hiperbold, 0910, D-055): " +
      "anon, authenticated e agent_worker barrados por permission denied ao " +
      "SELECT e ao INSERT (medido sob set role), service_role com select e " +
      "insert e sem update/delete/truncate, mesmo desenho deny-all de " +
      "billing_payments.",
  },
  {
    tabela: "channel_session_groups",
    razao:
      "tests/invariants/grupos-na-inbox.test.ts, dois casos. \"isola por " +
      "organização (RLS), membro só LÊ e só o service role escreve\": com uma " +
      "linha REAL semeada na outra organização (e um controle que confere que " +
      "ela existe), o manager da organização de teste lê 0 linhas dela por JWT " +
      "e o agent lê a da própria; insert/update/delete de manager, insert de " +
      "agent e de anon são recusados; o service_role grava e altera. \"nenhuma " +
      "escrita concedida a anon/authenticated\": o catálogo não tem INSERT, " +
      "UPDATE, DELETE nem TRUNCATE para anon, authenticated ou PUBLIC. O " +
      "isolamento é medido num sentido só (org de teste → outra). Migration 0482.",
  },
  {
    tabela: "cobranca_assinaturas",
    razao:
      "tests/invariants/cobranca-isolamento.test.ts — dois tenants reais por JWT: " +
      "admin de A lê 1 linha de A e 0 de B, admin de B o espelho, agent de A lê 0 " +
      "(a leitura é de admin; por isso não cabe em TABLES, cujo usuário semeado é " +
      "agent), promovido a admin passa a ler (controle), e UPDATE/INSERT/DELETE " +
      "pela sessão e qualquer leitura por anon dão permission denied. Migration 0510.",
  },
  {
    tabela: "conversation_participants",
    razao:
      "tests/invariants/atendimento-conjunto-participantes.test.ts — dois tenants " +
      "por JWT (agent): o convidado LÊ a própria participação e passa a ver a " +
      "conversa e as mensagens dela, o dono não lê a linha alheia, um membro de " +
      "outra organização lê 0 nos dois sentidos e INSERT direto de authenticated " +
      "dá permission denied. Migration 0661 (issue #2542).",
  },
  {
    tabela: "message_template_groups",
    razao:
      "tests/invariants/grupos-de-resposta-rapida-rls.test.ts (migration 0808, #3245) — " +
      "leitura positiva dos quatro papéis na organização própria e ZERO do vizinho " +
      "(linha real semeada noutra organização, com controle de que ela existe); " +
      "agent e viewer sem INSERT/UPDATE/DELETE efetivo; manager cria, renomeia e apaga; " +
      "anon com permission denied por GRANT ausente; GRANT explícito a authenticated " +
      "conferido no catálogo; FK composta recusa resposta apontando para grupo de outra " +
      "organização e on delete set null (grupo_id) devolve a resposta à lista plana sem apagá-la.",
  },
  {
    tabela: "avisos",
    razao:
      "tests/invariants/aviso-do-admin-e-server-side.test.ts — privilégio NENHUM " +
      "para anon e authenticated (catálogo + `permission denied` medido sob `set " +
      "role` nos três verbos de escrita), RLS ligada, nenhuma policy alcançável " +
      "por anon/authenticated, `organization_id` NOT NULL com FK em cascata e " +
      "`autor_id` em `set null`. Deny-all em vez de policy de tenant porque o " +
      "aviso é conteúdo escrito em nome do cliente e só o servidor (a rota " +
      "`app/api/v1/avisos`, com admin client) lê e grava. Migration 9059, " +
      "issue #1418.",
  },
];

/**
 * Dívida herdada — sem teste comportamental, fotografada em 2026-08-27 por
 * esta própria varredura. Ver o cabeçalho do arquivo: NÃO adicione tabela nova
 * aqui. Tabela nova entra em `TABLES` (rls-isolation.test.ts) com teste real,
 * ou em `PROVA_PROPRIA` acima, citando o arquivo que prova.
 */
const RAZAO_DEBITO_CONHECIDO =
  "sem teste comportamental (JWT simulado + contagem cross-org) em nenhum " +
  "arquivo no dia em que esta varredura nasceu (2026-08-27); relrowsecurity " +
  "= true confirmado pela própria varredura, mas isso NÃO é prova de " +
  "isolamento (ver cabeçalho do arquivo). Dívida herdada, não introduzida " +
  "por esta mudança — não é declaração de que a tabela está segura.";

const DEBITO_CONHECIDO: readonly Excecao[] = [
  "agent_case_events",
  "agent_cases",
  "agent_inbox_items",
  "ai_agent_runs",
  "ai_agent_versions",
  "ai_agents",
  "ai_budgets",
  "ai_chunks",
  "ai_faq_items",
  "ai_invocations",
  "ai_knowledge_sources",
  "ai_knowledge_versions",
  "ai_purpose_bindings",
  "ai_router_members",
  "api_audit_log",
  "api_tokens",
  "attendant_availability",
  "before_send_traces",
  "calendar_oauth_nonces",
  "channel_knobs",
  "channel_session_health",
  "channel_session_warmup",
  "channel_sessions",
  "conversation_assignment_events",
  "conversation_notes",
  "crm_lead_activities",
  "crm_lead_links",
  "crm_lead_reactivations",
  "crm_lead_risk_states",
  "crm_lead_scores",
  "crm_pipelines",
  "crm_stages",
  "cron_jobs",
  "demanda_conversas",
  "demandas",
  "disclosure_template_pointers",
  "disclosure_template_versions",
  "event_log",
  "flywheel_distiller_proposals",
  "flywheel_judge_verdicts",
  "idempotency_keys",
  "incidents",
  "job_queue",
  "judge_alignment_pool",
  "lead_checkpoints",
  "lead_notes",
  "lead_state",
  "lead_state_transitions",
  "lgpd_requests",
  "llm_calls",
  "merge_queue",
  "message_templates",
  "metrics",
  "nuvemshop_products",
  "orders",
  "org_memory_pointers",
  "outbound_copies",
  "pacing_ledger",
  "playbook_pointers",
  "playbook_versions",
  "promise_table_pointers",
  "promise_table_versions",
  "reentry_knob_pointers",
  "reentry_knob_versions",
  "reentry_template_pointers",
  "reentry_template_versions",
  "send_ledger",
  "skill_pointers",
  "skill_versions",
  "storage_redaction_queue",
  "tenant_integrations",
  "webhook_events_log",
].map((tabela) => ({ tabela, razao: RAZAO_DEBITO_CONHECIDO }));

interface TabelaOrg {
  readonly tabela: string;
  readonly rlsLigada: boolean;
}

/** Toda tabela BASE de `public` que tem uma coluna `organization_id`. */
function inventario(): TabelaOrg[] {
  const out = sql(`
    select c.relname || '\t' || c.relrowsecurity::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
                         and a.attname = 'organization_id' and a.attnum > 0
     where n.nspname = 'public' and c.relkind = 'r'
     order by 1;
  `);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((linha) => {
      // `relrowsecurity::text` — CAST explícito — produz 'true'/'false', não
      // o 't'/'f' que o psql imprime para uma coluna boolean CRUA. Comparar
      // com "t" (o hábito de quem já leu boolean de psql direto) reprova toda
      // tabela em massa por instrumento cego, não por RLS desligada — foi
      // medido rodando este arquivo. `hardening-definer-varredura.test.ts` já
      // acerta isso comparando com "true"; aqui é o mesmo cast.
      const [tabela, rls] = linha.split("\t");
      return { tabela: (tabela ?? "").trim(), rlsLigada: (rls ?? "").trim() === "true" };
    });
}

describe("varredura: completude de RLS sobre toda tabela com organization_id", () => {
  it("o inventário não vem vazio (guarda de vacuidade)", () => {
    // Mesma razão de ser do caso análogo em hardening-definer-varredura.test.ts:
    // sem isto, um catálogo que deixasse de casar (coluna renomeada, schema
    // trocado) faria as asserções abaixo passarem por AUSÊNCIA de dado. O
    // número é o medido em 2026-08-27 (102 tabelas); a asserção é de ordem de
    // grandeza, não de igualdade, para não reprovar a cada tabela nova.
    expect(inventario().length).toBeGreaterThanOrEqual(90);
  });

  it("toda tabela com organization_id tem row level security LIGADA", () => {
    const sem = inventario()
      .filter((t) => !t.rlsLigada)
      .map((t) => t.tabela);
    expect(
      sem,
      "Tabela com `organization_id` e SEM RLS: alcançável pelo PostgREST com " +
        "a anon key + o JWT de qualquer usuário logado. Acrescente `alter " +
        "table ... enable row level security` na migration.",
    ).toEqual([]);
  });

  it("toda tabela tenant-aware tem prova comportamental — está em TABLES ou é exceção nomeada", () => {
    // Este é o caso que fecha o buraco de verdade: RLS ligada (caso acima) não
    // é isolamento provado — só a forma que o isolamento tem que ter. Uma
    // tabela só passa aqui se estiver em TABLES (teste comportamental de
    // verdade), em PROVA_PROPRIA (teste comportamental em outro arquivo,
    // citado) ou em DEBITO_CONHECIDO (dívida herdada, fotografada — não uma
    // aprovação).
    const conhecidas = new Set<string>([
      ...TABLES,
      ...PROVA_PROPRIA.map((e) => e.tabela),
      ...DEBITO_CONHECIDO.map((e) => e.tabela),
    ]);
    const semRegistro = inventario()
      .map((t) => t.tabela)
      .filter((tabela) => !conhecidas.has(tabela));
    expect(
      semRegistro,
      "Tabela tenant-aware NOVA sem prova comportamental nenhuma. Acrescente " +
        "a tabela em TABLES (tests/invariants/rls-isolation.test.ts) com um " +
        "teste `set role authenticated` + JWT + contagem cross-org, no MESMO " +
        "commit da migration — ou, se já existir teste assim em outro " +
        "arquivo, declare em PROVA_PROPRIA (neste arquivo) citando-o. NÃO " +
        "acrescente em DEBITO_CONHECIDO: aquela lista é só a dívida herdada " +
        "de antes desta varredura existir.",
    ).toEqual([]);
  });

  it("as exceções de PROVA_PROPRIA ainda existem e ainda têm RLS ligada", () => {
    // As duas mortes de sempre: exceção para tabela que sumiu vira ruído que
    // ninguém apaga; exceção para tabela que perdeu RLS finge segurança que já
    // não existe.
    const porTabela = new Map(inventario().map((t) => [t.tabela, t]));
    for (const { tabela } of PROVA_PROPRIA) {
      const achada = porTabela.get(tabela);
      expect(achada, `PROVA_PROPRIA cita tabela inexistente: ${tabela}`).toBeDefined();
      expect(
        achada?.rlsLigada,
        `${tabela} está em PROVA_PROPRIA mas perdeu RLS — não é mais exceção, é tabela exposta`,
      ).toBe(true);
    }
  });

  it("as exceções de DEBITO_CONHECIDO ainda existem e ainda têm RLS ligada", () => {
    const porTabela = new Map(inventario().map((t) => [t.tabela, t]));
    for (const { tabela } of DEBITO_CONHECIDO) {
      const achada = porTabela.get(tabela);
      expect(achada, `DEBITO_CONHECIDO cita tabela inexistente: ${tabela} — remova a entrada`).toBeDefined();
      expect(
        achada?.rlsLigada,
        `${tabela} está em DEBITO_CONHECIDO mas perdeu RLS — isto não é mais só falta de teste, é tabela exposta`,
      ).toBe(true);
    }
  });
});
