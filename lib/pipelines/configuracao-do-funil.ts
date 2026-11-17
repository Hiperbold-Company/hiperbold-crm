/**
 * A configuração de um funil — campos personalizados, motivos de ganho e perda,
 * reabertura e vocabulário — num ÚNICO lugar.
 *
 * Quem chama: a server action da tela (`app/actions/settings/updatePipelineConfig.ts`),
 * a rota `GET/PATCH /api/v1/pipelines/[id]/config` e as tools MCP de configuração
 * do funil. As três escrevem pelo MESMO `aplicarConfiguracaoDoFunil`, porque duas
 * implementações do merge de `settings` divergem no primeiro campo novo.
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere o seu portão antes (admin da
 * organização + MFA na action; `role:admin` + `mcp:write` no token) e entrega a
 * organização já resolvida de fonte confiável. Esta função só garante o que vale
 * para todas: o funil TEM de ser da organização informada — consulta filtrada por
 * `organization_id`, e funil de outra organização responde igual a inexistente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import {
  mensagemDasRegrasQuePerdemOCampo,
  regrasDeDataQuePerdemOCampo,
} from "@/lib/automation/campo-do-gatilho-de-data";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { diasDeRecorte } from "@/lib/kanban/recorte-de-encerrados";
import { entradaDoInboxDeclarada, type EntradaDoInboxDeclarada } from "@/lib/leads/entrada-do-inbox";
import {
  pipelineConfigPatchSchema,
  type PipelineConfigPatch,
} from "@/lib/schemas/settings";

/** O teto de campos personalizados por funil (o mesmo de `pipelineConfigPatchSchema`). */
export const LIMITE_DE_CAMPOS = 50;

export interface ConfiguracaoDoFunil {
  id: string;
  name: string;
  vocabulary: Record<string, unknown>;
  /** Só as chaves de configuração que esta superfície edita — o resto de `settings` fica de fora. */
  settings: {
    fields: unknown[];
    lost_reasons: unknown[];
    won_reasons: string[];
    won_reason_required: boolean;
    reabertura: "mesmo_registro" | "novo_negocio";
    reabertura_campos: string[] | null;
    /** Só o `true` explícito liga (a régua do handler da comanda). */
    comanda_no_ganho: boolean;
    /** A etapa de entrada do Inbox (#3011), lida pela régua de `lib/leads/entrada-do-inbox.ts`. */
    entrada_do_inbox: EntradaDoInboxDeclarada;
    /** Recorte de encerrados (#2995). `0` = desligado, o mesmo valor que a gravação aceita para desligar. */
    ocultar_encerrados_dias: number;
    /** Os atalhos do card (#3487) como gravados; ausente = nenhum. A tela revalida cada um ao desenhar. */
    atalhos: unknown[];
  };
}

/**
 * O erro do Postgres numa falha de leitura ou gravação, para quem mostra a falha a uma pessoa
 * passar por `respostaParaOperador` (#3747) em vez de exibir `error` (o texto cru) no toast.
 */
export interface ErroDoBancoNaConfiguracao {
  etapa: "leitura" | "gravacao";
  erro: { code?: string; message: string; details?: string | null; hint?: string | null };
}

export type ResultadoDaConfiguracao<T> =
  | { ok: true; dados: T }
  | { ok: false; error: string; details?: unknown; erroDoBanco?: ErroDoBancoNaConfiguracao };

/** `details.regras_perdem_o_campo`: a recusa de #2791, com os nomes das regras. `error` já é a frase. */
export const REGRAS_PERDEM_O_CAMPO = "regras_perdem_o_campo";

type Linha = {
  id: string;
  name: string;
  vocabulary: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
};

