"use client";

/**
 * Os campos dos gatilhos do lote 3 (mensagem recebida, tag, agendamento,
 * aniversário, data do negócio, sem resposta, caso aberto, iniciada por outra
 * automação). Cada mudança sobe o gatilho inteiro; quem decide se ele está
 * completo é o schema, no `AutomationTriggerForm`.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useEtiquetasParaEscolher } from "@/hooks/contacts/useEtiquetasParaEscolher";
import { useT } from "@/hooks/i18n/useT";
import {
  EVENTOS_DE_AGENDAMENTO,
  MAX_PALAVRAS_CHAVE,
  MODOS_DA_PALAVRA_CHAVE,
  normalizarParaPalavraChave,
  palavraChaveSchema,
  type AutomacaoTrigger,
  type CampoDeDataDoNegocio,
  type ModoDaPalavraChave,
} from "@/lib/automacoes/schemas";
import {
  ALVOS,
  CAMPOS_PADRAO_DO_NEGOCIO,
  EVENTOS_DE_AGENDAMENTO_ROTULOS,
  MODOS_DA_PALAVRA_CHAVE_ROTULOS,
} from "@/lib/automacoes/vocabulario";
import { X } from "@/lib/ui/icons";

import {
  Campo,
  Seletor,
  TempoComUnidade,
  useAutomacoesDaOrganizacao,
  useCamposPersonalizados,
} from "./comum";

type Gatilho<K extends AutomacaoTrigger["kind"]> = Extract<AutomacaoTrigger, { kind: K }>;

/** Caixa de marcar com rótulo ao lado (nativa: a prova pela tela clica pelo rótulo). */
export function Marcador({
  id,
  rotulo,
  marcado,
  onChange,
}: {
  id: string;
  rotulo: string;
  marcado: boolean;
  onChange: (marcado: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-text">
      <input
        id={id}
        type="checkbox"
        data-testid={id}
        checked={marcado}
        onChange={(e) => onChange(e.target.checked)}
      />
      {rotulo}
    </label>
  );
}

/**
 * Lista de palavras em "chips": digita, Enter (ou o botão) acrescenta, o X
 * tira. `validar` devolve a mensagem de erro, ou `null` quando a palavra serve.
 */
function ListaDeChips({
  id,
  itens,
  onChange,
  validar,
  max,
  placeholder,
}: {
  id: string;
  itens: string[];
  onChange: (itens: string[]) => void;
  validar: (texto: string) => string | null;
  max: number;
  placeholder?: string;
}) {
  const t = useT();
  const [texto, setTexto] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const acrescentar = () => {
    const limpo = texto.trim();
    if (!limpo) return;
    const problema = validar(limpo);
    if (problema) {
      setErro(problema);
      return;
    }
    setErro(null);
    setTexto("");
    onChange([...itens, limpo]);
  };
  return (
    <div className="space-y-1.5">
      {itens.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid={`${id}-lista`}>
          {itens.map((item, j) => (
            <span
              key={`${item}-${j}`}
              className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-xs text-text"
              data-testid={`${id}-chip-${j}`}
            >
              {item}
              <button
                type="button"
                aria-label={`${t("Remover")} ${item}`}
                onClick={() => onChange(itens.filter((_, k) => k !== j))}
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      {itens.length < max && (
        <div className="flex gap-2">
          <Input
            id={id}
            data-testid={id}
            value={texto}
            maxLength={100}
            placeholder={placeholder}
            onChange={(e) => {
              setTexto(e.target.value);
              setErro(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                acrescentar();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={`${id}-adicionar`}
            disabled={!texto.trim()}
            onClick={acrescentar}
          >
            {t("Adicionar")}
          </Button>
        </div>
      )}
      {erro && (
        <p className="text-xs text-error-fg" data-testid={`${id}-erro`}>
          {erro}
        </p>
      )}
    </div>
  );
}

/** Os campos do gatilho, para os tipos do lote 3. Os do lote 1 continuam no formulário. */
export function CamposDoGatilho({
  prefixo,
  gatilho,
  onChange,
  flowId,
}: {
  prefixo: string;
  gatilho: AutomacaoTrigger;
  onChange: (g: AutomacaoTrigger) => void;
  /** A automação aberta: não aparece na lista de quem pode iniciá-la. */
  flowId?: string;
}) {
  switch (gatilho.kind) {
    case "message_received":
      return <CamposDaMensagem prefixo={prefixo} g={gatilho} onChange={onChange} />;
    case "tag_added":
      return <CamposDaTag prefixo={prefixo} g={gatilho} onChange={onChange} />;
    case "appointment":
      return <CamposDoAgendamento prefixo={prefixo} g={gatilho} onChange={onChange} />;
    case "birthday":
      return <TextoDoAniversario />;
    case "date_field":
      return <CamposDaData prefixo={prefixo} g={gatilho} onChange={onChange} />;
    case "no_reply":
      return <CamposDoSemResposta prefixo={prefixo} g={gatilho} onChange={onChange} />;
    case "case_opened":
      return <TextoDoCaso />;
    case "started_by_automation":
      return (
        <CamposDoIniciador
          prefixo={prefixo}
          g={gatilho}
          onChange={onChange}
          {...(flowId !== undefined ? { flowId } : {})}
        />
      );
    default:
      return null;
  }
}

function CamposDaMensagem({
  prefixo,
  g,
  onChange,
}: {
  prefixo: string;
  g: Gatilho<"message_received">;
  onChange: (g: AutomacaoTrigger) => void;
}) {
  const t = useT();
  const canais = useChannelSessions();
  const escolhidos = g.channel_session_ids ?? [];
  const marcarCanal = (id: string, marcado: boolean) => {
    const proximos = marcado ? [...escolhidos, id] : escolhidos.filter((x) => x !== id);
    const { channel_session_ids: _antes, ...resto } = g;
    onChange(proximos.length > 0 ? { ...resto, channel_session_ids: proximos } : resto);
  };
  return (
    <>
      <Campo
        id={`${prefixo}-modo`}
        rotulo={t("Qual mensagem")}
        ajuda={t("Compara palavras inteiras, sem acento e sem diferenciar maiúsculas.")}
      >
        <Seletor
          id={`${prefixo}-modo`}
          valor={g.match}
          opcoes={MODOS_DA_PALAVRA_CHAVE.map((m) => ({
            valor: m,
            rotulo: t(MODOS_DA_PALAVRA_CHAVE_ROTULOS[m]),
          }))}
          onChange={(v) => onChange({ ...g, match: v as ModoDaPalavraChave })}
        />
      </Campo>
      {g.match !== "any" && (
        <Campo id={`${prefixo}-palavra`} rotulo={t("Palavras-chave")}>
          <ListaDeChips
            id={`${prefixo}-palavra`}
            itens={g.keywords}
            max={MAX_PALAVRAS_CHAVE}
            placeholder={t("Ex.: preço")}
            onChange={(keywords) => onChange({ ...g, keywords })}
            validar={(texto) => {
              const r = palavraChaveSchema.safeParse(texto);
              if (!r.success) return t(r.error.issues[0]?.message ?? "");
              const chave = normalizarParaPalavraChave(texto);
              if (g.keywords.some((k) => normalizarParaPalavraChave(k) === chave))
                return t("Essa palavra-chave já está na lista.");
              return null;
            }}
          />
        </Campo>
      )}
      <fieldset className="space-y-1.5" data-testid={`${prefixo}-canais`}>
        <legend className="text-sm font-medium text-text">{t("Por quais números")}</legend>
        <p className="text-xs text-text-muted">
          {t("Nenhum marcado = qualquer número conectado.")}
        </p>
        {(canais.data ?? []).map((c) => (
          <Marcador
            key={c.id}
            id={`${prefixo}-canal-${c.id}`}
            rotulo={channelLabel(c, t)}
            marcado={escolhidos.includes(c.id)}
            onChange={(m) => marcarCanal(c.id, m)}
          />
        ))}
        {canais.isError && (
          <p className="text-xs text-error-fg">{t("Não foi possível carregar os números.")}</p>
        )}
      </fieldset>
      <Marcador
        id={`${prefixo}-so-primeira`}
        rotulo={t("Só a primeira mensagem da conversa")}
        marcado={g.only_first_message === true}
        onChange={(m) => {
          const { only_first_message: _antes, ...resto } = g;
          onChange(m ? { ...resto, only_first_message: true } : resto);
        }}
      />
      <Marcador
        id={`${prefixo}-sem-atendente`}
        rotulo={t("Não disparar se um atendente estiver cuidando da conversa")}
        marcado={g.skip_if_human !== false}
        onChange={(m) => onChange({ ...g, skip_if_human: m })}
      />
    </>
  );
}

function CamposDaTag({
  prefixo,
  g,
  onChange,
}: {
  prefixo: string;
  g: Gatilho<"tag_added">;
  onChange: (g: AutomacaoTrigger) => void;
}) {
  const t = useT();
  const org = useActiveOrg();
  const vocabulario = useEtiquetasParaEscolher(org?.orgId ?? null);
  const escolhidas = new Set(g.tags.map((x) => x.toLowerCase()));
  const disponiveis = (vocabulario.data ?? []).filter((o) => !escolhidas.has(o.tag.toLowerCase()));
  return (
    <>
      <Campo id={`${prefixo}-alvo`} rotulo={t("Em quem")}>
        <Seletor
          id={`${prefixo}-alvo`}
          valor={g.target}
          opcoes={(Object.keys(ALVOS) as Array<keyof typeof ALVOS>).map((k) => ({
            valor: k,
            rotulo: t(ALVOS[k]),
          }))}
          onChange={(v) => onChange({ ...g, target: v as "lead" | "contact" })}
        />
      </Campo>
      <Campo
        id={`${prefixo}-tag`}
        rotulo={t("Tags")}
        ajuda={t("Tags postas em massa (ação em lote ou planilha) não disparam a automação.")}
      >
        {g.tags.length < 20 && disponiveis.length > 0 && (
          <Seletor
            id={`${prefixo}-tag-existente`}
            valor=""
            vazio={t("Escolher uma tag existente")}
            opcoes={disponiveis.map((o) => ({ valor: o.tag, rotulo: o.tag }))}
            onChange={(v) => v && onChange({ ...g, tags: [...g.tags, v] })}
          />
        )}
        <ListaDeChips
          id={`${prefixo}-tag`}
          itens={g.tags}
          max={20}
          placeholder={t("Ou digite uma tag")}
          onChange={(tags) => onChange({ ...g, tags })}
          validar={(texto) => {
            if (texto.length > 60) return t("A tag pode ter até 60 caracteres.");
            if (escolhidas.has(texto.toLowerCase())) return t("Essa tag já está na lista.");
            return null;
          }}
        />
      </Campo>
    </>
  );
}

function CamposDoAgendamento({
  prefixo,
  g,
  onChange,
}: {
  prefixo: string;
  g: Gatilho<"appointment">;
  onChange: (g: AutomacaoTrigger) => void;
}) {
  const t = useT();
  return (
    <fieldset className="space-y-1.5" data-testid={`${prefixo}-eventos`}>
      <legend className="text-sm font-medium text-text">{t("Quando o horário for")}</legend>
      {EVENTOS_DE_AGENDAMENTO.map((ev) => (
        <Marcador
          key={ev}
          id={`${prefixo}-evento-${ev}`}
          rotulo={t(EVENTOS_DE_AGENDAMENTO_ROTULOS[ev])}
          marcado={g.events.includes(ev)}
          onChange={(m) =>
            onChange({
              ...g,
              // Na ordem da lista, não na do clique: a config não muda por ordem de marcação.
              events: EVENTOS_DE_AGENDAMENTO.filter((x) =>
                x === ev ? m : g.events.includes(x),
              ),
            })
          }
        />
      ))}
    </fieldset>
  );
}

function TextoDoAniversario() {
  const t = useT();
  // A varredura `contact-birthdays` age às 9h no fuso da organização.
  return <p className="text-xs text-text-muted">{t("No dia do aniversário do contato, às 9h.")}</p>;
}

function TextoDoCaso() {
  const t = useT();
  return (
    <p className="text-xs text-text-muted">
      {t("Começa quando um caso é aberto na Central para o contato.")}
    </p>
  );
}

const valorDoCampoDeData = (f: CampoDeDataDoNegocio) => `${f.scope}:${f.key}`;

function CamposDaData({
  prefixo,
  g,
  onChange,
}: {
  prefixo: string;
  g: Gatilho<"date_field">;
  onChange: (g: AutomacaoTrigger) => void;
}) {
  const t = useT();
  const personalizados = useCamposPersonalizados().filter((c) => c.type === "date");
  const atual = valorDoCampoDeData(g.field);
  const opcoes = [
    {
      valor: "lead:expected_close_date",
      rotulo: t(CAMPOS_PADRAO_DO_NEGOCIO.expected_close_date),
    },
    ...personalizados.map((c) => ({ valor: `lead_custom:${c.key}`, rotulo: c.label })),
  ];
  // Campo gravado que não está mais declarado em funil nenhum: continua visível.
  if (!opcoes.some((o) => o.valor === atual))
    opcoes.push({ valor: atual, rotulo: g.field.key });
  const [dias, setDias] = useState(String(Math.abs(g.offset_days)));
  const [sentido, setSentido] = useState<"antes" | "depois">(g.offset_days > 0 ? "depois" : "antes");
  const emitirDias = (texto: string, s: "antes" | "depois") => {
    const n = Number(texto);
    // Fora de 0..365 o schema recusa e o formulário mostra o aviso.
    const valido = texto.trim() !== "" && Number.isInteger(n) && n >= 0;
    onChange({ ...g, offset_days: valido ? (s === "depois" ? n : -n) : 9999 });
  };
  return (
    <>
      <Campo id={`${prefixo}-campo-data`} rotulo={t("Campo de data")}>
        <Seletor
          id={`${prefixo}-campo-data`}
          valor={atual}
          opcoes={opcoes}
          onChange={(v) => {
            const i = v.indexOf(":");
            const scope = v.slice(0, i);
            const key = v.slice(i + 1);
            onChange({
              ...g,
              field:
                scope === "lead_custom"
                  ? { scope: "lead_custom", key }
                  : { scope: "lead", key: "expected_close_date" },
            });
          }}
        />
      </Campo>
      <Campo
        id={`${prefixo}-dias`}
        rotulo={t("Quantos dias")}
        ajuda={t("0 = no próprio dia da data.")}
      >
        <div className="flex gap-2">
          <Input
            id={`${prefixo}-dias`}
            data-testid={`${prefixo}-dias`}
            type="number"
            min={0}
            max={365}
            className="w-24"
            value={dias}
            onChange={(e) => {
              setDias(e.target.value);
              emitirDias(e.target.value, sentido);
            }}
          />
          <Seletor
            id={`${prefixo}-sentido`}
            valor={sentido}
            opcoes={[
              { valor: "antes", rotulo: t("antes da data") },
              { valor: "depois", rotulo: t("depois da data") },
            ]}
            onChange={(v) => {
              setSentido(v as "antes" | "depois");
              emitirDias(dias, v as "antes" | "depois");
            }}
          />
        </div>
      </Campo>
      <Campo
        id={`${prefixo}-horario`}
        rotulo={t("A partir de que horas")}
        ajuda={t("Começa na primeira rodada depois do horário, que acontece de hora em hora.")}
      >
        <Input
          id={`${prefixo}-horario`}
          data-testid={`${prefixo}-horario`}
          type="time"
          className="w-32"
          value={g.time}
          onChange={(e) => onChange({ ...g, time: e.target.value })}
        />
      </Campo>
      <Marcador
        id={`${prefixo}-so-abertos`}
        rotulo={t("Só negócios abertos")}
        marcado={g.only_open !== false}
        onChange={(m) => onChange({ ...g, only_open: m })}
      />
    </>
  );
}

function CamposDoSemResposta({
  prefixo,
  g,
  onChange,
}: {
  prefixo: string;
  g: Gatilho<"no_reply">;
  onChange: (g: AutomacaoTrigger) => void;
}) {
  const t = useT();
  return (
    <Campo
      id={`${prefixo}-tempo`}
      rotulo={t("Depois de quanto tempo sem resposta")}
      ajuda={t(
        "Conta a partir da última mensagem enviada ao contato que ficou sem resposta. Conversas encerradas, com atendente ou de campanha ficam de fora.",
      )}
    >
      <TempoComUnidade
        id={`${prefixo}-tempo`}
        ms={g.after_minutes * 60_000}
        unidades={["minutos", "horas", "dias"]}
        onChange={(ms) =>
          // `0` (número inválido) o schema recusa — o aviso diz o mínimo e o máximo.
          onChange({ ...g, after_minutes: ms === null ? 0 : Math.round(ms / 60_000) })
        }
      />
    </Campo>
  );
}

function CamposDoIniciador({
  prefixo,
  g,
  onChange,
  flowId,
}: {
  prefixo: string;
  g: Gatilho<"started_by_automation">;
  onChange: (g: AutomacaoTrigger) => void;
  flowId?: string;
}) {
  const t = useT();
  const automacoes = useAutomacoesDaOrganizacao();
  const escolhidas = g.from_pointer_ids ?? [];
  const [modo, setModo] = useState<"qualquer" | "lista">(
    escolhidas.length > 0 ? "lista" : "qualquer",
  );
  const lista = (automacoes.data ?? []).filter((a) => a.id !== flowId);
  const marcar = (id: string, m: boolean) => {
    const proximas = m ? [...escolhidas, id] : escolhidas.filter((x) => x !== id);
    onChange(
      proximas.length > 0
        ? { kind: "started_by_automation", from_pointer_ids: proximas }
        : { kind: "started_by_automation" },
    );
  };
  return (
    <>
      <Campo
        id={`${prefixo}-aceitar`}
        rotulo={t("Aceitar de")}
        ajuda={t(
          "A automação que iniciar esta pode passar dados; aqui eles se usam como {{param.chave}}.",
        )}
      >
        <Seletor
          id={`${prefixo}-aceitar`}
          valor={modo}
          opcoes={[
            { valor: "qualquer", rotulo: t("Qualquer automação") },
            { valor: "lista", rotulo: t("Só destas automações") },
          ]}
          onChange={(v) => {
            setModo(v as "qualquer" | "lista");
            if (v === "qualquer") onChange({ kind: "started_by_automation" });
          }}
        />
      </Campo>
      {modo === "lista" && (
        <fieldset className="space-y-1.5" data-testid={`${prefixo}-iniciadoras`}>
          <legend className="sr-only">{t("Só destas automações")}</legend>
          {lista.map((a) => (
            <Marcador
              key={a.id}
              id={`${prefixo}-iniciadora-${a.id}`}
              rotulo={a.name}
              marcado={escolhidas.includes(a.id)}
              onChange={(m) => marcar(a.id, m)}
            />
          ))}
          {!automacoes.isLoading && lista.length === 0 && (
            <p className="text-xs text-text-muted">{t("Nenhuma outra automação nesta conta.")}</p>
          )}
          {escolhidas.length === 0 && lista.length > 0 && (
            <p className="text-xs text-text-muted">
              {t("Sem nenhuma marcada, vale qualquer automação.")}
            </p>
          )}
        </fieldset>
      )}
    </>
  );
}
