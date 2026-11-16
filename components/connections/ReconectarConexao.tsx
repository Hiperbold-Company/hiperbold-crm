"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { useT } from "@/hooks/i18n/useT";
import { CodigoNoCelular } from "./PareamentoQrClient";

/**
 * Reconectar, dentro do cartão, uma conexão que caiu (o aparelho saiu).
 *
 * O mesmo desenho do pareamento novo (QR, código no celular, "Gerar outro"), com
 * uma diferença que importa: aqui NADA é apagado. Fechar o painel ou deixar o QR
 * expirar só para de perguntar; a conexão, a instância e o histórico ficam.
 *
 * Polling de 3 s em `POST .../reconectar/verificar`. Nos primeiros 20 s depois
 * de pedir o QR o servidor ainda pode dizer "desconectado": a tela ignora o
 * "expirado" nessa carência. Passados 5 minutos sem leitura, para de perguntar.
 */

const INTERVALO_MS = 3_000;
const CARENCIA_MS = 20_000;
const LIMITE_SEM_LEITURA_MS = 5 * 60 * 1000;

interface Aguardando {
  id: string;
  estado: "aguardando" | "expirado";
  qr: string | null;
  codigo: string | null;
}

interface Conectou {
  id: string;
  estado: "conectado";
  conexao: { id: string; display_name: string; phone_number: string | null; status: string };
  webhook: { registrado: boolean; aviso: string | null };
  numero_mudou: boolean;
}

