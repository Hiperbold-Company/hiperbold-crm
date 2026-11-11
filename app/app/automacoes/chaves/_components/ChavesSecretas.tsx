"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useApagarSegredo,
  useCriarSegredo,
  useSegredos,
  useTrocarSegredo,
} from "@/hooks/automacoes/useSegredos";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";
import {
  ampliaOsHosts,
  lerHost,
  MAX_HOSTS_POR_CHAVE,
  separarHosts,
  type ProblemaDoHost,
} from "@/lib/automacoes/hosts-permitidos";
import { MASCARA } from "@/lib/automacoes/http";
import { NOME_DO_SEGREDO } from "@/lib/automacoes/segredos-nome";
import { Key } from "@/lib/ui/icons";

function mensagemDoErro(err: unknown, padrao: string): string {
  return err instanceof ApiError && err.message && err.message !== err.code ? err.message : padrao;
}

const FRASE_DO_HOST: Record<ProblemaDoHost, string> = {
  vazio: "Informe o endereço do serviço.",
  com_esquema: "Escreva só o nome do servidor, sem https://.",
  com_caminho: "Escreva só o nome do servidor, sem nada depois da /.",
  com_porta: "Escreva o endereço sem a porta (sem :443).",
  com_usuario: "O endereço não pode ter usuário (@).",
  curinga: "Curinga (*) não é aceito: escreva cada endereço inteiro.",
  invalido: "Endereço inválido. Use o nome do servidor, como api.exemplo.com.br.",
};

/** O texto digitado virou lista válida? Devolve os hosts normalizados, ou o primeiro problema. */
function lerListaDeHosts(
  texto: string,
): { hosts: string[] } | { item: string | null; frase: string } {
  const itens = separarHosts(texto);
  if (itens.length === 0) return { item: null, frase: FRASE_DO_HOST.vazio };
  if (itens.length > MAX_HOSTS_POR_CHAVE)
    return { item: null, frase: "Até 10 endereços por chave." };
  const hosts: string[] = [];
  for (const item of itens) {
    const r = lerHost(item);
    if ("problema" in r) return { item, frase: FRASE_DO_HOST[r.problema] };
    if (!hosts.includes(r.host)) hosts.push(r.host);
  }
  return { hosts };
}

/** O campo "Endereços permitidos", com a ajuda e o problema do que foi digitado. */
function CampoDeHosts({
  id,
  valor,
  onChange,
  mostrarVazio,
}: {
  id: string;
  valor: string;
  onChange: (v: string) => void;
  mostrarVazio: boolean;
}) {
  const t = useT();
  const lida = lerListaDeHosts(valor);
  const problema = "frase" in lida && (mostrarVazio || valor.trim() !== "") ? lida : null;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t("Endereços permitidos")}</Label>
      <Input
        id={id}
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder="api.example.com"
        autoComplete="off"
      />
      <p className="text-xs text-text-muted">
        {t(
          "Só o nome do servidor que vai receber a chave, como api.example.com. Mais de um: separe com vírgula. A automação não envia a chave para nenhum outro endereço.",
        )}
      </p>
      {problema && (
        <p className="text-xs text-error-fg" role="alert" data-testid={`${id}-problema`}>
          {problema.item ? `${problema.item}: ` : ""}
          {t(problema.frase)}
        </p>
      )}
    </div>
  );
}

