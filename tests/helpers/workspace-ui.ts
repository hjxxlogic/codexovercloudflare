import { expect, type Page } from '@playwright/test';
export async function openNavigation(page: Page) {
  const mobile = await page.evaluate(
    () => matchMedia('(max-width: 900px)').matches,
  );
  if (mobile) {
    const drawer = page.getByRole('dialog', { name: '会话导航', exact: true });
    await page
      .locator('dialog.unified-navigation')
      .waitFor({ state: 'attached' });
    if (!(await drawer.isVisible()))
      await page
        .getByRole('button', { name: '打开会话导航', exact: true })
        .click();
    await expect(drawer).toBeVisible();
  } else {
    const navigation = page.locator('aside.unified-navigation');
    if (!(await navigation.isVisible()))
      await page
        .getByRole('button', { name: '打开会话导航', exact: true })
        .click();
    await expect(navigation).toBeVisible();
  }
}
export async function openSettings(page: Page) {
  await openNavigation(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '设置', exact: true }),
  ).toBeVisible();
}
export async function selectHost(page: Page, name: string | RegExp) {
  await openNavigation(page);
  const heading = page.getByRole('button', { name: '选择主机', exact: true });
  if ((await heading.getAttribute('aria-expanded')) !== 'true')
    await heading.click();
  await page
    .getByLabel('主机列表', { exact: true })
    .getByRole('button', { name })
    .click();
}

export async function selectHostId(page: Page, id: string) {
  await openNavigation(page);
  const heading = page.getByRole('button', { name: '选择主机', exact: true });
  if ((await heading.getAttribute('aria-expanded')) !== 'true')
    await heading.click();
  const selected = page.locator(`[data-host-id="${id}"]`);
  if ((await selected.getAttribute('aria-pressed')) !== 'true')
    await selected.click();
}
export async function selectProjectId(page: Page, id: string) {
  await openNavigation(page);
  const heading = page.getByRole('button', { name: '选择项目', exact: true });
  if ((await heading.getAttribute('aria-expanded')) !== 'true')
    await heading.click();
  await page.locator(`[data-project-id="${id}"]`).click();
}
