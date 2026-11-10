"use client";

/**
 * Formulário do bloco "Requisição HTTP" (lote 4): chama outro sistema e guarda
 * o que a resposta devolve. A chave secreta NUNCA é digitada aqui: o cabeçalho
 * "Chave secreta" escolhe uma chave do cofre (Automações › Chaves secretas), e o
 * grafo guarda só o id dela.
 */
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSegredos } from "@/hooks/automacoes/useSegredos";
import { useT } from "@/hooks/i18n/useT";
import {
  cabecalhoProibido,
  CAMINHO_NO_JSON,
  corpoEhJsonValido,
  MASCARA,
  MAX_CABECALHOS,
  MAX_MAPEAMENTOS,
  metodoTemCorpo,
  METODOS_HTTP,
  NOME_DA_VARIAVEL_DE_SAIDA,
  problemaDaUrl,
  TEMPO_LIMITE_MAXIMO_MS,
  TEMPO_LIMITE_MINIMO_MS,
  type CabecalhoHttp,
  type HttpRequestConfig,
  type MapeamentoHttp,
  type MetodoHttp,
} from "@/lib/automacoes/http";
import { Trash } from "@/lib/ui/icons";

import { AjudaDeVariaveis, Campo, Seletor, SeletorDeCampo, type RespostaDisponivel } from "./comum";

const FRASE_DA_URL: Record<NonNullable<ReturnType<typeof problemaDaUrl>>, string> = {
  vazia: "Informe o endereço que a automação vai chamar.",
  segredo_na_url: "A chave secreta não pode ir no endereço. Use um cabeçalho com a chave.",
  invalida: "Escreva o endereço completo, como https://api.example.com/v1/recurso.",
  https_obrigatorio: "O endereço precisa começar com https://.",
  credencial_na_url: "O endereço não pode ter usuário e senha. Use um cabeçalho com a chave.",
};