export function ChavesSecretas() {
  const t = useT();
  const { data, isLoading } = useSegredos();
  const criar = useCriarSegredo();
  const trocar = useTrocarSegredo();
  const apagar = useApagarSegredo();
  const [nome, setNome] = useState("");
  const [valor, setValor] = useState("");
  const [hosts, setHosts] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [trocando, setTrocando] = useState<string | null>(null);
  const [novoValor, setNovoValor] = useState("");
  const [editandoHosts, setEditandoHosts] = useState<string | null>(null);
  const [hostsDaLinha, setHostsDaLinha] = useState("");
  const [valorDaLinha, setValorDaLinha] = useState("");
  const [erroDaLinha, setErroDaLinha] = useState<{ id: string; texto: string } | null>(null);
  const lista = data ?? [];
  const nomeValido = NOME_DO_SEGREDO.test(nome.trim());
  const hostsDaNova = lerListaDeHosts(hosts);

  async function salvar() {
    setErro(null);
    if (!("hosts" in hostsDaNova)) return;
    try {
      await criar.mutateAsync({ nome: nome.trim(), valor, hosts_permitidos: hostsDaNova.hosts });
      setNome("");
      setValor("");
      setHosts("");
    } catch (err) {
      setErro(mensagemDoErro(err, t("Não consegui gravar a chave.")));
    }
  }

  async function salvarTroca(id: string) {
    setErroDaLinha(null);
    try {
      await trocar.mutateAsync({ id, valor: novoValor });
      setTrocando(null);
      setNovoValor("");
    } catch (err) {
      setErroDaLinha({ id, texto: mensagemDoErro(err, t("Não consegui gravar a chave.")) });
    }
  }

  function abrirHosts(id: string, atuais: string[] | null) {
    setTrocando(null);
    setErroDaLinha(null);
    setEditandoHosts(editandoHosts === id ? null : id);
    setHostsDaLinha((atuais ?? []).join(", "));
    setValorDaLinha("");
  }

  async function salvarHosts(id: string, lista: string[]) {
    setErroDaLinha(null);
    try {
      await trocar.mutateAsync({
        id,
        hosts_permitidos: lista,
        ...(valorDaLinha ? { valor: valorDaLinha } : {}),
      });
      setEditandoHosts(null);
      setHostsDaLinha("");
      setValorDaLinha("");
    } catch (err) {
      setErroDaLinha({ id, texto: mensagemDoErro(err, t("Não consegui gravar a chave.")) });
    }
  }

  async function remover(id: string) {
    setErroDaLinha(null);
    try {
      await apagar.mutateAsync(id);
    } catch (err) {
      setErroDaLinha({ id, texto: mensagemDoErro(err, t("Não consegui apagar a chave.")) });
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Card className="flex flex-col gap-4 p-5" data-testid="nova-chave">
        <h2 className="font-medium">{t("Nova chave")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="chave-nome">{t("Nome da chave")}</Label>
            <Input
              id="chave-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value.toLowerCase())}
              placeholder="token_meta"
              autoComplete="off"
            />
            <p className="text-xs text-text-muted">
              {t("Letras minúsculas, números e _ (ex.: token_meta).")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="chave-valor">{t("Chave (token)")}</Label>
            <Input
              id="chave-valor"
              type="password"
              value={valor}
              onChange={(e) => setValor(e.target.value.trim())}
              autoComplete="new-password"
            />
            <p className="text-xs text-text-muted">
              {t("Cole a chave inteira. Depois de salva, ela não aparece mais.")}
            </p>
          </div>
        </div>
        <CampoDeHosts id="chave-hosts" valor={hosts} onChange={setHosts} mostrarVazio={false} />
        {erro && (
          <p className="text-sm text-error-fg" role="alert">
            {erro}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            onClick={salvar}
            disabled={!nomeValido || valor.length < 8 || !("hosts" in hostsDaNova) || criar.isPending}
          >
            {t("Salvar chave")}
          </Button>
        </div>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">{t("Chaves salvas")}</h2>
        {isLoading ? (
          <p className="text-sm text-text-muted">{t("Carregando…")}</p>
        ) : lista.length === 0 ? (
          <Card className="flex flex-col items-center gap-2 p-8 text-center">
            <Key size={28} aria-hidden className="text-text-muted" />
            <p className="text-sm text-text-muted">{t("Nenhuma chave salva ainda.")}</p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="lista-de-chaves">
            {lista.map((s) => (
              <li key={s.id}>
                <Card className="flex flex-col gap-3 p-4" data-testid={`chave-${s.nome}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col">
                      <span className="font-mono text-sm">{s.nome}</span>
                      <span
                        className="font-mono text-xs text-text-muted"
                        data-testid={`chave-${s.nome}-final`}
                      >
                        {MASCARA}
                        {s.ultimos4}
                      </span>
                      {s.hosts_permitidos && s.hosts_permitidos.length > 0 && (
                        <span
                          className="text-xs text-text-muted"
                          data-testid={`chave-${s.nome}-hosts`}
                        >
                          {t("Só vai para:")} {s.hosts_permitidos.join(", ")}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => abrirHosts(s.id, s.hosts_permitidos)}
                      >
                        {t("Endereços")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditandoHosts(null);
                          setTrocando(trocando === s.id ? null : s.id);
                          setNovoValor("");
                        }}
                      >
                        {t("Trocar valor")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => remover(s.id)}
                        disabled={apagar.isPending}
                      >
                        {t("Apagar")}
                      </Button>
                    </div>
                  </div>
                  {s.hosts_permitidos === null && (
                    <p
                      className="rounded-md border border-warning/40 bg-warning-bg p-2 text-sm text-warning-fg"
                      role="status"
                      data-testid={`chave-${s.nome}-aviso-hosts`}
                    >
                      {t(
                        "Esta chave pode ser enviada para qualquer endereço. Informe o endereço do serviço.",
                      )}
                    </p>
                  )}
                  {editandoHosts === s.id &&
                    (() => {
                      const lida = lerListaDeHosts(hostsDaLinha);
                      const amplia = "hosts" in lida && ampliaOsHosts(s.hosts_permitidos, lida.hosts);
                      return (
                        <div
                          className="flex flex-col gap-2"
                          data-testid={`chave-${s.nome}-editar-hosts`}
                        >
                          <CampoDeHosts
                            id={`hosts-${s.id}`}
                            valor={hostsDaLinha}
                            onChange={setHostsDaLinha}
                            mostrarVazio
                          />
                          {amplia && (
                            <div className="space-y-1.5">
                              <Label htmlFor={`hosts-valor-${s.id}`}>
                                {t("Cole a chave de novo para incluir um endereço novo")}
                              </Label>
                              <Input
                                id={`hosts-valor-${s.id}`}
                                type="password"
                                value={valorDaLinha}
                                onChange={(e) => setValorDaLinha(e.target.value.trim())}
                                autoComplete="new-password"
                              />
                              <p className="text-xs text-text-muted">
                                {t(
                                  "Assim ninguém manda a chave para outro servidor sem conhecê-la.",
                                )}
                              </p>
                            </div>
                          )}
                          <div className="flex justify-end">
                            <Button
                              onClick={() => "hosts" in lida && salvarHosts(s.id, lida.hosts)}
                              disabled={
                                !("hosts" in lida) ||
                                (amplia && valorDaLinha.length < 8) ||
                                trocar.isPending
                              }
                            >
                              {t("Salvar endereços")}
                            </Button>
                          </div>
                        </div>
                      );
                    })()}
                  {trocando === s.id && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="flex-1 space-y-1.5">
                        <Label htmlFor={`trocar-${s.id}`}>{t("Novo valor da chave")}</Label>
                        <Input
                          id={`trocar-${s.id}`}
                          type="password"
                          value={novoValor}
                          onChange={(e) => setNovoValor(e.target.value.trim())}
                          autoComplete="new-password"
                        />
                      </div>
                      <Button
                        onClick={() => salvarTroca(s.id)}
                        disabled={novoValor.length < 8 || trocar.isPending}
                      >
                        {t("Salvar novo valor")}
                      </Button>
                    </div>
                  )}
                  {erroDaLinha?.id === s.id && (
                    <p className="text-sm text-error-fg" role="alert">
                      {erroDaLinha.texto}
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-sm text-text-muted">
        <Link href="/app/automacoes" className="underline">
          {t("Voltar para Automações")}
        </Link>
      </p>
    </div>
  );
}
