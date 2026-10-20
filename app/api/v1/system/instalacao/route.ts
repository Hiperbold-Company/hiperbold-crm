/**
 * O RETRATO DA INSTALAÇÃO — o que já veio pronto e o que falta.
 *
 * Existe porque o onboarding pergunta o que o instalador já perguntou. Quem roda
 * o `install.sh` escolhe a inteligência artificial, cola a chave, sobe o
 * WhatsApp e o Redis — e então abre a primeira tela e é tratado como se tivesse
 * acabado de chegar.
 *
 * A montagem do retrato mora em `lib/instalacao/retrato.ts` porque o wizard
 * consome a MESMA resposta direto no servidor: uma tela que faz `fetch` na
 * própria aplicação paga uma volta de rede por nada, e duas montagens do mesmo
 * retrato é exatamente como as respostas do produto começaram a divergir.
 *
 * `?provar=1` acrescenta a única resposta que custa dinheiro: a chave TEM
 * SALDO? Só admin, e nunca por padrão — a tela não pode gastar sozinha.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { lerRetratoDaInstalacao } from "@/lib/instalacao/retrato";
import { provarSaldo } from "@/lib/instalacao/prova-de-credito";
import { loadCredential, CredentialUnavailableError } from "@/lib/ai/credentials";
import { modeloPadraoDaInstalacao, PROVEDOR_DA_CHAVE_DA_INSTALACAO } from "@/lib/ai/modelos-da-instalacao";
import { modelosDaInstalacao } from "@/lib/ai/modelos-da-instalacao-leitura";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

export const dynamic = "force-dynamic";

/** A prova gasta uma geração real na chave da instalação: 1 por minuto, por organização. */
const PROVAS_POR_JANELA = 1;
const JANELA_DA_PROVA_SEGUNDOS = 60;

/**
 * `listSelectableChannels` é a fonte única (já exclui arquivado) e LANÇA em
 * erro de banco de propósito: lista vazia por falha é indistinguível de "não há
 * número", e convida a parear de novo um aparelho que já está no ar. Aqui o
 * desfecho de falha é `null` — "não sei" —, nunca zero.
 */
