import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/tests/helpers/render-com-confirmacao";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelRoutingForm } from "./_channels-form";
vi.mock("next/navigation",()=>({useRouter:()=>({push:vi.fn(),refresh:vi.fn()})}));
vi.mock("@/hooks/i18n/useT",()=>({useT:()=>(s:string)=>s}));
const fetcher=vi.fn();
beforeEach(()=>{vi.stubGlobal("fetch",fetcher);fetcher.mockReset();fetcher.mockResolvedValue({ok:true,json:async()=>({data:{mode:"restricted_empty",user_ids:[]}})});});
const initial={
 channels:[
  {id:"a",display_name:"Número A",phone_number:null,user_ids:["ana"],mode:"restricted" as const,distribution_mode:"round_robin" as const,default_assignee_user_id:"ana"},
  {id:"b",display_name:"Número B",phone_number:null,user_ids:[],mode:"legacy_unconfigured" as const,distribution_mode:null,default_assignee_user_id:null},
 ],
 members:[{id:"ana",name:"Ana"},{id:"bruno",name:"Bruno"}]};
const corpo=()=>JSON.parse(fetcher.mock.calls[0]![1].body);
// O Salvar por número saiu: a barra de salvar da tela grava cada número que mudou.
const salvarNaBarra=()=>fireEvent.click(within(screen.getByRole("region",{name:"Alterações não salvas"})).getByRole("button",{name:"Salvar"}));
describe("responsáveis por número na tela",()=>{
 it("salvar lista vazia é explícito e não altera o número vizinho",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  const a=within(screen.getByRole("group",{name:"Número A"}));
  fireEvent.click(a.getByRole("checkbox",{name:"Ana"}));salvarNaBarra();
  await waitFor(()=>expect(a.getByText("Ninguém configurado — as conversas ficarão na fila.")).toBeVisible());
  expect(corpo()).toEqual({channel_session_id:"a",user_ids:[],reset:false,distribution_mode:"round_robin",default_assignee_user_id:"ana"});
  expect(within(screen.getByRole("group",{name:"Número B"})).getByText("Usa todos os atendentes elegíveis da organização.")).toBeVisible();
 });
 it("voltar ao padrão envia reset; erro não anuncia salvo",async()=>{
  fetcher.mockResolvedValue({ok:false,json:async()=>({error:{message:"A equipe mudou."}})});
  render(<ChannelRoutingForm initial={initial}/>);
  fireEvent.click(within(screen.getByRole("group",{name:"Número A"})).getByRole("button",{name:"Voltar ao padrão da organização"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("A equipe mudou."));
  expect(corpo().reset).toBe(true);
  expect(screen.queryByText("Responsáveis salvos.")).not.toBeInTheDocument();
 });
 // ─── Issue #2331: modo e destino padrão POR NÚMERO ───
 it("número legado: marcar e desmarcar grava a lista vazia explícita, sem regra própria (herda a organização)",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  const b=within(screen.getByRole("group",{name:"Número B"}));
  expect(b.getByTestId("modo-do-numero-b")).toHaveValue("");
  // B "usa todos os atendentes" (legado). Marcar e desmarcar troca o "todos"
  // salvo por uma lista explícita VAZIA: a barra aparece e Salvar grava a lista
  // vazia — é o único caminho na tela para "ninguém, fica na fila".
  fireEvent.click(b.getByRole("checkbox",{name:"Bruno"}));
  fireEvent.click(b.getByRole("checkbox",{name:"Bruno"}));
  expect(b.getByRole("checkbox",{name:"Bruno"})).not.toBeChecked();
  salvarNaBarra();
  await waitFor(()=>expect(b.getByText("Ninguém configurado — as conversas ficarão na fila.")).toBeVisible());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(corpo()).toEqual({channel_session_id:"b",user_ids:[],reset:false,distribution_mode:null,default_assignee_user_id:null});
  expect(screen.queryByRole("region",{name:"Alterações não salvas"})).toBeNull();
 });
 it("responsáveis contam como conjunto: desmarcar e remarcar quem já estava não acende a barra",async()=>{
  const comDois={...initial,channels:[{...initial.channels[0]!,user_ids:["ana","bruno"]},initial.channels[1]!]};
  render(<ChannelRoutingForm initial={comDois}/>);
  const a=within(screen.getByRole("group",{name:"Número A"}));
  fireEvent.click(a.getByRole("checkbox",{name:"Ana"}));
  expect(screen.getByRole("region",{name:"Alterações não salvas"})).toBeInTheDocument();
  // De volta: a lista vira [bruno, ana], o mesmo conjunto do salvo.
  fireEvent.click(a.getByRole("checkbox",{name:"Ana"}));
  expect(screen.queryByRole("region",{name:"Alterações não salvas"})).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
 });
 it("voltar ao padrão depois de mexer num número legado não deixa a barra acesa",async()=>{
  fetcher.mockResolvedValue({ok:true,json:async()=>({data:{mode:"legacy_unconfigured",user_ids:[],distribution_mode:null,default_assignee_user_id:null}})});
  render(<ChannelRoutingForm initial={initial}/>);
  const b=within(screen.getByRole("group",{name:"Número B"}));
  fireEvent.click(b.getByRole("checkbox",{name:"Bruno"}));
  fireEvent.click(b.getByRole("checkbox",{name:"Bruno"}));
  expect(screen.getByRole("region",{name:"Alterações não salvas"})).toBeInTheDocument();
  fireEvent.click(b.getByRole("button",{name:"Voltar ao padrão da organização"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("Responsáveis salvos."));
  expect(corpo().reset).toBe(true);
  expect(screen.queryByRole("region",{name:"Alterações não salvas"})).toBeNull();
 });
 it("escolher modo e destino de UM número não encosta no outro",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  const b=within(screen.getByRole("group",{name:"Número B"}));
  // O destino só destrava depois de o número ter modo próprio: sem modo não há
  // distribuição de que o destino seja exceção.
  expect(b.getByTestId("destino-do-numero-b")).toBeDisabled();
  fireEvent.change(b.getByTestId("modo-do-numero-b"),{target:{value:"manual"}});
  expect(b.getByTestId("destino-do-numero-b")).not.toBeDisabled();
  fireEvent.change(b.getByTestId("destino-do-numero-b"),{target:{value:"bruno"}});
  salvarNaBarra();
  await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
  expect(corpo()).toEqual({channel_session_id:"b",user_ids:[],reset:false,distribution_mode:"manual",default_assignee_user_id:"bruno"});
  // O número A continua com a regra dele no estado do formulário.
  const a=within(screen.getByRole("group",{name:"Número A"}));
  expect(a.getByTestId("modo-do-numero-a")).toHaveValue("round_robin");
  expect(a.getByTestId("destino-do-numero-a")).toHaveValue("ana");
 });
 it("voltar o modo para o padrão da organização limpa o destino padrão junto",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  const a=within(screen.getByRole("group",{name:"Número A"}));
  fireEvent.change(a.getByTestId("modo-do-numero-a"),{target:{value:""}});
  expect(a.getByTestId("destino-do-numero-a")).toBeDisabled();
  salvarNaBarra();
  await waitFor(()=>expect(fetcher).toHaveBeenCalled());
  expect(corpo()).toEqual({channel_session_id:"a",user_ids:["ana"],reset:false,distribution_mode:null,default_assignee_user_id:null});
 });
 it("sem mudança não há barra; Descartar volta o número ao último salvo",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  expect(screen.queryByRole("region",{name:"Alterações não salvas"})).toBeNull();
  const a=within(screen.getByRole("group",{name:"Número A"}));
  fireEvent.click(a.getByRole("checkbox",{name:"Bruno"}));
  fireEvent.click(within(screen.getByRole("region",{name:"Alterações não salvas"})).getByRole("button",{name:"Descartar"}));
  expect(a.getByRole("checkbox",{name:"Bruno"})).not.toBeChecked();
  expect(screen.queryByRole("region",{name:"Alterações não salvas"})).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
 });
 it("depois de salvar, a barra some",async()=>{
  fetcher.mockResolvedValue({ok:true,json:async()=>({data:{mode:"restricted",user_ids:["ana","bruno"],distribution_mode:"round_robin",default_assignee_user_id:"ana"}})});
  render(<ChannelRoutingForm initial={initial}/>);
  fireEvent.click(within(screen.getByRole("group",{name:"Número A"})).getByRole("checkbox",{name:"Bruno"}));
  salvarNaBarra();
  await waitFor(()=>expect(screen.queryByRole("region",{name:"Alterações não salvas"})).toBeNull());
  expect(screen.getByRole("status")).toHaveTextContent("Responsáveis salvos.");
 });
});
