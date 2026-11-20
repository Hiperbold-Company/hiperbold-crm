"use client";

/**
 * Formulários dos blocos do Instagram (automação de comentário): "Responder em
 * privado", "Responder no comentário" e "Confere se segue". O texto aceita
 * variáveis; quem confere o tamanho em bytes depois de renderizar é o canal.
 */
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import {
  MAX_TEXTO_DA_RESPOSTA_AO_COMENTARIO,
  MAX_VERSOES_EXTRAS_DA_RESPOSTA_PUBLICA,
  type InstagramPublicReplyConfig,
  type InstagramReplyConfig,
} from "@/lib/followup/graph-schema";
import { Trash } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { AjudaDeVariaveis, Campo, type RespostaDisponivel } from "./comum";

/** Aviso fixo do bloco público (decisão do produto). */
export const AVISO_DA_RESPOSTA_PUBLICA =
  "Responder todos os comentários em público é lido como spam pela Meta. Use com moderação.";

function TextoDaResposta<C extends InstagramReplyConfig>({
  id,
  rotulo,
  config,
  onChange,
  respostas,
}: {
  id: string;
  rotulo: string;
  config: C;
  onChange: (c: C) => void;
  respostas?: RespostaDisponivel[];
}) {
  const t = useT();
  return (
    <Campo id={id} rotulo={rotulo}>
      <Textarea
        id={id}
        data-testid={id}
        rows={4}
        maxLength={MAX_TEXTO_DA_RESPOSTA_AO_COMENTARIO}
        value={config.text}
        onChange={(e) => onChange({ ...config, text: e.target.value })}
      />
      <p
        className={cn(
          "text-right text-xs",
          config.text.length > MAX_TEXTO_DA_RESPOSTA_AO_COMENTARIO
            ? "text-error-fg"
            : "text-text-muted",
        )}
      >
        {config.text.length} / {MAX_TEXTO_DA_RESPOSTA_AO_COMENTARIO}
      </p>
      <AjudaDeVariaveis
        respostas={respostas ?? []}
        onInserir={(v) =>
          onChange({
            ...config,
            text: `${config.text}${config.text && !config.text.endsWith(" ") ? " " : ""}${v}`,
          })
        }
        testId={`${id}-variaveis`}
      />
      <p className="text-xs text-text-muted">
        {t(
          "Do comentário: {{gatilho.autor_usuario}} (quem comentou) e {{gatilho.texto}} (o que escreveu).",
        )}
      </p>
    </Campo>
  );
}

export function RespostaPrivadaForm(props: {
  config: InstagramReplyConfig;
  onChange: (c: InstagramReplyConfig) => void;
  respostas?: RespostaDisponivel[];
}) {
  const t = useT();
  return (
    <div className="space-y-3" data-testid="instagram-privada-form">
      <TextoDaResposta id="instagram-privada-texto" rotulo={t("Mensagem no Direct")} {...props} />
      <p className="text-xs text-text-muted">
        {t("Uma resposta privada por comentário, em até 7 dias depois do comentário.")}
      </p>
    </div>
  );
}

export function RespostaPublicaForm(props: {
  config: InstagramPublicReplyConfig;
  onChange: (c: InstagramPublicReplyConfig) => void;
  respostas?: RespostaDisponivel[];
}) {
  const t = useT();
  const { config, onChange } = props;
  const extras = config.variations ?? [];
  const cheio = extras.length >= MAX_VERSOES_EXTRAS_DA_RESPOSTA_PUBLICA;
  /** Grava as versões extras; lista vazia some da config (sem a chave `variations`). */
  function gravarExtras(novas: string[]) {
    const { variations: _antigas, ...resto } = config;
    onChange(novas.length > 0 ? { ...resto, variations: novas } : resto);
  }
  return (
    <div className="space-y-3" data-testid="instagram-publica-form">
      <p
        className="rounded-sm border border-warning bg-warning-bg p-2 text-xs text-warning-fg"
        role="note"
      >
        {t(AVISO_DA_RESPOSTA_PUBLICA)}
      </p>
      <TextoDaResposta id="instagram-publica-texto" rotulo={t("Versão 1")} {...props} />
      {extras.map((v, i) => {
        const n = i + 2;
        const id = `instagram-publica-versao-${n}`;
        return (
          <Campo key={n} id={id} rotulo={`${t("Versão")} ${n}`}>
            <Textarea
              id={id}
              data-testid={id}
              rows={3}
              maxLength={MAX_TEXTO_DA_RESPOSTA_AO_COMENTARIO}
              value={v}
              onChange={(e) => gravarExtras(extras.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid={`instagram-publica-remover-versao-${n}`}
                aria-label={`${t("Remover versão")} ${n}`}
                onClick={() => gravarExtras(extras.filter((_, j) => j !== i))}
              >
                <Trash className="size-4" aria-hidden />
              </Button>
              <p
                className={cn(
                  "text-xs",
                  v.length > MAX_TEXTO_DA_RESPOSTA_AO_COMENTARIO
                    ? "text-error-fg"
                    : "text-text-muted",
                )}
              >
                {v.length} / {MAX_TEXTO_DA_RESPOSTA_AO_COMENTARIO}
              </p>
            </div>
          </Campo>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="instagram-publica-adicionar-versao"
        disabled={cheio}
        {...(cheio ? { title: t("Limite de 10 versões") } : {})}
        onClick={() => gravarExtras([...extras, ""])}
      >
        {t("Adicionar outra versão")}
      </Button>
      <p className="text-xs text-text-muted">
        {t(
          "Com mais de uma versão, cada comentário recebe uma delas, sorteada. Variar o texto ajuda a não parecer spam para o Instagram.",
        )}
      </p>
      <p className="text-xs text-text-muted">
        {t("Se houver resposta privada, ela vem antes desta no caminho.")}
      </p>
    </div>
  );
}

export function ConfereSeSegueForm() {
  const t = useT();
  return (
    <p className="text-sm text-text-muted" data-testid="instagram-segue-form">
      {t(
        "Confere se quem comentou segue o perfil. O Instagram só informa depois que a pessoa manda mensagem no Direct; antes disso, a saída é “Não deu para saber”.",
      )}
    </p>
  );
}