export function ReconectarConexao({
  conexaoId,
  abrirAoMontar = false,
  aoConectar,
  aoAbrirSozinho,
}: {
  conexaoId: string;
  /** Veio da faixa de conexão caída (`?reconectar=<id>`): já abre o QR. */
  abrirAoMontar?: boolean;
  /** Recarrega a lista e a faixa do topo. */
  aoConectar: () => void;
  /** Abriu sozinho pelo link da faixa: quem monta tira o `?reconectar=` da URL (reload não gera outro QR). */
  aoAbrirSozinho?: () => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [sessao, setSessao] = useState<Aguardando | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [parouDeAtualizar, setParouDeAtualizar] = useState(false);
  const [mostrarCodigo, setMostrarCodigo] = useState(false);
  const [telefone, setTelefone] = useState("");
  /** Erro que encerra a espera (409, 500, 4xx que não é 429): mostrado no painel, com "Tentar de novo". */
  const [erro, setErro] = useState<string | null>(null);
  const pedidoEm = useRef<number>(0);
  const abriuSozinho = useRef(false);
  // Em ref: o pai recria estas funções a cada render, e o intervalo do polling não pode reiniciar por isso.
  const aoConectarRef = useRef(aoConectar);
  const aoAbrirSozinhoRef = useRef(aoAbrirSozinho);
  useEffect(() => {
    aoConectarRef.current = aoConectar;
    aoAbrirSozinhoRef.current = aoAbrirSozinho;
  });

  const base = `/api/v1/channels/instancia/${encodeURIComponent(conexaoId)}/reconectar`;

  const concluir = useCallback(
    (r: Conectou) => {
      setAberto(false);
      setSessao(null);
      setTelefone("");
      setMostrarCodigo(false);
      setParouDeAtualizar(false);
      setErro(null);
      if (r.webhook.registrado) {
        toast.success(t("WhatsApp reconectado. As mensagens voltaram a entrar no CRM."));
      } else {
        // O cartão vira "Conectado" e este painel some: o aviso vai no próprio toast.
        toast.warning(t("Conectado, mas as mensagens ainda não entram."), {
          description: r.webhook.aviso ?? t("A volta das mensagens não foi ligada."),
        });
      }
      if (r.numero_mudou) {
        toast.warning(t("Conectou um número diferente do anterior. Confira se é o aparelho certo."));
      }
      aoConectarRef.current();
    },
    [t],
  );

  const pedir = useCallback(
    async (comTelefone: boolean) => {
      setOcupado(true);
      setErro(null);
      try {
        const r = await apiClient.post<{ data: Aguardando | Conectou }>(base, {
          telefone: comTelefone ? telefone : null,
        });
        if (r.data.estado === "conectado") {
          concluir(r.data);
          return;
        }
        pedidoEm.current = Date.now();
        setParouDeAtualizar(false);
        setSessao({ ...r.data, estado: "aguardando" });
        setAberto(true);
      } catch (e) {
        toast.error(e instanceof Error ? t(e.message) : t("Não foi possível gerar o QR Code."));
      } finally {
        setOcupado(false);
      }
    },
    [base, concluir, t, telefone],
  );

  // Veio da faixa do topo: abre o QR uma vez só.
  useEffect(() => {
    if (!abrirAoMontar || abriuSozinho.current) return;
    abriuSozinho.current = true;
    void pedir(false);
    aoAbrirSozinhoRef.current?.();
  }, [abrirAoMontar, pedir]);

  const esperando = aberto && sessao !== null && !parouDeAtualizar && erro === null;
  useEffect(() => {
    if (!esperando) return;
    let vivo = true;
    const tick = async () => {
      if (Date.now() - pedidoEm.current > LIMITE_SEM_LEITURA_MS) {
        if (vivo) setParouDeAtualizar(true);
        return;
      }
      try {
        const r = await apiClient.post<{ data: Aguardando | Conectou }>(`${base}/verificar`, {});
        if (!vivo) return;
        if (r.data.estado === "conectado") {
          concluir(r.data);
          return;
        }
        const novo = r.data;
        const naCarencia = Date.now() - pedidoEm.current < CARENCIA_MS;
        if (novo.estado === "expirado" && !naCarencia) {
          setParouDeAtualizar(true);
          return;
        }
        if (novo.estado === "aguardando") {
          // QR novo só substitui o atual quando o servidor mandou um.
          setSessao((atual) => ({
            id: novo.id,
            estado: "aguardando",
            qr: novo.qr ?? atual?.qr ?? null,
            codigo: novo.codigo ?? atual?.codigo ?? null,
          }));
        }
      } catch (e) {
        // A conexão sumiu (removida em outra aba): fecha o painel.
        if (!vivo || !(e instanceof ApiError)) return; // rede: a próxima rodada tenta de novo
        if (e.status === 404) {
          setAberto(false);
          setSessao(null);
          toast.error(t("Conexão não encontrada."));
          return;
        }
        // 409, 500 e qualquer 4xx que não seja 429: perguntar de novo não muda nada. Para e mostra.
        // 429 e 502 (servidor de WhatsApp fora) seguem silenciosos: a próxima rodada tenta.
        if (e.status === 409 || e.status === 500 || (e.status >= 400 && e.status < 500 && e.status !== 429)) {
          setErro(e.message ? t(e.message) : t("Não foi possível gerar o QR Code."));
        }
      }
    };
    const timer = setInterval(() => void tick(), INTERVALO_MS);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [esperando, base, concluir, t]);

  const fechar = () => {
    // Só para de perguntar: nada é apagado no servidor nem no CRM.
    setAberto(false);
    setSessao(null);
    setParouDeAtualizar(false);
    setMostrarCodigo(false);
    setErro(null);
  };

  const telefoneValido = /^\d{10,15}$/.test(telefone.replace(/\D/g, ""));

  return (
    <div className="flex flex-col gap-3" data-testid="reconectar-conexao">
      {!aberto && (
        <div>
          <Button size="sm" onClick={() => void pedir(false)} disabled={ocupado} data-testid="reconectar-botao">
            {ocupado ? t("Gerando o QR Code…") : t("Reconectar")}
          </Button>
        </div>
      )}

      {aberto && sessao && (
        <div className="flex flex-col gap-4 rounded-lg border p-3" data-testid="reconectar-painel">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>{t("Abra o WhatsApp no celular.")}</li>
            <li>{t("Vá em Dispositivos conectados.")}</li>
            <li>{t("Toque em Conectar dispositivo e aponte a câmera para o QR Code.")}</li>
          </ol>

          <div className="flex flex-col items-center gap-3">
            {erro ? (
              <p role="alert" className="text-center text-sm text-destructive" data-testid="reconectar-erro">
                {erro}
              </p>
            ) : sessao.codigo && !parouDeAtualizar ? (
              <div className="flex flex-col items-center gap-2" data-testid="reconectar-codigo">
                <p className="text-center text-xs text-muted-foreground">
                  {t(
                    "No WhatsApp, em Dispositivos conectados, escolha conectar com número de telefone e digite este código:",
                  )}
                </p>
                <code className="rounded-md border bg-muted px-4 py-2 text-2xl font-semibold tracking-widest">
                  {sessao.codigo}
                </code>
              </div>
            ) : sessao.qr && !parouDeAtualizar ? (
              // eslint-disable-next-line @next/next/no-img-element -- imagem base64 gerada na hora, não um asset otimizável pelo next/image
              <img
                src={sessao.qr}
                alt={t("QR Code para conectar o WhatsApp")}
                className="h-64 w-64 rounded-md border bg-white p-2"
                data-testid="reconectar-qr-imagem"
              />
            ) : parouDeAtualizar ? (
              <p className="text-sm text-muted-foreground" data-testid="reconectar-qr-expirado">
                {t("O QR Code expirou.")}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t("Gerando o QR Code…")}</p>
            )}
            {!parouDeAtualizar && !erro && (
              <p className="text-xs text-muted-foreground">{t("Aguardando a leitura…")}</p>
            )}
            <p className="text-center text-xs text-muted-foreground">
              {t("O QR Code vale por pouco tempo. Se expirar, gere outro: a conexão e as conversas não se perdem.")}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {erro ? (
              <Button onClick={() => void pedir(false)} disabled={ocupado}>
                {t("Tentar de novo")}
              </Button>
            ) : (
              parouDeAtualizar && (
                <Button onClick={() => void pedir(false)} disabled={ocupado}>
                  {t("Gerar outro")}
                </Button>
              )
            )}
            <Button variant="outline" onClick={fechar} disabled={ocupado}>
              {t("Fechar")}
            </Button>
          </div>

          <CodigoNoCelular
            aberto={mostrarCodigo}
            alternar={() => setMostrarCodigo((v) => !v)}
            telefone={telefone}
            setTelefone={setTelefone}
            valido={telefoneValido}
            ocupado={ocupado}
            acao={() => void pedir(true)}
          />
        </div>
      )}

    </div>
  );
}
