"use client";

import { useT } from "@/hooks/i18n/useT";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import type { Lead } from "@/lib/types/leads";
import { updateLeadSchema, type UpdateLeadInput } from "@/lib/schemas/leads";
import { parseReaisToCents } from "@/lib/money";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { agruparCampos, ROTULO_DO_GRUPO, type GrupoDeCampo } from "@/lib/leads/grupo-do-campo";
import { SeletorDeEtiquetas } from "@/components/tags/SeletorDeEtiquetas";
import { TETO_DE_TAGS, TETO_DO_TAMANHO_DA_TAG_DO_LEAD } from "@/lib/schemas/tetos";
import { CaretDown, CaretRight } from "@/lib/ui/icons";
import { EcoDoValor } from "./EcoDoValor";

interface FormShape {
  title: string;
  description: string;
  valueReais: string;
  expected_close_date: string;
}

interface Props {
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
  /** Quando o salvamento dá certo. O dossiê NÃO fecha aqui — ver abaixo. */
  onSaved?: () => void;
  /** O dossiê não tem "cancelar"; o diálogo tem. */
  onCancel?: () => void;
}

function centsToReais(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

/**
 * Os campos do lead — extraídos do `EditLeadDialog` para o dossiê usar os
 * MESMOS, em vez de uma cópia que diverge no mês.
 *
 * `onSaved` existe para o dossiê NÃO FECHAR ao salvar: quem edita precisa ver a
 * atividade que acabou de gerar entrar na timeline. Fechar esconderia o
 * registro justamente de quem o produziu — a funcionalidade que prova "sua ação
 * fica registrada" provaria isso para todo mundo menos para o autor.
 */
export function LeadFieldsForm({ lead, pipelineId, fieldDefs = [], onSaved, onCancel }: Props) {
  const t = useT();
  const edit = useEditLead(pipelineId);
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(lead.custom_fields ?? {});
  // As etiquetas do NEGÓCIO moram no estado do formulário (não gravam ao marcar):
  // entram no patch do "Salvar", como o campo de texto fazia.
  const [tags, setTags] = useState<string[]>(lead.tags ?? []);

  const form = useForm<FormShape>({
    defaultValues: {
      title: lead.title,
      description: lead.description ?? "",
      valueReais: centsToReais(lead.value_cents),
      expected_close_date: lead.expected_close_date ?? "",
    },
  });

  useEffect(() => {
    form.reset({
      title: lead.title,
      description: lead.description ?? "",
      valueReais: centsToReais(lead.value_cents),
      expected_close_date: lead.expected_close_date ?? "",
    });
    setCustomFields(lead.custom_fields ?? {});
    setTags(lead.tags ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id]);

  async function onSubmit(values: FormShape) {
    const reais = values.valueReais.trim();
    let valueCents: number | null = null;
    if (reais.length > 0) {
      valueCents = parseReaisToCents(reais);
      if (valueCents === null) {
        form.setError("valueReais", { message: t("Valor inválido") });
        return;
      }
    }

    const patch: Record<string, unknown> = {
      title: values.title.trim(),
      description: values.description.trim() ? values.description.trim() : null,
      value_cents: valueCents,
      tags,
      expected_close_date: values.expected_close_date || null,
      ...(fieldDefs.length > 0 ? { custom_fields: customFields } : {}),
    };

    const parsed = updateLeadSchema.safeParse(patch);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? t("Dados inválidos"));
      return;
    }

    try {
      await edit.mutateAsync({
        leadId: lead.id,
        patch: parsed.data as UpdateLeadInput,
      });
      toast.success(t("Lead atualizado"));
      onSaved?.();
    } catch {
      // toast already shown
    }
  }


  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="title">{t("Título")}</Label>
          <Input
            id="title"
            {...form.register("title", { required: true, minLength: 2 })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">{t("Descrição")}</Label>
          <Textarea id="description" rows={3} {...form.register("description")} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="valueReais">{t("Valor (R$)")}</Label>
            <Input
              id="valueReais"
              inputMode="decimal"
              placeholder="0,00"
              {...form.register("valueReais")}
            />
            <EcoDoValor control={form.control} />
            {form.formState.errors.valueReais && (
              <p className="text-xs text-error-fg">
                {t(form.formState.errors.valueReais.message ?? "")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="expected_close_date">{t("Fechamento previsto")}</Label>
            <Input
              id="expected_close_date"
              type="date"
              {...form.register("expected_close_date")}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>{t("Tags")}</Label>
          <SeletorDeEtiquetas
            orgId={lead.organization_id}
            value={tags}
            onChange={setTags}
            limite={TETO_DE_TAGS}
            tamanhoMaximo={TETO_DO_TAMANHO_DA_TAG_DO_LEAD}
            // O negócio guarda a grafia do cadastro ("Novo Paciente"), só aparada.
            paraGravar={(tag) => tag.trim().slice(0, TETO_DO_TAMANHO_DA_TAG_DO_LEAD)}
            rotuloDoCampo={t("Adicionar tag ao negócio")}
            disabled={edit.isPending}
            className="space-y-2 rounded-md border border-border p-2"
          />
        </div>

        {agruparCampos(fieldDefs).map((bloco) => (
          <BlocoDeCampos
            // `lead.id` na chave: ao trocar de negócio o bloco recomeça no estado
            // inicial (recolhido, ou aberto se o funil exige algum campo dele).
            key={`${bloco.grupo}:${lead.id}`}
            grupo={bloco.grupo}
            campos={bloco.campos}
            valores={customFields}
            onChange={setCustomFields}
          />
        ))}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={edit.isPending}>
            {t("Cancelar")}
          </Button>
        )}
        <Button type="submit" disabled={edit.isPending}>
          {edit.isPending ? t("Salvando…") : t("Salvar")}
        </Button>
      </div>
    </form>
  );
}

/** O funil exige este campo em algum momento (destaque ou gatilho de etapa/ganho/perda). */
function campoExigido(c: CustomFieldDef): boolean {
  const o = c.obrigatorio_em;
  return Boolean(c.required || (o && ((o.etapas?.length ?? 0) > 0 || o.ao_ganhar || o.ao_perder)));
}

/**
 * Um bloco de campos do funil na ficha: "Dados do lead" e "Rastreamento".
 *
 * "Dados do lead" fica sempre aberto. "Rastreamento" (utm_*, gclid…) nasce
 * RECOLHIDO: são parâmetros que quase ninguém edita à mão, e vinte linhas de
 * utm antes do botão Salvar empurram o que importa para fora da tela. O
 * cabeçalho diz quantos estão preenchidos, para o recolhido não parecer vazio.
 * Abre sozinho se o funil exigir algum campo do bloco (`required` ou `obrigatorio_em`) — esconder o campo que o
 * funil exige faria o erro de salvar apontar para algo invisível.
 *
 * Os valores continuam no estado do formulário (`valores`), recolhido ou não: o
 * Salvar grava os dois blocos de uma vez.
 */
function BlocoDeCampos({
  grupo,
  campos,
  valores,
  onChange,
}: {
  grupo: GrupoDeCampo;
  campos: CustomFieldDef[];
  valores: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const t = useT();
  const recolhivel = grupo === "rastreamento";
  const exigeAbrir = campos.some(campoExigido);
  const [aberto, setAberto] = useState(!recolhivel || exigeAbrir);
  const preenchidos = campos.filter((c) => {
    const v = valores[c.key];
    return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  }).length;

  return (
    <section
      className="space-y-2 border-t border-border pt-4"
      data-bloco-de-campos={grupo}
      aria-label={t(ROTULO_DO_GRUPO[grupo])}
    >
      {recolhivel ? (
        <button
          type="button"
          onClick={() => setAberto((v) => !v)}
          aria-expanded={aberto}
          className="flex w-full items-center gap-1.5 text-left text-sm font-medium hover:text-text"
        >
          {aberto ? <CaretDown size={12} aria-hidden /> : <CaretRight size={12} aria-hidden />}
          {t(ROTULO_DO_GRUPO[grupo])}
          <span className="text-xs font-normal text-text-muted">
            · {preenchidos}/{campos.length} {t("preenchidos")}
          </span>
        </button>
      ) : (
        <p className="text-sm font-medium">{t(ROTULO_DO_GRUPO[grupo])}</p>
      )}
      {aberto && (
        <CustomFieldsEditor fields={campos} value={valores} onChange={onChange} mode="lead" />
      )}
    </section>
  );
}
