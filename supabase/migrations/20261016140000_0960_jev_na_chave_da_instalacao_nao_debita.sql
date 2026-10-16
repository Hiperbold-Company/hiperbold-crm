-- 0960, o Jev na chave da instalação não debita a carteira de tokens (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do dono do produto (16/10/2026): a chamada do Jev (provedor typesafe) feita com a chave da
-- INSTALAÇÃO (JEV_API_KEY) não consome os tokens do plano do cliente. Até aqui ela gravava
-- llm_calls.origem_da_chave = 'chave_da_instalacao', que é a origem que o gatilho da carteira debita
-- (fn_billing_debitar_chamada e o conferidor debitam SÓ esse valor exato).
--
-- O que muda: a coluna ganha o valor 'jev_da_instalacao'. Ele não é debitado (nenhuma função da carteira
-- o reconhece) e continua medível: o painel de margem conta tudo que NÃO é 'credencial_da_organizacao',
-- então o custo do Jev na chave da Hiperbold segue aparecendo como custo conhecido. Nenhuma função muda.
-- Linhas antigas do Jev que já foram debitadas ficam como estão (o livro-caixa é só de acréscimo).
--
-- Idempotente: derruba a restrição se existir e a recria com os três valores.

set lock_timeout = '10s';

alter table public.llm_calls drop constraint if exists llm_calls_origem_da_chave_check;

alter table public.llm_calls
  add constraint llm_calls_origem_da_chave_check
  check (origem_da_chave is null or origem_da_chave in ('chave_da_instalacao', 'credencial_da_organizacao', 'jev_da_instalacao'))
  not valid;

alter table public.llm_calls validate constraint llm_calls_origem_da_chave_check;

reset lock_timeout;

comment on column public.llm_calls.origem_da_chave is
  '0906, decisão 3: de QUEM é a chave desta chamada: ''chave_da_instalacao'' (a Hiperbold paga uma chamada de modelo de linguagem) ou ''credencial_da_organizacao'' (a empresa paga com a própria chave BYOK) ou, desde a 0960, ''jev_da_instalacao'' (o Jev, da TypeSafe, na chave da instalação: a Hiperbold paga, mas NÃO debita a carteira). Nulo = ponto do código que ainda não grava a origem (histórico ou lacuna declarada). Só ''chave_da_instalacao'' debita a carteira (N17): consumo com a chave da própria organização e o do Jev ficam de fora, por decisão do plano mestre 6.7 e do dono do produto (16/10/2026).';