function paraConfiguracao(row: Linha): ConfiguracaoDoFunil {
  const settings = row.settings ?? {};
  return {
    id: row.id,
    name: row.name,
    vocabulary: row.vocabulary ?? {},
    settings: {
      fields: Array.isArray(settings.fields) ? settings.fields : [],
      lost_reasons: Array.isArray(settings.lost_reasons) ? settings.lost_reasons : [],
      won_reasons: Array.isArray(settings.won_reasons) ? (settings.won_reasons as string[]) : [],
      won_reason_required: settings.won_reason_required === true,
      reabertura: settings.reabertura === "novo_negocio" ? "novo_negocio" : "mesmo_registro",
      reabertura_campos: Array.isArray(settings.reabertura_campos)
        ? (settings.reabertura_campos as string[])
        : null,
      comanda_no_ganho: settings.comanda_no_ganho === true,
      entrada_do_inbox: entradaDoInboxDeclarada(settings),
      ocultar_encerrados_dias: diasDeRecorte(settings) ?? 0,
      atalhos: Array.isArray(settings.atalhos) ? settings.atalhos : [],
    },
  };
}

/** Lê a configuração de UM funil da organização. `not_found` para inexistente ou de outra organização. */
export async function lerConfiguracaoDoFunil(
  supabase: SupabaseClient,
  organizationId: string,
  pipelineId: string,
): Promise<ResultadoDaConfiguracao<ConfiguracaoDoFunil>> {
  const { data, error } = await supabase
    .from("crm_pipelines")
    .select("id, name, vocabulary, settings")
    .eq("id", pipelineId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "not_found" };
  return { ok: true, dados: paraConfiguracao(data as Linha) };
}

/**
 * Edição CIRÚRGICA da obrigatoriedade (`settings.campos_obrigatorios`, migration 1015), dentro da
 * mesma trava otimista do merge: recebe o mapa que está no banco NESTA tentativa e devolve o novo.
 * Assim "exija o campo X na etapa Y" nunca desfaz a regra do campo Z que outra aba gravou um instante
 * antes (o `campos_obrigatorios` do patch SUBSTITUI o mapa inteiro; esta forma altera uma chave).
 */
export type EdicaoDeObrigatorios = (atuais: Record<string, unknown>) => Record<string, unknown>;

/**
 * `details.campos_da_organizacao`: a recusa de gravar `fields` num funil cuja organização já tem os
 * campos em `custom_field_definitions` (1015). O banco derivaria `fields` por cima do que viesse —
 * aceitar seria dizer "salvo" e não salvar. `error` já é a frase.
 */
export const CAMPOS_DA_ORGANIZACAO = "campos_da_organizacao";

export const MENSAGEM_CAMPOS_DA_ORGANIZACAO =
  "Os campos personalizados agora são da organização: crie e edite em Configurações › Campos Personalizados (ou pela API /api/v1/custom-fields). No funil fica só a obrigatoriedade por etapa (campos_obrigatorios).";