export async function contarCanaisDaOrg(orgId: string) {
  try {
    const lista = await listSelectableChannels(createAdminClient(), orgId);
    return {
      total: lista.length,
      conectados: lista.filter((c) => c.status === "WORKING").length,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const authz = await requireRole("manager", { resource: "system_instalacao" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const supabase = await createClient();
  const retrato = await lerRetratoDaInstalacao({
    supabase,
    orgId: org.orgId,
    contarCanais: () => contarCanaisDaOrg(org.orgId),
  });

  const querProvar = req.nextUrl.searchParams.get("provar") === "1";
  if (!querProvar) return ok(retrato);

  // A partir daqui custa dinheiro: uma geração real de um token. Nunca sai de
  // graça num GET que a tela chama sozinha. 2ª chamada a requireRole de
  // propósito: é o mesmo mecanismo, com o mínimo mais alto — inclui o gate de
  // MFA para quem só tinha rank de manager mas está prestes a exercer admin.
  const authzProva = await requireRole("admin", { resource: "system_instalacao_provar" });
  if (!authzProva.ok) return authzProva.response;

  const { origemDaChave, modeloCurado, provedor, chaveEmVerificacao } = retrato.inteligencia;
  // Na chave da INSTALAÇÃO o modelo da prova é o padrão liberado (Luna), pela OpenRouter, e não o
  // curado do provedor da organização: não depende do catálogo.
  const naChaveDaInstalacao = origemDaChave === "instalacao";
  if (origemDaChave === "nenhuma" || (!naChaveDaInstalacao && !modeloCurado)) {
    // "Ainda conferindo" e "não tem" pedem frases OPOSTAS: a primeira é esperar,
    // a segunda é cadastrar. A validação da chave roda em segundo plano, então
    // quem acaba de colá-la cai sempre nesta janela.
    const aindaVerificando = origemDaChave === "nenhuma" && chaveEmVerificacao;
    return ok({
      ...retrato,
      prova: {
        feita: false,
        ...(aindaVerificando ? { aindaVerificando: true } : {}),
        motivo: aindaVerificando
          ? "A chave acabou de ser cadastrada e ainda está sendo conferida."
          : origemDaChave === "nenhuma"
            ? "Não há chave para testar."
            : "Não há modelo desta empresa de IA nesta instalação ainda.",
      },
    });
  }

  // As DUAS origens são testáveis, e a da org precisa ser: quem cola a chave no
  // wizard é exatamente quem mais precisa saber se ela funciona — antes era o
  // único caso que respondia "o teste cobre a chave da instalação", ou seja, a
  // pessoa cadastrava a chave e não recebia confirmação nenhuma.
  //
  // A cadastrada vive cifrada e é decifrada aqui, em memória, pelo mesmo caminho
  // que o runtime usa; a da instalação o próprio processo já tem em mãos.
  let apiKey = "";
  const daOrg = retrato.inteligencia.chaveDaOrg;
  if (daOrg) {
    try {
      apiKey = (await loadCredential(daOrg.id, org.orgId)).apiKey;
    } catch (err) {
      // ⚠️ "AINDA NÃO VALIDADA" NÃO É "NÃO DEU CERTO", e colapsar as duas manda a
      // pessoa desconfiar de uma chave que está certa. `loadCredential` recusa
      // credencial com `validated_at` nulo, e a validação roda em SEGUNDO PLANO
      // logo depois do cadastro: quem acabou de colar a chave no wizard e pediu
      // o teste no mesmo segundo caía exatamente nesta janela — medido
      // percorrendo o wizard, a tela dizia "não consegui testar o crédito" para
      // uma chave que funcionava.
      const reason = err instanceof CredentialUnavailableError ? err.reason : "erro";
      return ok({
        ...retrato,
        prova:
          reason === "not_validated"
            ? { feita: false, aindaVerificando: true, motivo: "A chave acabou de ser cadastrada e ainda está sendo conferida." }
            : { feita: false, motivo: "Não consegui abrir a chave cadastrada para testá-la." },
      });
    }
  } else {
    apiKey = process.env[chaveDoAmbiente(provedor)] ?? "";
  }

  if (!apiKey) {
    return ok({
      ...retrato,
      prova: { feita: false, motivo: "Não há chave para testar." },
    });
  }

  // Só aqui, no ponto que de fato gasta: as respostas "sem chave"/"ainda conferindo" acima não custam
  // nada e não consomem o balde. Por organização (a chave é da instalação, o gasto é de todas).
  const balde = await checkRateLimit(
    `instalacao-provar:${org.orgId}`,
    PROVAS_POR_JANELA,
    JANELA_DA_PROVA_SEGUNDOS,
  );
  if (!balde.allowed) {
    return fail(
      "rate_limited",
      "A prova de saldo já foi feita há instantes. Espere um minuto para testar de novo.",
      429,
      {
        headers: {
          "Retry-After": String(JANELA_DA_PROVA_SEGUNDOS),
          "X-RateLimit-Limit": String(balde.limit),
          "X-RateLimit-Remaining": String(Math.max(0, balde.limit - balde.count)),
        },
      },
    );
  }

  const r = naChaveDaInstalacao
    ? await provarSaldo(
        PROVEDOR_DA_CHAVE_DA_INSTALACAO,
        apiKey,
        modeloPadraoDaInstalacao(await modelosDaInstalacao()),
      )
    : await provarSaldo(provedor, apiKey, modeloCurado ?? "");
  return ok({ ...retrato, prova: { feita: true, ...r } });
}

function chaveDoAmbiente(provider: string): string {
  // A chave da instalação é a da OpenRouter para os três provedores (20/10/2026).
  return (
    { anthropic: "OPENROUTER_API_KEY", openai: "OPENROUTER_API_KEY", openrouter: "OPENROUTER_API_KEY" }[
      provider
    ] ?? "__inexistente__"
  );
}
