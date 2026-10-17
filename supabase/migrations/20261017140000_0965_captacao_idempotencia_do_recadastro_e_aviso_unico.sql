-- 0965, idempotência do recadastro e aviso de recusa único por dia (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Auditoria de 17/10/2026 sobre a captação pública (webhooks/in/[token]), dois achados de gravidade baixa que pedem banco:
--
-- 1. O `external_id` de um RECADASTRO não morava em lugar nenhum além da timeline do lead aberto. Quando o lead
--    fechava, o reenvio da mesma batida (retry da ferramenta) não achava nada e criava um lead novo. Agora a linha de
--    `webhook_lead_captures` guarda o `external_id` do envio, e a rota consulta (organização, fonte, external_id,
--    desfecho `recadastro`) antes de qualquer efeito.
--
-- 2. O aviso "a fonte X recusou um lead em dd/mm/aaaa" era deduplicado por leitura antes do INSERT. Duas recusas
--    simultâneas passavam juntas pela leitura e gravavam dois avisos. O índice único parcial fecha a corrida; o código
--    trata o 23505 do INSERT como "o aviso do dia já existe". Antes de criar o índice, os pares que a corrida já
--    produziu são reduzidos a um (fica o mais antigo); `inbox_item_id` das tabelas que apontam para o aviso é
--    ON DELETE SET NULL.
--
-- Sem função nova. Reaplicável: coluna e índices com `if not exists`; a deduplicação não acha nada na segunda vez.

set lock_timeout = '3s';

alter table public.webhook_lead_captures
  add column if not exists external_id text;

comment on column public.webhook_lead_captures.external_id is
  'external_id que a ferramenta mandou no envio (idempotência). Consultado nos recadastros: o lead que existe pertence a outro envio, então só o histórico de captação lembra que este envio já foi tratado.';

create index if not exists webhook_lead_captures_recadastro_external_idx
  on public.webhook_lead_captures (organization_id, webhook_source_id, external_id)
  where external_id is not null and outcome = 'recadastro';

-- Pares já gravados pela corrida: fica o aviso mais antigo do dia.
delete from public.agent_inbox_items a
 using public.agent_inbox_items b
 where a.kind = 'other' and a.ref_kind is null and a.ref_id is null
   and a.title like 'A fonte % recusou um lead em %'
   and b.kind = 'other' and b.ref_kind is null and b.ref_id is null
   and b.organization_id = a.organization_id
   and b.title = a.title
   and (b.created_at, b.id) < (a.created_at, a.id);

create unique index if not exists agent_inbox_items_aviso_de_recusa_dia_uq
  on public.agent_inbox_items (organization_id, title)
  where kind = 'other' and ref_kind is null and ref_id is null
    and title like 'A fonte % recusou um lead em %';

reset lock_timeout;
