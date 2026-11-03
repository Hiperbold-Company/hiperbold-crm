"use client";

/**
 * Formulários dos blocos do Instagram (automação de comentário): "Responder em
 * privado", "Responder no comentário" e "Confere se segue". O texto aceita
 * variáveis; quem confere o tamanho em bytes depois de renderizar é o canal.
 */
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import {
  MAX_TEXTO_DA_RESPOSTA_AO_COMENTARIO,
  type InstagramReplyConfig,
} from "@/lib/followup/graph-schema";
import { cn } from "@/lib/utils";

import { AjudaDeVariaveis, Campo, type RespostaDisponivel } from "./comum";

/** Aviso fixo do bloco público (decisão do produto). */
export const AVISO_DA_RESPOSTA_PUBLICA =
  "Responder todos os comentários em público é lido como spam pela Meta. Use com moderação.";

function TextoDaResposta({
  id,
  rotulo,
  config,
  onChange,
  respostas,
}: {
  id: string;
  rotulo: string;
  config: InstagramReplyConfig;
  onChange: (c: InstagramReplyConfig) => void;
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
        onChange={(e) => onChange({ text: e.target.value })}
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
  config: InstagramReplyConfig;
  onChange: (c: InstagramReplyConfig) => void;
  respostas?: RespostaDisponivel[];
}) {
  const t = useT();
  return (
    <div className="space-y-3" data-testid="instagram-publica-form">
      <p
        className="rounded-sm border border-warning bg-warning-bg p-2 text-xs text-warning-fg"
        role="note"
      >
        {t(AVISO_DA_RESPOSTA_PUBLICA)}
      </p>
      <TextoDaResposta
        id="instagram-publica-texto"
        rotulo={t("Resposta no comentário")}
        {...props}
      />
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
