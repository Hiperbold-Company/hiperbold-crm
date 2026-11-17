"use client";

/**
 * Liga um formulário à barra de salvar — a dele, ou a da tela inteira.
 *
 *   const { barra, enviar, salvando, refDoFormulario } = useBarraDeSalvar({ sujo, salvar, descartar });
 *   return <form ref={refDoFormulario} onSubmit={enviar}>… {barra}</form>;
 *
 * `salvar` devolve o desfecho:
 * - `"salvo"`: gravou. O formulário já atualizou o próprio "último salvo", então
 *   `sujo` vira `false` e a barra some.
 * - `"falhou"`: a gravação não aconteceu. A barra entra em erro ("Não consegui
 *   salvar… Tentar de novo") e as mudanças ficam na tela.
 * - `"invalido"`: o formulário recusou antes de gravar e já disse por quê (o
 *   toast de validação). A barra continua no estado normal — não houve falha
 *   de gravação a anunciar.
 *
 * ── A tela com mais de um formulário ────────────────────────────────────────
 * Distribuição de atendimento tem três formulários, cada um com o seu
 * endpoint. Três barras empilhadas no rodapé seriam três perguntas para uma
 * decisão só. Dentro de um `<GrupoDeSalvar>`, cada formulário se registra e o
 * grupo desenha UMA barra: Salvar grava, em sequência, cada parte que mudou;
 * Descartar volta todas ao último salvo. Se uma parte falha, a barra fica em
 * erro e só ela continua suja — o que gravou não volta atrás. Fora de um grupo,
 * o formulário desenha a própria barra.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { BarraDeSalvar } from "./barra-de-salvar";
import { useAvisoDeSaidaSemSalvar } from "./use-aviso-de-saida-sem-salvar";

export type DesfechoDoSalvar = "salvo" | "falhou" | "invalido";

interface EstadoDaParte {
  sujo: boolean;
  salvando: boolean;
  erro: boolean;
  podeSalvar: boolean;
  aviso: string | null;
}

interface AcoesDaParte {
  executar: () => Promise<DesfechoDoSalvar>;
  descartar: () => void;
}

interface ApiDoGrupo {
  definir: (id: string, estado: EstadoDaParte, acoes: { current: AcoesDaParte }) => void;
  remover: (id: string) => void;
}

const ContextoDoGrupo = createContext<ApiDoGrupo | null>(null);

export function GrupoDeSalvar({ children }: { children: ReactNode }) {
  const [estados, setEstados] = useState<Record<string, EstadoDaParte>>({});
  const acoes = useRef(new Map<string, { current: AcoesDaParte }>());

  const api = useMemo<ApiDoGrupo>(
    () => ({
      definir: (id, estado, ref) => {
        acoes.current.set(id, ref);
        setEstados((atual) => ({ ...atual, [id]: estado }));
      },
      remover: (id) => {
        acoes.current.delete(id);
        setEstados((atual) => {
          const { [id]: _removido, ...resto } = atual;
          return resto;
        });
      },
    }),
    [],
  );

  const partes = Object.entries(estados);
  const pendentes = partes.filter(([, e]) => e.sujo || e.erro);
  const sujo = pendentes.length > 0;
  const salvando = partes.some(([, e]) => e.salvando);
  const erro = partes.some(([, e]) => e.erro);
  const barrada = pendentes.find(([, e]) => !e.podeSalvar);

  useAvisoDeSaidaSemSalvar(sujo);

  async function salvarTudo() {
    // Em sequência, na ordem da tela: o que falhar não impede o resto, e cada
    // parte cuida do próprio "salvando" e do próprio erro.
    for (const [id] of pendentes) {
      await acoes.current.get(id)?.current.executar();
    }
  }

  function descartarTudo() {
    for (const [id] of pendentes) acoes.current.get(id)?.current.descartar();
  }

  return (
    <ContextoDoGrupo.Provider value={api}>
      <div className="flex flex-col gap-6">
        {children}
        <BarraDeSalvar
          sujo={sujo}
          salvando={salvando}
          erro={erro}
          podeSalvar={!barrada}
          aviso={barrada?.[1].aviso ?? null}
          onSalvar={() => void salvarTudo()}
          onDescartar={descartarTudo}
        />
      </div>
    </ContextoDoGrupo.Provider>
  );
}

interface OpcoesDaBarra {
  sujo: boolean;
  salvar: () => Promise<DesfechoDoSalvar>;
  /** Volta os campos ao último salvo. */
  descartar: () => void;
  podeSalvar?: boolean;
  aviso?: string | null;
  /** `id` do `<form>`, quando a barra precisa ficar fora dele. */
  formulario?: string;
}

export function useBarraDeSalvar({
  sujo,
  salvar,
  descartar,
  podeSalvar = true,
  aviso = null,
  formulario,
}: OpcoesDaBarra) {
  const grupo = useContext(ContextoDoGrupo);
  const id = useId();
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(false);
  const emVoo = useRef(false);
  // O `<form>` da parte, quando ela o liga: o Salvar da barra do GRUPO não é
  // submit de formulário nenhum, então a validação nativa (`required`, `min`,
  // `max`, `type="email"`) é pedida aqui, antes de gravar.
  const refDoFormulario = useRef<HTMLFormElement>(null);

  // As funções mudam a cada render (leem o estado do formulário); a barra e o
  // grupo chamam sempre a versão mais nova por esta referência.
  const funcoes = useRef({ salvar, descartar });
  useEffect(() => {
    funcoes.current = { salvar, descartar };
  });

  const executar = useCallback(async (): Promise<DesfechoDoSalvar> => {
    if (emVoo.current) return "invalido";
    if (refDoFormulario.current && !refDoFormulario.current.reportValidity()) return "invalido";
    emVoo.current = true;
    setSalvando(true);
    setErro(false);
    let desfecho: DesfechoDoSalvar = "falhou";
    try {
      desfecho = await funcoes.current.salvar();
    } catch {
      desfecho = "falhou";
    } finally {
      emVoo.current = false;
      setSalvando(false);
    }
    setErro(desfecho === "falhou");
    return desfecho;
  }, []);

  const descartarTudo = useCallback(() => {
    setErro(false);
    funcoes.current.descartar();
  }, []);

  const acoes = useRef<AcoesDaParte>({ executar, descartar: descartarTudo });

  useEffect(() => {
    if (!grupo) return;
    grupo.definir(id, { sujo, salvando, erro, podeSalvar, aviso }, acoes);
  }, [grupo, id, sujo, salvando, erro, podeSalvar, aviso]);

  useEffect(() => {
    if (!grupo) return;
    return () => grupo.remover(id);
  }, [grupo, id]);

  const { liberarSaida } = useAvisoDeSaidaSemSalvar(!grupo && (sujo || erro));

  const enviar = useCallback(
    (evento?: FormEvent) => {
      evento?.preventDefault();
      void executar();
    },
    [executar],
  );

  const barra = grupo ? null : (
    <BarraDeSalvar
      sujo={sujo}
      salvando={salvando}
      erro={erro}
      podeSalvar={podeSalvar}
      aviso={aviso}
      formulario={formulario}
      onDescartar={descartarTudo}
    />
  );

  return { barra, enviar, salvando, erro, liberarSaida, refDoFormulario };
}
