# API × telas — matriz de cobertura (D-211)

Gerada em 17/10/2026 a partir do estado do código na branch `feat/api-fase-3` (fases 1, 2 e 3). Fontes: `lib/navigation/catalogo.ts`, `app/app/**`, `app/api/v1/**` (rotas que usam `autorizarAdministracao`/`resolveAuthDual`), `lib/auth/public-paths.ts` e `lib/mcp/tools/index.ts`. Uma linha por tela/grupo de ação; ações irmãs da mesma rota foram agrupadas.

Legenda: **Bearer dsk_?** = a rota aceita `Authorization: Bearer dsk_…` (tem entrada em `public-paths.ts` e usa a porta sessão-ou-token). **Prioridade alta** = necessária para montar um cliente novo do zero (fontes de captação, campos personalizados, agentes/IA, respostas rápidas, follow-ups, roteadores, conexões, mais equipe, funis, etapas e dados da empresa).

## Resumo

| Prioridade | Linhas | Rota com Bearer | Com tool MCP | Fechadas (Bearer + tool) |
|---|---|---|---|---|
| alta | 48 | 43 | 41 | 41 |
| média | 46 | 8 | 21 | 5 |
| baixa | 24 | 0 | 3 | 0 |
| **total** | 118 | 51 | 65 | 46 |

Observação: "rota existe mas sem Bearer" é a lacuna dominante — a maior parte do `/api/v1` já existe para a tela (sessão por cookie) e falta só converter a porta de autenticação para `autorizarAdministracao` (papel = o da tela, escopo `mcp:read`/`mcp:write`), declarar a rota em `public-paths.ts` e expor a tool. Onde a coluna Rota diz "(Server Actions …)", não há rota REST: é preciso extrair o núcleo da action para `lib/` e criar a rota.

## Lacunas de prioridade alta ainda abertas (próxima fatia)

Fase 3 (17/10/2026) fechou: respostas rápidas, follow-ups, roteadores, regras automáticas (criar/editar/apagar), distribuição de atendimento, conhecimento (criar/editar/arquivar), tools de equipe e funis, e a leitura de conexões e credenciais de IA. O que sobrou:

- Equipe — listar convites (`GET /api/v1/team/invites`): Bearer ok, tool falta
- Equipe — reenviar / revogar convite (`POST /api/v1/team/invites/{id}/resend | revoke`): Bearer ok, tool falta
- Provedores (/app/ai/providers) — ler / alterar provedores e modelos (`GET|PUT|PATCH /ai/providers · GET /ai/providers/{provider}/models`): Bearer não, tool falta
- Conexões — criar sessão / QR / código de pareamento / reconectar / apagar (`POST /channel-sessions · GET /{id}/qr · POST /{id}/pairing-code|reconnect · DELETE /{id}`): Bearer não, tool falta
- Conexões — acesso da IA à sessão (`GET|PATCH /channel-sessions/{id}/ai-access`): Bearer não, tool falta
- Conexões — canal oficial (Cloud API): ler / conectar / registrar / número / webhook (`GET|POST /channels/official · /numero · /registrar · /webhook`): Bearer não, tool falta
- Conexões — instância (provisionar/remover), pareamento por QR, parceiro, social (`/channels/instancia · /pareamento-qr · /partner · /graph-partner · /social`): Bearer não, tool falta

Fechamentos PARCIAIS contados como fechados acima (o resto de cada linha continua só na sessão): credenciais de IA (só listar; cadastrar, trocar, apagar e revalidar chave seguem na sessão, com segundo fator), conhecimento (criar/editar/arquivar por token; envio de arquivo e reindexação só na sessão), follow-ups (do zero por token; `from-model` e `modelos-aprovados` só na sessão), distribuição de atendimento (`/settings/routing` por token; `/settings/routing/channels` só na sessão: a RPC depende de `auth.uid()`), respostas rápidas (chave só cria e mexe nas compartilhadas; a pessoal é do atendente).

## Matriz

