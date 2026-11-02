"use client";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useUpdateWebhookSource,
  type UpdateWebhookSourceInput,
  type WebhookSourceRow,
} from "@/hooks/webhooks/useWebhookSources";
import { useT } from "@/hooks/i18n/useT";
import { FunilEEtapa } from "./FunilEEtapa";

interface Props {
  source: WebhookSourceRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type CampoDoMapa = "name" | "phone" | "email";
const CAMPOS: readonly CampoDoMapa[] = ["name", "phone", "email"];

/** `field_map` gravado → lista limpa. O tipo da linha é `Record<string, unknown>`. */
function listaDoMapa(
  fieldMap: Record<string, unknown> | null | undefined,
  campo: CampoDoMapa,
): string[] {
  const v = fieldMap?.[campo];
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
}

/** "a, b ,, c" → ["a", "b", "c"]. */
function listaDoTexto(texto: string): string[] {
  return texto
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

function mesmaLista(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Edita uma fonte de captação já criada: nome, destino, página de obrigado e
 * os nomes dos campos do formulário.
 *
 * Só vai no PATCH o que mudou. Funil e etapa vão SEMPRE juntos quando um dos
 * dois mudou: a rota confere o par (etapa do funil, os dois da organização), e
 * renomear uma fonte cuja etapa foi arquivada não deve ser barrado por isso.
 */
export function EditSourceDialog({ source, open, onOpenChange }: Props) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Editar fonte")}</DialogTitle>
          <DialogDescription>
            {t("As mudanças valem para os próximos envios. O endereço da fonte continua o mesmo.")}
          </DialogDescription>
        </DialogHeader>
        {/* O conteúdo do Dialog desmonta ao fechar: cada abertura monta o
            formulário de novo, a partir do que está gravado AGORA — não do que
            ficou digitado da última vez que alguém cancelou. */}
        <FormularioDeEdicao source={source} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function FormularioDeEdicao({
  source,
  onOpenChange,
}: {
  source: WebhookSourceRow;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const update = useUpdateWebhookSource();

  const [name, setName] = React.useState(source.name);
  const [pipelineId, setPipelineId] = React.useState(source.default_pipeline_id);
  const [stageId, setStageId] = React.useState(source.default_stage_id);
  const [redirectTo, setRedirectTo] = React.useState(source.redirect_to ?? "");
  const [campos, setCampos] = React.useState<Record<CampoDoMapa, string>>(() => ({
    name: listaDoMapa(source.field_map, "name").join(", "),
    phone: listaDoMapa(source.field_map, "phone").join(", "),
    email: listaDoMapa(source.field_map, "email").join(", "),
  }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nome = name.trim();
    if (!nome) {
      toast.error(t("Dê um nome para a fonte."));
      return;
    }
    if (!pipelineId || !stageId) {
      toast.error(t("Escolha o funil e o estágio de entrada."));
      return;
    }
    const redirect = redirectTo.trim();
    if (redirect && !/^https?:\/\/\S+$/i.test(redirect)) {
      toast.error(
        t("A página de obrigado precisa ser um endereço completo, começando com https://"),
      );
      return;
    }

    const patch: UpdateWebhookSourceInput = {};
    if (nome !== source.name) patch.name = nome;
    if (pipelineId !== source.default_pipeline_id || stageId !== source.default_stage_id) {
      patch.default_pipeline_id = pipelineId;
      patch.default_stage_id = stageId;
    }
    if ((redirect || null) !== (source.redirect_to || null)) patch.redirect_to = redirect || null;

    const mudouMapa = CAMPOS.some(
      (c) => !mesmaLista(listaDoTexto(campos[c]), listaDoMapa(source.field_map, c)),
    );
    if (mudouMapa) {
      // O PATCH troca o mapa inteiro; campo em branco sai, e aí valem os nomes comuns.
      const mapa: NonNullable<UpdateWebhookSourceInput["field_map"]> = {};
      for (const c of CAMPOS) {
        const lista = listaDoTexto(campos[c]);
        if (lista.length > 0) mapa[c] = lista;
      }
      patch.field_map = mapa;
    }

    if (Object.keys(patch).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      await update.mutateAsync({ id: source.id, ...patch });
      toast.success(t("Fonte atualizada."));
      onOpenChange(false);
    } catch {
      /* a mensagem da API já foi mostrada pelo showApiError do hook */
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="edit-src-name">{t("Nome")}</Label>
        <Input
          id="edit-src-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          required
        />
      </div>
      <FunilEEtapa
        idPrefix="edit-src"
        pipelineId={pipelineId}
        stageId={stageId}
        onPipelineChange={setPipelineId}
        onStageChange={setStageId}
      />
      <div className="space-y-2">
        <Label htmlFor="edit-src-redirect">{t("Página de obrigado (opcional)")}</Label>
        <Input
          id="edit-src-redirect"
          // Sem `type="url"`: a validação do navegador barraria o envio com
          // uma frase genérica dele; a conferência abaixo diz o que corrigir.
          inputMode="url"
          value={redirectTo}
          onChange={(e) => setRedirectTo(e.target.value)}
          placeholder="https://tusitio.com/gracias"
        />
        <p className="text-xs text-muted-foreground">
          {t(
            "Para onde enviar a pessoa depois que ela preencher seu formulário. Em branco, ela não é redirecionada.",
          )}
        </p>
      </div>
      <fieldset className="space-y-3 rounded-sm border border-border p-3">
        <legend className="px-1 text-sm font-medium text-text">
          {t("Campos do seu formulário")}
        </legend>
        <p className="text-xs text-muted-foreground">
          {t(
            "Use o nome do campo como o seu formulário envia, por exemplo form_fields[phone] ou contato_celular. Pode pôr vários, separados por vírgula. Em branco, o CRM reconhece os nomes comuns sozinho.",
          )}
        </p>
        <CampoDoFormulario
          id="edit-src-map-name"
          rotulo={t("Campo do nome")}
          comuns="name, nome, full_name, fullname"
          valor={campos.name}
          onChange={(v) => setCampos((c) => ({ ...c, name: v }))}
        />
        <CampoDoFormulario
          id="edit-src-map-phone"
          rotulo={t("Campo do telefone")}
          comuns="phone, telefone, whatsapp, celular, phone_number, tel"
          valor={campos.phone}
          onChange={(v) => setCampos((c) => ({ ...c, phone: v }))}
        />
        <CampoDoFormulario
          id="edit-src-map-email"
          rotulo={t("Campo do e-mail")}
          comuns="email, e-mail, mail"
          valor={campos.email}
          onChange={(v) => setCampos((c) => ({ ...c, email: v }))}
        />
      </fieldset>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          {t("Cancelar")}
        </Button>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? t("Salvando…") : t("Salvar")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Os nomes comuns vêm de `DEFAULT_FIELD_MAP` em `lib/webhooks/inbound.ts`
 * (módulo de servidor, por isso repetidos aqui). Mudou lá, muda aqui: o teste
 * `editar-fonte-de-captacao` compara as duas listas.
 */
function CampoDoFormulario({
  id,
  rotulo,
  comuns,
  valor,
  onChange,
}: {
  id: string;
  rotulo: string;
  comuns: string;
  valor: string;
  onChange: (v: string) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{rotulo}</Label>
      <Input id={id} value={valor} onChange={(e) => onChange(e.target.value)} />
      <p className="text-xs text-muted-foreground">
        {t("Já reconhecidos sozinhos:")} <span className="font-mono">{comuns}</span>
      </p>
    </div>
  );
}
