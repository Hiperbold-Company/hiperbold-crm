# Falhas de processo e de teste

Registro do que atrasou ou quebrou uma publicação e de como evitar da próxima vez. Cada item tem data, o que aconteceu, quanto custou e a regra que fica. Entrada nova vai no topo.

## Regras que valem hoje

1. **Correção provada antes de subir.** Teste vermelho se roda sozinho, local ou no WSL, até ficar verde. Só depois vai o commit. Commit novo no PR reinicia o CI inteiro (cerca de 38 min).
2. **Uma rodada, todas as falhas.** Ler todas as falhas da rodada (unit, db, e2e, cercas), corrigir todas e subir um commit só.
3. **Mudança que vira o idioma, o navegador ou o ambiente dos testes** (idioma novo no seletor, locale, porta, variável) obriga a procurar, antes do PR, toda spec que depende disso. Exemplo: `git grep -n 'locale:' tests/e2e`, e as specs que procuram texto da tela de login.
4. **Teste que muda código de acesso** (cliente admin, RLS, função do banco) roda junto com os testes vizinhos do mesmo módulo, não só com o teste novo. Exemplo: `pnpm vitest run tests/unit/contato-*`.
5. **Commit no PR do lote depois de o CI começar** só se for correção de falha. Documento, regra ou ajuste que não conserta nada vai para a branch do próximo lote.
6. **Script que roda longe** (ssh, WSL) precisa sobreviver à queda da sessão: `nohup` ou `setsid` no servidor, com o resultado gravado lá.

## 19/11/2026: lote 2026-11-19-b (PR #65), cerca de 4 h de CI para uma versão

- **O inglês de volta ao seletor quebrou testes que ninguém procurou antes.**
  - O que quebrou:
    - o teste do turco esperava nenhum catálogo carregado;
    - o classificador das cercas não seguia import de JSON;
    - o Playwright nasce em en-US, e toda spec passou a ver o login em inglês;
    - a spec de fuso usa en-US de propósito.
  - Custo: 1 rodada do PR #63 e 2 do PR #65.
  - Regra 3.
- **Correção de e2e subida sem ser rodada, duas vezes seguidas.**
  - O `extraHTTPHeaders` não venceu o locale do navegador, e só o CI mostrou isso, 38 min depois.
  - Custo: 2 rodadas de cerca de 38 min.
  - Regra 1.
- **Regra nova de exclusão de contato quebrou um teste vizinho** (`contato-vinculos-dialogo`). O executor rodou só os testes da lista do briefing, e o WSL achou o problema.
  - Regra 4.
- **O ensaio do `verificar` perdeu o resultado.**
  - A sessão do Claude caiu, o ssh morreu, e a etapa de banco terminou sem gravar o resumo nem o status.
  - Custo: 1 rodada de cerca de 55 min sem selo.
  - Regra 6.
- **WSL mais lento que o GitHub.**
  - O WSL levou 54 min, em série e sem e2e. O GitHub levou 38 min, em paralelo e com e2e.
  - O ganho só vem dividindo os testes nos 16 núcleos e rodando o e2e com portas próprias. Trabalho em `feat/processo-de-teste`.
- **Testes instáveis vistos no WSL**, sem relação com o lote e todos verdes ao rodar sozinhos:
  - `tests/unit/worker-pid1-drena-envio-em-voo.test.ts` (tempo);
  - `workers/agent-worker/healthz.test.ts`;
  - `tests/invariants/worker-acorda-por-notify.test.ts` (contagem de NOTIFY).
  - Se aparecerem de novo, vão para o `DEBITO.md` com o log.