| Tela | Ação | Rota API | Aceita bearer dsk_? | Tool MCP | Prioridade |
|---|---|---|---|---|---|
| Organização (/app/settings/tenant) | ler dados da empresa | GET /api/v1/settings/organizacao | sim | crm_get_organization_settings | alta |
| Organização | editar dados da empresa, perfil e áreas do menu | PATCH /api/v1/settings/organizacao | sim | crm_update_organization_settings | alta |
| Equipe (/app/team) | listar membros | GET /api/v1/team | sim | crm_list_team_members | alta |
| Equipe | convidar (lote) | POST /api/v1/team/invite | sim | crm_invite_team_members | alta |
| Equipe | listar convites | GET /api/v1/team/invites | sim | falta | alta |
| Equipe | reenviar / revogar convite | POST /api/v1/team/invites/{id}/resend | revoke | sim | falta | alta |
| Equipe | mudar papel | PATCH /api/v1/team/{user_id}/role | sim | crm_change_team_member_role | alta |
| Equipe | editar membro (carga, janela) | PATCH /api/v1/team/{user_id} | sim | falta | média |
| Equipe | revogar / reativar acesso | POST /api/v1/team/{user_id}/revoke | reactivate | sim | crm_revoke_team_member · crm_reactivate_team_member | alta |
| Equipe | personalizar menu do membro | PATCH /api/v1/team/{user_id}/interface | não | falta | baixa |
| Equipe | listar atribuíveis | GET /api/v1/team/assignable | não | falta | baixa |
| Funis (/app/kanban) | listar funis | GET /api/v1/pipelines | sim | crm_list_pipelines | alta |
| Funis | criar / editar / apagar funil | POST /api/v1/pipelines · PATCH|DELETE /api/v1/pipelines/{id} | sim | crm_create_pipeline · crm_update_pipeline · crm_delete_pipeline | alta |
| Funis | quadro (board) de um funil | GET /api/v1/pipelines/{id}/board | não | falta | média |
| Funis | previsão (forecast) | GET /api/v1/pipelines/{id}/forecast | não | crm_get_pipeline_forecast | baixa |
| Etapas do funil (/app/settings/tenant/pipelines) | listar etapas | GET /api/v1/pipelines/{id}/stages | sim | crm_list_stages | alta |
| Etapas do funil | criar / editar (nome, cor) / arquivar etapa | POST /pipelines/{id}/stages · PATCH|DELETE /pipelines/{id}/stages/{stageId} | sim | crm_create_stage · crm_update_stage · crm_archive_stage | alta |
| Etapas do funil | ler / gravar configuração (vocabulário, motivos, reabertura) | GET|PATCH /api/v1/pipelines/{id}/config | sim | crm_get_pipeline_config · crm_update_pipeline_config | alta |
| Etapas do funil | campos personalizados: listar | GET /api/v1/pipelines/{id}/fields | sim | crm_list_pipeline_fields | alta |
| Etapas do funil | campos personalizados: criar (um a um, Idempotency-Key) | POST /api/v1/pipelines/{id}/fields | sim | crm_create_pipeline_field | alta |
| Etapas do funil | campos personalizados: alterar / remover | PATCH|DELETE /api/v1/pipelines/{id}/fields/{key} | sim | crm_update_pipeline_field · crm_delete_pipeline_field | alta |
| Etapas do funil | mapa funil × agente | GET|PUT /api/v1/pipelines/{id}/agent-mapping | não | falta | média |
| Webhooks (/app/webhooks) — entradas automáticas | listar fontes de captação | GET /api/v1/webhook-sources | sim | crm_list_webhook_sources | alta |
| Webhooks — entradas automáticas | criar fonte (segredo próprio ou gerado; Idempotency-Key) | POST /api/v1/webhook-sources | sim | crm_create_webhook_source | alta |
| Webhooks — entradas automáticas | editar / ativar-desativar fonte | PATCH /api/v1/webhook-sources/{id} | sim | crm_update_webhook_source · crm_set_webhook_source_active | alta |
| Webhooks — entradas automáticas | apagar fonte | DELETE /api/v1/webhook-sources/{id} | sim | crm_delete_webhook_source | alta |
| Webhooks — entradas automáticas | girar segredo HMAC (claro só na resposta) | POST /api/v1/webhook-sources/{id}/rotate-secret | sim | crm_rotate_webhook_source_secret | alta |
| Webhooks — entradas automáticas | ver recebimentos (nomes dos campos) | GET /api/v1/webhook-sources/{id}/events | sim | crm_list_webhook_source_events | média |
| Webhooks — entradas automáticas | capturas de leads (lista) | GET /api/v1/lead-captures | não | falta | baixa |
| Webhooks — regras automáticas | listar regras / execuções | GET /api/v1/automation-rules · /runs | não | crm_list_automation_rules · crm_list_automation_runs | média |
| Webhooks — regras automáticas | criar / editar / apagar regra | POST /api/v1/automation-rules · PATCH|DELETE /{id} | sim | crm_create_automation_rule · crm_update_automation_rule · crm_delete_automation_rule | alta |
| Webhooks — regras automáticas | ligar-desligar regra | PATCH /api/v1/automation-rules/{id} | não | crm_set_automation_rule_active | média |
| Webhooks — regras automáticas | reenviar execução | POST /api/v1/automation-rules/runs/{runId}/resend | não | falta | baixa |
| Agentes (/app/ai/agents) | listar agentes | GET /api/v1/ai/agents | sim | crm_list_ai_agents | alta |
| Agentes | ver agente (+ versões) | GET /api/v1/ai/agents/{id} · GET …/versions · GET …/versions/{vid} | sim | crm_get_ai_agent | alta |
| Agentes | criar agente (rascunho + versão 1, Idempotency-Key) | POST /api/v1/ai/agents | sim | crm_create_ai_agent | alta |
| Agentes | salvar versão nova (rascunho, Idempotency-Key) | POST /api/v1/ai/agents/{id}/versions | sim | crm_create_ai_agent_version | alta |
| Agentes | editar rascunho de versão | PATCH /api/v1/ai/agents/{id}/versions/{vid} | sim | falta | média |
| Agentes | editar cadastro (nome, prioridade, modo) / arquivar | PATCH|DELETE /api/v1/ai/agents/{id} | sim | falta | média |
| Agentes | publicar versão | POST /api/v1/ai/agents/{id}/publish | sim | crm_publish_ai_agent_version | alta |
| Agentes | pausar agente | POST /api/v1/ai/agents/{id}/pause | sim | crm_pause_ai_agent | alta |
| Agentes | duplicar agente | POST /api/v1/ai/agents/{id}/duplicate | não | falta | média |
| Agentes | reconciliar (legado) | POST /api/v1/ai/agents/{id}/reconcile | não | falta | baixa |
| Agentes | testar versão (execução de teste) | POST /api/v1/ai/agents/{id}/versions/{vid}/test | não | falta | média |
| Agentes | propostas de melhoria: ver / aplicar | GET /ai/agents/{id}/proposals · POST …/{pid}/apply | não | crm_list_improvement_proposals | média |
| Agentes | execuções e uso de ferramentas do agente | GET /ai/agents/{id}/runs · /tool-usage | não | falta | baixa |
| Agentes | agentes atribuíveis | GET /api/v1/ai/agents/assignable | não | falta | baixa |
| Credenciais de IA (/app/ai/credentials) | listar / criar / editar / apagar / revalidar chave de IA | GET|POST /ai/credentials · PATCH|DELETE /{id} · POST /{id}/revalidate · POST /test | só leitura (GET /ai/credentials) | crm_list_ai_credentials (só leitura, sem 4 últimos nem autor) | alta |
| Provedores (/app/ai/providers) | ler / alterar provedores e modelos | GET|PUT|PATCH /ai/providers · GET /ai/providers/{provider}/models | não | falta | alta |
| Conhecimento (/app/ai/knowledge/sources) | listar materiais | GET /api/v1/ai/knowledge/sources | sim | crm_list_knowledge_sources | alta |
| Conhecimento | criar / enviar arquivo / editar / apagar / reindexar material | POST /ai/knowledge/sources · /upload · PATCH|DELETE /{id} · POST /{id}/reindex · /reindex-all | sim: criar / editar / arquivar (upload e reindexar só na sessão) | crm_get_knowledge_source · crm_create_knowledge_source · crm_update_knowledge_source · crm_archive_knowledge_source | alta |
| Conhecimento | buscar no conhecimento | (busca interna do agente) | não | crm_search_knowledge | média |
| Memória (/app/ai/memory) | ler / gravar memória da empresa | GET|POST /ai/memory · POST|PATCH /ai/memory/entries · GET /versions/{id} | não | crm_get_org_memory · crm_save_org_memory | média |
| Skills (/app/ai/skills) | listar / instalar / importar / editar / restaurar / apagar | GET /ai/skills · GET|PUT|DELETE /{name} · POST /{name}/install|restore · POST /import | não | falta | média |
| Conexões MCP (/app/ai/mcp) | listar / criar / editar / apagar conexão MCP externa; ferramentas | GET|POST /ai/mcp/conexoes · PATCH|DELETE /{id} · POST /{id}/atualizar · PATCH /{id}/ferramentas · GET /ai/mcp/ferramentas | não | falta | média |
| Decisões rápidas (Jev) (/app/ai/jev) | ler / alterar | GET|PATCH /api/v1/ai/jev | não | falta | média |
| Agentes — guardrails e estilo | camadas de guardrail, ajustes de estilo, ritmo (pacing) | GET|PUT /ai/guardrail-layers · /ai/style-adjustments · /ai/pacing | não | falta | média |
| Uso e orçamento (/app/ai/usage) | ler uso · ler/alterar orçamento | GET /ai/usage · GET|PATCH /ai/budget | não | falta | média |
| Execuções (/app/ai/runs) / Evolução (/app/ai/evolution) | listar execuções e evolução | GET /ai/runs · GET /ai/evolution · GET /ai/operator-metrics | não | falta | baixa |
| Casos (/app/ai/cases) | listar / ver / responder caso humano | GET /ai/cases · GET /{id} · POST /{id}/reply · /chat | não | crm_list_human_cases · crm_get_human_case · crm_add_case_note · crm_close_human_case | média |
| Alertas / Aviso no WhatsApp (/app/ai/cases/avisos) | alerta de caso: ler / gravar / testar | GET|PUT /ai/cases/alerta · POST /alerta/teste | não | falta | média |
| Alertas (/app/ai/inbox) | listar / resolver avisos da IA | GET /ai/inbox · PATCH /{id} · POST /resolve-all | não | falta | baixa |
| Follow-ups (/app/ai/followups) | listar fluxos de follow-up | GET /api/v1/ai/followup-flows | sim | crm_list_followup_flows | alta |
| Follow-ups | criar fluxo (do zero ou de modelo aprovado) | POST /ai/followup-flows · POST /from-model · GET /modelos-aprovados | sim: do zero (from-model e modelos-aprovados só na sessão) | crm_create_followup_flow | alta |
| Follow-ups | editar / apagar / duplicar fluxo | GET|PATCH|DELETE /ai/followup-flows/{id} · POST /{id}/duplicate | sim | crm_get_followup_flow · crm_update_followup_flow · crm_delete_followup_flow · crm_duplicate_followup_flow | alta |
| Follow-ups | publicar / desativar / reverter fluxo | POST /ai/followup-flows/{id}/publish|disable|rollback | sim | crm_publish_followup_flow · crm_disable_followup_flow · crm_rollback_followup_flow | alta |
| Follow-ups | inscrições (matrículas): listar / ver / pausar / retomar / cancelar / adiar | GET|POST /ai/followups/enrollments · POST /{id}/pause|resume|cancel|skip|snooze · GET /queue | não | crm_enroll_followup_flow · crm_list_followups · crm_cancel_followup · crm_schedule_followup | média |
| Follow-ups | cancelar promessa de retorno | POST /ai/followups/promises/{id}/cancel | não | falta | baixa |
| Fluxos de atendimento (/app/ai/atendimento) | (telas de fluxo de atendimento — rotas próprias não mapeadas em /api/v1) | falta | não | falta | média |
| Roteadores (/app/ai/routers) | listar / criar roteador | GET|POST /api/v1/ai/routers | sim | crm_list_ai_routers · crm_create_ai_router | alta |
| Roteadores | ver / editar / apagar roteador | GET|PATCH|DELETE /ai/routers/{id} | sim | crm_get_ai_router · crm_update_ai_router · crm_delete_ai_router | alta |
| Roteadores | definir membros (agentes) do roteador | PUT /ai/routers/{id}/members | sim | crm_set_ai_router_members | alta |
| Roteadores | testar roteador | POST /ai/routers/{id}/test | não | falta | média |
| Respostas rápidas (/app/templates) | listar | GET /api/v1/message-templates | sim | crm_list_message_templates | alta |
| Respostas rápidas | criar (pessoal ou compartilhada, Idempotency-Key) | POST /api/v1/message-templates | sim (chave só cria compartilhada) | crm_create_message_template | alta |
| Respostas rápidas | editar / apagar | PATCH|DELETE /api/v1/message-templates/{id} | sim (chave só mexe nas compartilhadas) | crm_update_message_template · crm_delete_message_template | alta |
| Respostas rápidas | renderizar com variáveis | (interno) | não | crm_render_message_template | baixa |
| Conexões (/app/connections) | listar sessões de canal (WhatsApp não oficial) | GET /api/v1/channel-sessions | sim (só leitura) | crm_list_channel_sessions | alta |
| Conexões | criar sessão / QR / código de pareamento / reconectar / apagar | POST /channel-sessions · GET /{id}/qr · POST /{id}/pairing-code|reconnect · DELETE /{id} | não | falta | alta |
| Conexões | acesso da IA à sessão | GET|PATCH /channel-sessions/{id}/ai-access | não | falta | alta |
| Conexões | canal oficial (Cloud API): ler / conectar / registrar / número / webhook | GET|POST /channels/official · /numero · /registrar · /webhook | não | falta | alta |
| Conexões | instância (provisionar/remover), pareamento por QR, parceiro, social | /channels/instancia · /pareamento-qr · /partner · /graph-partner · /social | não | falta | alta |
| Conexões | modelos de mensagem do canal (HSM) | GET|POST|PATCH /channels/templates · /partner/templates · /graph-partner/templates | não | falta | média |
| Conexões | números de telefone | GET|POST /phone-numbers · PATCH /{id} | não | falta | média |
| Distribuição de atendimento (/app/settings/atendimento) | ler / alterar roteamento e canais | GET|PATCH /settings/routing · /settings/routing/channels | sim: /settings/routing (/channels só na sessão) | crm_get_attendance_routing · crm_update_attendance_routing | alta |
| Distribuição de atendimento | disponibilidade/presença de atendentes | GET /attendants/availability · PATCH /{user_id} · POST /presence | não | crm_list_available_attendants | média |
| Canal oficial (/app/settings/canal-oficial) · WhatsApp (/app/settings/tenant/whatsapp) | telas de configuração do canal (usam as rotas de channels/*) | ver Conexões | não | falta | média |
| Nuvemshop (/app/integrations/nuvemshop) | conectar / desconectar | (Server Actions connectNuvemshop / disconnectNuvemshop) | não | falta | média |
| Trunk SIP (/app/settings/voip-trunk) | ler / gravar | GET|PUT /api/v1/voip/trunk | não | falta | baixa |
| Chamadas (/app/calls) | listar / registrar chamadas; voz (aceitar, rejeitar, histórico, sessões) | GET|POST /calls · /voice/** | não | falta | baixa |
| Tags (/app/settings/tags) | listar tags de contato/conversa; cores; vocabulário | GET /contact-tags · /conversation-tags · /tags/cores · GET|POST /tags/vocabulario | não | crm_list_tags · crm_manage_tags | média |
| Contatos (/app/contacts) | criar / listar / ver / editar / apagar / mesclar | POST|GET /contacts · GET|PATCH|DELETE /contacts/{id} · POST /contacts/merge | sim | crm_search_contacts · crm_get_contact | média |
| Contatos | importar CSV / duplicados / consentimento / desbloquear | POST /contacts/import · GET /duplicates · POST /{id}/consent|unblock | não | falta | média |
| Funis — negócios (cartões) | criar / editar / mover / ganhar / perder | POST /leads · PATCH /leads/{id} · POST /leads/{id}/move|win|lose | sim | crm_create_lead · crm_update_lead · crm_move_lead_stage | média |
| Funis — negócios | importar, ação em lote, retomar, clonar, reativação, próxima ação | POST /leads/import|bulk · /leads/{id}/retomar|clone|reactivation|next-action | não | crm_retomar_lead | média |
| Tarefas (/app/tasks) | listar / criar / editar / apagar tarefa | GET|POST /tasks · PATCH|DELETE /tasks/{id} | não | falta | média |
| Inbox (/app/inbox) | listar conversas, mensagens, enviar mensagem, rascunho, mídia | GET /conversations · GET /{id}/messages · POST /messages · POST /{id}/drafts|media | sim | crm_list_conversations · crm_get_conversation · crm_send_whatsapp_message · crm_create_conversation_draft | média |
| Inbox | assumir / transferir / fechar / adiar / pausar IA / notas | POST /conversations/{id}/claim|transfer|close|snooze|pause-ai|reactivate-bot|release · notas | não | crm_assign_conversation · crm_resume_ai_attendance | média |
| Campanhas (/app/campaigns) | listar / criar / editar / agir (iniciar, pausar…) / métricas / destinatários | GET|POST /campaigns · GET|PATCH /{id} · POST /{id}/{acao} · /metrics · /recipients · /preview | não | falta | média |
| Campanhas | modelos de campanha e supressões | GET|POST /campaign-templates · PATCH|DELETE /{id} · /campaign-suppressions · /settings/campanhas | não | falta | média |
| Prospecção (/app/prospecting) | listar / criar prospecção; agentes de prospecção | GET|POST /prospecting · /prospecting/agents/** | não | falta | baixa |
| Radar (/app/radar) | negócios em risco | GET /leads/at-risk | não | crm_list_at_risk_leads | baixa |
| Agenda (/app/agenda) | agendamentos: listar / criar / editar / cancelar | GET|POST|PATCH|DELETE /api/v1/agenda/agendamentos | sim | crm_list_appointments · crm_book_appointment · crm_reschedule_appointment · crm_cancel_appointment | média |
| Agenda | horários livres, exceções, endereços, configuração, Google Calendar | GET /agenda/horarios-livres · /excecoes · /enderecos · /configuracao · /google/** | não | crm_find_free_slots | média |
| Tipos de agendamento (/app/settings/tenant/agenda) | listar / criar / editar / apagar / reativar tipo | GET|POST|PATCH|DELETE /agenda/tipos · POST /agenda/tipos/reativar | não | crm_list_event_types | média |
| Produtos (/app/products) | listar / criar / editar / apagar / importar / fotos | GET|POST /products · PATCH|DELETE /{id} · /import · /{id}/fotos | não | crm_search_products | média |
| Comandas e Contas (/app/comandas, /app/settings/tenant/financeiro) | catálogo, comandas, lançamentos, fidelidade | /financeiro/** | não | falta | baixa |
| Desempenho (/app/metrics) · Atividades · Análise | relatórios e métricas | GET /metrics/** · /reports/** | não | falta | baixa |
| Meta Ads (/app/ads/meta, /app/settings/meta-ads) | contas e campanhas; configuração | GET /ads/meta/accounts|campaigns · (Server Actions de settings) | não | falta | baixa |
| Conversões (/app/settings/conversoes) | regras de conversão Google / UTM | (Server Actions: salvarRegrasDeConversaoGoogle, updateCapturaDeUtm…) | não | falta | média |
| Audit Log (/app/audit) | listar / exportar | GET /api/v1/audit · /audit/export | não | falta | baixa |
| Marca (/app/settings/marca) | logo / cores da organização | POST|DELETE /marca/logo · (Server Action updateMarcaDaOrganizacao) | não | falta | média |
| API Tokens (/app/settings/api-tokens) | listar / emitir / revogar chave | GET|POST /settings/api-tokens · POST /{id}/revoke | não | falta | baixa |
| Notificações / Perfil / Segurança (/app/settings/*) | preferências pessoais, MFA, sessões | (Server Actions pessoais; GET|PUT|DELETE /notifications/push) | não | falta | baixa |
| LGPD (/app/lgpd/requests) | listar / ver / aprovar pedido; anonimizar | GET /lgpd/requests · POST /lgpd/requests/{id}/approve · POST /lgpd/anonymize | não | crm_list_privacy_requests | média |
| Meu plano / Faturamento (/app/settings/plano, /app/faturamento) | plano, compra, pedidos | GET /billing/pedidos/{id} · (Server Actions compraDoPlano…) | não | falta | baixa |
| Extensões (/app/extensions) | listar / instalar / ativar / remover / configurar | GET|POST /extensions/** · PUT /extensions/{id}/configuration | não | falta | baixa |
| Dados externos (/app/integracao-dados) | conexões de banco externo | GET|POST /external-db/connections · PATCH|DELETE /{id} · /test · /schemas · /tables | não | crm_describe_external_data · crm_query_external_data | média |

## Como manter

- Rotas com Bearer: `git grep -lE "autorizarAdministracao|resolveAuthDual|auth-dual" -- app/api/v1`; proxy: `lib/auth/public-paths.ts`.
- Tools: `grep -rhoE 'name: "crm_[a-z_]+"' lib/mcp/tools/*.ts | sort -u`; catálogo: `lib/mcp/tools/catalogo/`.
- Padrão de conversão de rota: `lib/api/auth-dual-admin.ts` (porta), `lib/api/porta-admin.ts` (id + autorização), `lib/api/criacao-idempotente.ts` (POST de criação com `Idempotency-Key`; recibo sempre com o cliente de servidor, migration 0969), núcleo compartilhado em `lib/<domínio>/` e testes em `tests/unit/api-fase{2,3}-admin-por-token.test.ts` e `tests/unit/mcp-administracao-fase{2,3}-tools.test.ts`.
- Escritas com token exigem `requireSupportWrite()` antes do efeito, audit com `actor_api_token_id` e organização sempre da linha do token.