export function HttpForm({
  config,
  onChange,
  respostas,
}: {
  config: HttpRequestConfig;
  onChange: (c: HttpRequestConfig) => void;
  respostas?: RespostaDisponivel[];
}) {
  const t = useT();
  const { data: segredos } = useSegredos();
  const problema = problemaDaUrl(config.url);
  const temCorpo = metodoTemCorpo(config.method);
  const corpoInvalido = temCorpo && config.body !== undefined && config.body.trim() !== "" && !corpoEhJsonValido(config.body);

  const cabecalhosNoLimite = config.headers.length >= MAX_CABECALHOS;
  const mapeamentosNoLimite = config.mappings.length >= MAX_MAPEAMENTOS;
  const mudar = (patch: Partial<HttpRequestConfig>) => onChange({ ...config, ...patch });
  const mudarCabecalho = (i: number, h: CabecalhoHttp) =>
    mudar({ headers: config.headers.map((x, j) => (j === i ? h : x)) });
  const mudarMapeamento = (i: number, m: MapeamentoHttp) =>
    mudar({ mappings: config.mappings.map((x, j) => (j === i ? m : x)) });

  return (
    <div className="space-y-4" data-testid="http-form">
      <Campo id="http-metodo" rotulo={t("Método")}>
        <Seletor
          id="http-metodo"
          valor={config.method}
          opcoes={METODOS_HTTP.map((m) => ({ valor: m, rotulo: m }))}
          onChange={(v) => {
            const method = v as MetodoHttp;
            // GET não leva corpo: some com ele ao trocar.
            const { body: _corpo, ...resto } = config;
            onChange(metodoTemCorpo(method) ? { ...config, method } : { ...resto, method });
          }}
        />
      </Campo>

      <Campo
        id="http-url"
        rotulo={t("Endereço (URL)")}
        ajuda={t("Aceita variáveis, como https://api.example.com/clientes/{{campo.codigo}}. Endereços internos do servidor são bloqueados.")}
      >
        <Input
          id="http-url"
          value={config.url}
          onChange={(e) => mudar({ url: e.target.value })}
          placeholder="https://api.example.com/v1/recurso"
          autoComplete="off"
        />
        {problema && problema !== "vazia" && (
          <p className="text-xs text-error-fg" role="alert">
            {t(FRASE_DA_URL[problema])}
          </p>
        )}
      </Campo>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("Cabeçalhos")}</p>
        {config.headers.map((h, i) => (
          <div key={i} className="space-y-2 rounded-md border border-border p-2" data-testid={`http-cabecalho-${i}`}>
            <div className="flex gap-2">
              <Input
                aria-label={t("Nome do cabeçalho")}
                value={h.name}
                onChange={(e) => mudarCabecalho(i, { ...h, name: e.target.value.trim() })}
                placeholder="Authorization"
              />
              <Seletor
                id={`http-cabecalho-${i}-tipo`}
                valor={h.kind}
                opcoes={[
                  { valor: "texto", rotulo: t("Texto") },
                  // Sem chave no cofre não há o que escolher (o id vazio não salva o rascunho).
                  { valor: "chave", rotulo: t("Chave secreta"), desabilitada: (segredos ?? []).length === 0 },
                ]}
                onChange={(v) =>
                  mudarCabecalho(
                    i,
                    v === "chave"
                      ? { kind: "chave", name: h.name, secret_id: segredos?.[0]?.id ?? "", prefix: "Bearer " }
                      : { kind: "texto", name: h.name, value: "" },
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("Remover cabeçalho")}
                onClick={() => mudar({ headers: config.headers.filter((_, j) => j !== i) })}
              >
                <Trash size={14} aria-hidden />
              </Button>
            </div>
            {h.kind === "texto" ? (
              <Input
                aria-label={t("Valor do cabeçalho")}
                value={h.value}
                onChange={(e) => mudarCabecalho(i, { ...h, value: e.target.value })}
              />
            ) : (
              <div className="flex gap-2">
                <Input
                  aria-label={t("Antes da chave")}
                  className="w-28"
                  value={h.prefix}
                  onChange={(e) => mudarCabecalho(i, { ...h, prefix: e.target.value })}
                  placeholder="Bearer "
                />
                <Seletor
                  id={`http-cabecalho-${i}-chave`}
                  valor={h.secret_id}
                  opcoes={(segredos ?? []).map((s) => ({ valor: s.id, rotulo: `${s.nome} (${MASCARA}${s.ultimos4})` }))}
                  onChange={(v) => mudarCabecalho(i, { ...h, secret_id: v })}
                />
              </div>
            )}
            {h.name && cabecalhoProibido(h.name) && (
              <p className="text-xs text-error-fg" role="alert">
                {t("Este cabeçalho não pode ser definido pela automação.")}
              </p>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={cabecalhosNoLimite}
            title={cabecalhosNoLimite ? t("Limite de 20 cabeçalhos") : undefined}
            onClick={() =>
              mudar({ headers: [...config.headers, { kind: "texto", name: "Accept", value: "application/json" }] })
            }
          >
            {t("+ Cabeçalho")}
          </Button>
          <Link href="/app/automacoes/chaves" className="text-xs underline" target="_blank">
            {t("Gerenciar chaves secretas")}
          </Link>
        </div>
      </div>

      {temCorpo && (
        <Campo
          id="http-corpo"
          rotulo={t("Corpo (JSON, opcional)")}
          ajuda={t('Coloque cada variável entre aspas, como {"nome": "{{contact.name}}"}.')}
        >
          <Textarea
            id="http-corpo"
            rows={5}
            className="font-mono text-xs"
            value={config.body ?? ""}
            onChange={(e) => {
              const { body: _b, ...resto } = config;
              onChange(e.target.value === "" ? resto : { ...config, body: e.target.value });
            }}
          />
          {corpoInvalido && (
            <p className="text-xs text-error-fg" role="alert">
              {t("O corpo não é um JSON válido.")}
            </p>
          )}
        </Campo>
      )}

      <AjudaDeVariaveis
        respostas={respostas ?? []}
        onInserir={(v) => mudar({ url: `${config.url}${v}` })}
        testId="http-variaveis"
      />

      <Campo id="http-tempo" rotulo={t("Tempo limite (segundos)")} ajuda={t("Entre 1 e 30 segundos. Passou disso, sai por Falhou.")}>
        <Input
          id="http-tempo"
          type="number"
          min={TEMPO_LIMITE_MINIMO_MS / 1000}
          max={TEMPO_LIMITE_MAXIMO_MS / 1000}
          value={Math.round(config.timeout_ms / 1000)}
          onChange={(e) => {
            const s = Math.min(TEMPO_LIMITE_MAXIMO_MS / 1000, Math.max(TEMPO_LIMITE_MINIMO_MS / 1000, Number(e.target.value) || 10));
            mudar({ timeout_ms: Math.round(s) * 1000 });
          }}
        />
      </Campo>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("Guardar da resposta")}</p>
        <p className="text-xs text-text-muted">
          {t("Cada valor guardado fica disponível nos blocos seguintes como {{saida.nome}} e, se quiser, também num campo.")}
        </p>
        {config.mappings.map((m, i) => (
          <div key={i} className="space-y-2 rounded-md border border-border p-2" data-testid={`http-mapeamento-${i}`}>
            <div className="flex gap-2">
              <Input
                aria-label={t("Caminho na resposta")}
                value={m.path}
                onChange={(e) => mudarMapeamento(i, { ...m, path: e.target.value.trim() })}
                placeholder="campaign.name"
              />
              <Input
                aria-label={t("Nome da variável")}
                value={m.var}
                onChange={(e) => mudarMapeamento(i, { ...m, var: e.target.value.trim().toLowerCase() })}
                placeholder="utm_campaign"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("Remover")}
                onClick={() => mudar({ mappings: config.mappings.filter((_, j) => j !== i) })}
              >
                <Trash size={14} aria-hidden />
              </Button>
            </div>
            <SeletorDeCampo
              id={`http-mapeamento-${i}-campo`}
              valor={m.to ?? null}
              paraEscrita
              vazio={t("Não gravar em campo")}
              onChange={(ref) => mudarMapeamento(i, { ...m, to: ref })}
              onLimpar={() => {
                const { to: _to, ...resto } = m;
                mudarMapeamento(i, resto);
              }}
            />
            {((m.path && !CAMINHO_NO_JSON.test(m.path)) || (m.var && !NOME_DA_VARIAVEL_DE_SAIDA.test(m.var))) && (
              <p className="text-xs text-error-fg" role="alert">
                {t("Use o caminho com pontos (campaign.name) e um nome com letras minúsculas, números e _.")}
              </p>
            )}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={mapeamentosNoLimite}
          title={mapeamentosNoLimite ? t("Limite de 20 campos guardados") : undefined}
          onClick={() => {
            // Nasce válido (o rascunho só salva grafo válido): a pessoa troca caminho e nome.
            let n = config.mappings.length + 1;
            while (config.mappings.some((m) => m.var === `campo_${n}`)) n += 1;
            mudar({ mappings: [...config.mappings, { path: "id", var: `campo_${n}` }] });
          }}
        >
          {t("+ Guardar campo da resposta")}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        {t("Saídas: Deu certo (resposta 2xx) e Falhou (erro, tempo esgotado, endereço recusado ou resposta fora de 2xx). Não há nova tentativa automática.")}
      </p>
    </div>
  );
}
