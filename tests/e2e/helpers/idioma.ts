import { expect, type Page } from "@playwright/test";

/**
 * Troca o idioma da pessoa logada pelo seletor do topo, como ela faria.
 *
 * Por que pela tela, e não `auth.admin.updateUserById` no banco: o `getUser`
 * mora no cache curto da autorização (#3696). Quem troca pelo produto passa por
 * `trocarIdioma`, que invalida o cache na hora; quem grava direto no banco com a
 * sessão aberta espera até 30 s, e a recarga seguinte ainda vinha no idioma velho.
 *
 * O seletor pinta o idioma novo antes do servidor responder e depois recarrega a
 * página inteira. Esperar o texto do botão mudar é esperar a pintura otimista;
 * o carimbo no `window` some só com a recarga — é ela que se espera aqui.
 */
export async function trocarIdiomaPelaTela(page: Page, codigo: "pt-BR" | "es"): Promise<void> {
  const curto = codigo === "es" ? "ES" : "PT";
  // Moldura do redesign (`REDESIGN_HIPERBOLD`): o seletor não está no topo. O
  // `<html data-redesign>` vem do servidor, então a detecção não corre contra a
  // hidratação. Desligada, o caminho abaixo é o de sempre.
  if ((await page.locator("html").getAttribute("data-redesign")) === "ligado") {
    await trocarIdiomaNaMolduraNova(page, codigo, curto);
    return;
  }
  const botao = page.getByTestId("seletor-de-idioma");
  if ((await botao.innerText()).trim() === curto) return;
  await page.evaluate(() => {
    (window as unknown as { __antesDaTroca?: boolean }).__antesDaTroca = true;
  });
  await botao.click();
  await page.getByTestId(`idioma-${codigo}`).click();
  await page.waitForFunction(
    () => !(window as unknown as { __antesDaTroca?: boolean }).__antesDaTroca,
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForLoadState("networkidle", { timeout: 60_000 });
  await expect(botao).toHaveText(curto);
}

/**
 * A mesma troca na moldura do redesign. No computador o idioma mora no menu do
 * usuário (`menu-do-usuario` → submenu `seletor-de-idioma` → `idioma-<codigo>`);
 * no celular, no painel "Mais" da barra de baixo, onde as opções `idioma-<codigo>`
 * já ficam à vista. O idioma em vigor se lê no `aria-label` do submenu
 * ("Idioma: PT — Português") ou no `aria-current` da opção do "Mais".
 */
async function trocarIdiomaNaMolduraNova(
  page: Page,
  codigo: "pt-BR" | "es",
  curto: string,
): Promise<void> {
  const menuDoUsuario = page.getByTestId("menu-do-usuario");
  const noComputador = await menuDoUsuario.isVisible();
  const abrirMais = page.locator(
    'nav[data-barra-inferior][data-moldura="redesign"] li button[aria-haspopup="dialog"]',
  );
  const opcao = page.getByTestId(`idioma-${codigo}`);
  const emVigor = async (): Promise<boolean> => {
    if (noComputador) {
      await menuDoUsuario.click();
      const rotulo = (await page.getByTestId("seletor-de-idioma").getAttribute("aria-label")) ?? "";
      return rotulo.includes(`: ${curto} `);
    }
    await abrirMais.click();
    return (await opcao.getAttribute("aria-current")) === "true";
  };

  if (await emVigor()) {
    await page.keyboard.press("Escape");
    return;
  }
  await page.evaluate(() => {
    (window as unknown as { __antesDaTroca?: boolean }).__antesDaTroca = true;
  });
  if (noComputador) await page.getByTestId("seletor-de-idioma").click();
  await opcao.click();
  await page.waitForFunction(
    () => !(window as unknown as { __antesDaTroca?: boolean }).__antesDaTroca,
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForLoadState("networkidle", { timeout: 60_000 });
  expect(await emVigor()).toBe(true);
  await page.keyboard.press("Escape");
}