/** A organização já está no modelo da 1015 (tem ao menos uma definição)? Falha de leitura = não. */
async function organizacaoTemCamposProprios(supabase: SupabaseClient, organizationId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("custom_field_definitions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (error) return false;
  return (count ?? 0) > 0;
}

export interface AutorDaConfiguracao {
  actorUserId?: string | null;
  actorApiTokenId?: string | null;
}

/**
 * Aplica um patch de configuração e audita `pipeline.config_updated`.
 *
 * `vocabulary` faz MERGE (só as chaves enviadas mudam); cada chave de `settings`
 * enviada SUBSTITUI a anterior; as ausentes ficam como estão — e as demais
 * chaves de `settings` (que esta tela não conhece) são preservadas.
 */
export async function aplicarConfiguracaoDoFunil(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    pipelineId: string;
    patch: PipelineConfigPatch;
    /** Altera `campos_obrigatorios` sobre o que está no banco; roda a cada tentativa da trava otimista. */
    editarObrigatorios?: EdicaoDeObrigatorios;
    /** Acrescentado ao `metadata` do audit (ex.: qual campo mudou). Nunca valor de dado de contato. */
    detalheDoAudit?: Record<string, unknown>;
    /** Idioma da frase de recusa (#2791). Padrão `pt-BR`. */
    idioma?: Idioma;
    autor: AutorDaConfiguracao;
    requestId?: string | null;
  },
): Promise<ResultadoDaConfiguracao<ConfiguracaoDoFunil>> {
  const { organizationId, pipelineId } = input;
  if (!pipelineId || typeof pipelineId !== "string") {
    return { ok: false, error: "invalid_request" };
  }
  const parsed = pipelineConfigPatchSchema.safeParse(input.patch);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  // 1015: com os campos na organização, `fields` é projeção do banco — gravá-lo daqui não pegaria.
  if (parsed.data.fields !== undefined && (await organizacaoTemCamposProprios(supabase, organizationId))) {
    return {
      ok: false,
      error: traduzir(MENSAGEM_CAMPOS_DA_ORGANIZACAO, input.idioma ?? "pt-BR"),
      details: { [CAMPOS_DA_ORGANIZACAO]: true },
    };
  }

  // LER-MODIFICAR-GRAVAR com trava otimista: dois salvamentos ao mesmo tempo (duas abas, a tela e um
  // token) liam o MESMO `settings`, cada um mesclava só as suas chaves e o último gravava o objeto
  // inteiro por cima — a chave do primeiro sumia em silêncio. O UPDATE só vale se a linha ainda tem o
  // `updated_at` que foi lido (o gatilho `fn_set_updated_at` o move a cada escrita); senão relê e
  // mescla de novo sobre o que o outro gravou. Depois de 4 corridas seguidas, `conflict` (409).
  let aplicou = false;
  for (let tentativa = 0; tentativa < 4 && !aplicou; tentativa += 1) {
    const { data: row, error: readErr } = await supabase
      .from("crm_pipelines")
      .select("vocabulary, settings, updated_at")
      .eq("id", pipelineId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (readErr) {
      return { ok: false, error: readErr.message, erroDoBanco: { etapa: "leitura", erro: readErr } };
    }
    if (!row) return { ok: false, error: "not_found" };

    const nextVocabulary = parsed.data.vocabulary
      ? { ...((row.vocabulary as Record<string, unknown> | null) ?? {}), ...parsed.data.vocabulary }
      : ((row.vocabulary as Record<string, unknown> | null) ?? {});

    const currentSettings = (row.settings as Record<string, unknown> | null) ?? {};
    const nextSettings: Record<string, unknown> = { ...currentSettings };
    if (parsed.data.fields !== undefined) nextSettings.fields = parsed.data.fields;
    if (parsed.data.campos_obrigatorios !== undefined) {
      nextSettings.campos_obrigatorios = parsed.data.campos_obrigatorios;
    }
    if (input.editarObrigatorios) {
      const bruto = currentSettings.campos_obrigatorios;
      const atuais =
        bruto && typeof bruto === "object" && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {};
      nextSettings.campos_obrigatorios = input.editarObrigatorios(atuais);
    }
    if (parsed.data.lost_reasons !== undefined) nextSettings.lost_reasons = parsed.data.lost_reasons;
    if (parsed.data.won_reasons !== undefined) nextSettings.won_reasons = parsed.data.won_reasons;
    if (parsed.data.won_reason_required !== undefined) {
      nextSettings.won_reason_required = parsed.data.won_reason_required;
    }
    if (parsed.data.comanda_no_ganho !== undefined) {
      nextSettings.comanda_no_ganho = parsed.data.comanda_no_ganho;
    }
    if (parsed.data.reabertura !== undefined) nextSettings.reabertura = parsed.data.reabertura;
    if (parsed.data.reabertura_campos !== undefined) {
      nextSettings.reabertura_campos = parsed.data.reabertura_campos;
    }
    // A entrada do Inbox (issue #3011): a ETAPA em que a conversa nova vira card neste funil.
    // Grava o bloco inteiro, e não campo a campo, porque `ativa` e `stage_id` são uma decisão só.
    if (parsed.data.entrada_do_inbox !== undefined) {
      nextSettings.entrada_do_inbox = parsed.data.entrada_do_inbox;
    }
    // #2995 — o recorte de encerrados antigos do quadro. `0` é um valor com significado
    // ("desliguei") e por isso a chave é gravada como veio.
    if (parsed.data.ocultar_encerrados_dias !== undefined) {
      nextSettings.ocultar_encerrados_dias = parsed.data.ocultar_encerrados_dias;
    }
    // OS ATALHOS DO CARD (#3487). Gravada como veio, inclusive a lista VAZIA: `[]` é o
    // "apaguei todos". Quem barrou o `javascript:` foi o schema.
    if (parsed.data.atalhos !== undefined) {
      nextSettings.atalhos = parsed.data.atalhos;
    }

    // Campo que passa a ser do Contato e que uma regra ativa do gatilho por data lê (#2791):
    // a regra seguiria ligada e pararia de disparar em silêncio. Confere a cada tentativa,
    // sobre o `settings` lido nesta tentativa.
    if (parsed.data.fields !== undefined) {
      const perdem = await regrasDeDataQuePerdemOCampo(
        supabase,
        organizationId,
        pipelineId,
        currentSettings,
        nextSettings,
      );
      if ("erro" in perdem) return { ok: false, error: perdem.erro };
      if (perdem.nomes.length > 0) {
        return {
          ok: false,
          error: mensagemDasRegrasQuePerdemOCampo(perdem.nomes, input.idioma ?? "pt-BR"),
          details: { [REGRAS_PERDEM_O_CAMPO]: perdem.nomes },
        };
      }
    }

    let escrita = supabase
      .from("crm_pipelines")
      .update({ vocabulary: nextVocabulary, settings: nextSettings })
      .eq("id", pipelineId)
      .eq("organization_id", organizationId);
    const versaoLida = (row as { updated_at?: string | null }).updated_at;
    if (versaoLida) escrita = escrita.eq("updated_at", versaoLida);
    const { data: gravadas, error } = await escrita.select("id");
    if (error) return { ok: false, error: error.message, erroDoBanco: { etapa: "gravacao", erro: error } };
    aplicou = (gravadas ?? []).length > 0;
  }
  if (!aplicou) return { ok: false, error: "conflict" };

  await audit({
    action: "pipeline.config_updated",
    actorUserId: input.autor.actorUserId ?? null,
    actorApiTokenId: input.autor.actorApiTokenId ?? null,
    organizationId,
    resourceType: "pipeline",
    resourceId: pipelineId,
    requestId: input.requestId ?? null,
    metadata: {
      vocabulary_changed: !!parsed.data.vocabulary,
      fields_count: parsed.data.fields?.length ?? null,
      campos_obrigatorios_count:
        parsed.data.campos_obrigatorios !== undefined ? Object.keys(parsed.data.campos_obrigatorios).length : null,
      lost_reasons_count: parsed.data.lost_reasons?.length ?? null,
      won_reasons_count: parsed.data.won_reasons?.length ?? null,
      won_reason_required: parsed.data.won_reason_required ?? null,
      reabertura: parsed.data.reabertura ?? null,
      entrada_do_inbox_ativa: parsed.data.entrada_do_inbox?.ativa ?? null,
      // #2995: quantos cards o quadro deixa de mostrar é decisão de quem opera.
      ocultar_encerrados_dias: parsed.data.ocultar_encerrados_dias ?? null,
      // #3487: quantos atalhos. O CONTEÚDO não entra: o link montado carrega dado do cliente.
      atalhos_count: parsed.data.atalhos?.length ?? null,
      ...(input.detalheDoAudit ?? {}),
    },
  });

  return lerConfiguracaoDoFunil(supabase, organizationId, pipelineId);
}
