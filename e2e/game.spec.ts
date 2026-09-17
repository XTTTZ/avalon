import { test, expect, devices, type APIRequestContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { standardConfig } from '../shared/rules';
import type { ApiRequest, GameCommand, RoomView, Session } from '../shared/types';
const id = () => randomBytes(24).toString('hex');
async function call<T>(
  request: APIRequestContext,
  payload: ApiRequest,
  session?: Session,
): Promise<T> {
  const response = await request.post('/api', {
    data: payload,
    headers: session ? { Authorization: `Bearer ${session.token}` } : {},
  });
  const body = await response.json();
  if (!body.ok) throw new Error(JSON.stringify(body.error));
  return body.data as T;
}
async function prepare(request: APIRequestContext, count = 5) {
  const sessions: Session[] = [];
  for (let i = 0; i < count; i++)
    sessions.push(await call(request, { action: 'auth.guest', deviceSecret: id() }));
  let view = await call<RoomView>(
    request,
    { action: 'create', name: '林间', config: standardConfig(count), requestId: id() },
    sessions[0],
  );
  for (let i = 1; i < count; i++)
    view = await call<RoomView>(
      request,
      { action: 'join', name: `骑士${i + 1}`, code: view.room.code, requestId: id() },
      sessions[i],
    );
  const code = view.room.code;
  const get = (index: number) => call<RoomView>(request, { action: 'get', code }, sessions[index]);
  const command = async (index: number, action: GameCommand) => {
    const current = await get(index);
    return call<RoomView>(
      request,
      {
        action: 'command',
        code,
        command: action,
        expectedVersion: current.room.version,
        phaseKey: current.room.phaseKey,
        requestId: id(),
      },
      sessions[index],
    );
  };
  return { sessions, code, get, command };
}
async function enter(page: Page, session: Session, code: string) {
  await page.addInitScript(
    ({ session, code }) => {
      localStorage.setItem('avalon.v1.session', JSON.stringify(session));
      localStorage.setItem('avalon.v1.room', JSON.stringify(code));
    },
    { session, code },
  );
  await page.goto('/');
  await expect(page.getByText(code, { exact: false }).first()).toBeVisible();
}

test('phone: restored room, private identity auto-hides, notes stay private and reload recovers', async ({
  page,
  context,
  request,
}) => {
  const game = await prepare(request);
  await game.command(0, { type: 'start' });
  const first = await game.get(0);
  await enter(page, game.sessions[0], game.code);
  await page
    .getByRole('button', { name: /我的身份/ })
    .last()
    .click();
  const secret = page.locator('.secret-card');
  await expect(secret).toContainText('身份已隐藏');
  await expect(secret.locator('.secret-content')).toHaveCount(0);
  await page.getByRole('button', { name: /临时显示 5 秒/ }).click();
  await expect(secret.locator('.secret-content')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(secret.locator('.secret-content')).toHaveCount(0);
  await page.getByRole('button', { name: /临时显示 5 秒/ }).click();
  await expect(secret.locator('.secret-content')).toBeVisible();
  await expect(secret.locator('.secret-content')).toHaveCount(0, { timeout: 7000 });
  await page.getByRole('button', { name: '确认身份', exact: true }).click();
  await expect.poll(async () => (await game.get(0)).room.readyIds).toContain(first.self.playerId);

  const target = first.room.players[1].id;
  const note = {
    nickname: '只属于我的代号',
    roleGuess: 'merlin' as const,
    alignmentGuess: 'good' as const,
    text: '私人线索，不共享给房主或其他玩家。',
  };
  await call(
    request,
    { action: 'notes.save', code: game.code, notes: { [target]: note }, expectedRevision: 0 },
    game.sessions[0],
  );
  const otherNotes = await call<{ notes: object }>(
    request,
    { action: 'notes.get', code: game.code },
    game.sessions[1],
  );
  expect(otherNotes.notes).toEqual({});
  await page.reload();
  await expect(page.getByText(game.code, { exact: false }).first()).toBeVisible();
  expect((await game.get(0)).self.playerId).toBe(first.self.playerId);
  await page.getByRole('button', { name: '私人笔记', exact: true }).click();
  await expect(page.getByLabel('私人昵称')).toHaveValue('只属于我的代号');
  await page.getByLabel('推理笔记').fill('重新进入后仍然只有我能看见。');
  await page.getByRole('button', { name: '保存私人笔记' }).click();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: /我的身份/ })
    .last()
    .click();
  await expect(secret.locator('.secret-content')).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain('knownPlayers');
  expect(stored).not.toContain('ladyResults');
  await page.screenshot({ path: 'test-results/mobile-identity.png', fullPage: true });
  const reopened = await context.newPage();
  await page.close();
  await reopened.goto('/');
  await expect(reopened.getByText(game.code, { exact: false }).first()).toBeVisible();
  await reopened.getByRole('button', { name: '私人笔记', exact: true }).click();
  await expect(reopened.getByLabel('推理笔记')).toHaveValue('重新进入后仍然只有我能看见。');
});

test('task votes stay available with identity hidden and reveal only anonymous totals', async ({
  browser,
  page,
  request,
}) => {
  const game = await prepare(request);
  await game.command(0, { type: 'start' });
  for (let index = 0; index < 5; index++) await game.command(index, { type: 'ready' });
  const views = await Promise.all(game.sessions.map((_, index) => game.get(index)));
  const goodIndex = views.findIndex((view) => view.self.alignment === 'good');
  const evilIndex = views.findIndex((view) => view.self.alignment === 'evil');
  const leaderIndex = views[0].room.players.findIndex(
    (player) => player.id === views[0].room.leaderId,
  );
  const chosenPlayers = new Set([views[goodIndex].self.playerId, views[evilIndex].self.playerId]);
  const team = views[0].room.players
    .filter((player) => chosenPlayers.has(player.id))
    .map((player) => player.id);
  await game.command(leaderIndex, { type: 'propose', team });
  for (let index = 0; index < 5; index++)
    await game.command(index, { type: 'teamVote', approve: true });
  expect((await game.get(goodIndex)).room.phase).toBe('questVote');

  await enter(page, game.sessions[goodIndex], game.code);
  const evilContext = await browser.newContext({
    ...devices['iPhone 13'],
    baseURL: new URL(page.url()).origin,
  });
  try {
    const evilPage = await evilContext.newPage();
    await enter(evilPage, game.sessions[evilIndex], game.code);

    const factions = page.locator('.faction-group');
    await expect(factions).toHaveCount(2);
    const goodRoles = factions.filter({ hasText: '好人' });
    const evilRoles = factions.filter({ hasText: '坏人' });
    await expect(goodRoles).toContainText(/好人\s*3\s*人/);
    await expect(evilRoles).toContainText(/坏人\s*2\s*人/);
    for (const role of ['梅林', '派西维尔', '忠臣']) await expect(goodRoles).toContainText(role);
    for (const role of ['刺客', '莫甘娜']) await expect(evilRoles).toContainText(role);

    for (const voterPage of [page, evilPage]) {
      await expect(voterPage.locator('.secret-content')).toHaveCount(0);
      await expect(voterPage.getByRole('button', { name: '任务成功', exact: true })).toBeEnabled();
      await expect(voterPage.getByRole('button', { name: '任务失败', exact: true })).toBeEnabled();
    }
    // The identity display expires after five seconds; voting must remain available.
    await page.waitForTimeout(5500);
    for (const voterPage of [page, evilPage]) {
      await expect(voterPage.locator('.secret-content')).toHaveCount(0);
      await expect(voterPage.getByRole('button', { name: '任务成功', exact: true })).toBeEnabled();
      await expect(voterPage.getByRole('button', { name: '任务失败', exact: true })).toBeEnabled();
    }

    await page.getByRole('button', { name: '任务失败', exact: true }).click();
    const invalidVote = page.getByRole('dialog', { name: '提交失败票？' });
    await invalidVote.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    const rejected = await game.get(goodIndex);
    expect(rejected.self.questSubmitted).toBe(false);
    expect(rejected.room.questSubmittedCount).toBe(0);

    await page.getByRole('button', { name: '任务成功', exact: true }).click();
    await expect.poll(async () => (await game.get(goodIndex)).self.questSubmitted).toBe(true);
    await evilPage.getByRole('button', { name: '任务失败', exact: true }).click();
    await evilPage
      .getByRole('dialog', { name: '提交失败票？' })
      .getByRole('button', { name: '确认', exact: true })
      .click();
    await expect.poll(async () => (await game.get(goodIndex)).room.quests.length).toBe(1);

    for (const index of [goodIndex, evilIndex]) {
      const result = await game.get(index);
      expect(result.room.quests[0]).toEqual({
        round: 1,
        team,
        successes: 1,
        fails: 1,
        passed: false,
      });
      expect(result.room.revealedRoles).toEqual([]);
      expect(result.room).not.toHaveProperty('questBallots');
      expect(result.room).not.toHaveProperty('roles');
      for (const player of result.room.players) {
        expect(player).not.toHaveProperty('role');
        expect(player).not.toHaveProperty('alignment');
      }
    }
  } finally {
    await evilContext.close();
  }
});

test('complete five-player game: concurrent votes, anonymous results, assassination, rematch', async ({
  request,
}) => {
  const game = await prepare(request);
  await game.command(0, { type: 'start' });
  for (let i = 0; i < 5; i++) await game.command(i, { type: 'ready' });
  for (let round = 1; round <= 3; round++) {
    let current = await game.get(0);
    expect(current.room.round).toBe(round);
    const leaderIndex = current.room.players.findIndex(
      (player) => player.id === current.room.leaderId,
    );
    const team = current.room.players
      .slice(0, current.room.config.quests[round - 1].size)
      .map((player) => player.id);
    await game.command(leaderIndex, { type: 'propose', team });
    current = await game.get(0);
    await Promise.all(
      game.sessions.map((session) =>
        call(
          request,
          {
            action: 'command',
            code: game.code,
            command: { type: 'teamVote', approve: true },
            expectedVersion: current.room.version,
            phaseKey: current.room.phaseKey,
            requestId: id(),
          },
          session,
        ),
      ),
    );
    expect((await game.get(0)).room.phase).toBe('questVote');
    current = await game.get(0);
    await Promise.all(
      team.map((playerId) =>
        call(
          request,
          {
            action: 'command',
            code: game.code,
            command: { type: 'questVote', success: true },
            expectedVersion: current.room.version,
            phaseKey: current.room.phaseKey,
            requestId: id(),
          },
          game.sessions[current.room.players.findIndex((player) => player.id === playerId)],
        ),
      ),
    );
    const after = await game.get(0);
    expect(after.room.quests[round - 1]).toMatchObject({
      passed: true,
      fails: 0,
      successes: team.length,
    });
    expect(JSON.stringify(after.room)).not.toContain('userId');
    expect(after.room.revealedRoles).toHaveLength(0);
  }
  const views = await Promise.all(game.sessions.map((_, index) => game.get(index)));
  expect(views[0].room.phase).toBe('assassination');
  const assassin = views.findIndex((view) => view.self.canAssassinate);
  const merlin = views.find((view) => view.self.role === 'merlin')!;
  const final = await game.command(assassin, {
    type: 'assassinate',
    targetId: merlin.self.playerId,
  });
  expect(final.room.winner).toBe('evil');
  expect(final.room.revealedRoles).toHaveLength(5);
  const oldGame = final.room.gameId;
  const replay = await game.command(0, { type: 'rematch' });
  expect(replay.room.phase).toBe('lobby');
  expect(replay.room.gameId).not.toBe(oldGame);
  expect(replay.self.role).toBeNull();
});

test('offline reconnect keeps the same seat and resumes current public state', async ({
  page,
  context,
  request,
}) => {
  const game = await prepare(request);
  await enter(page, game.sessions[0], game.code);
  const old = await game.get(0);
  await context.setOffline(true);
  await expect(page.getByText('网络暂时断开，座位和已提交的选择会保留。')).toBeVisible();
  await game.command(1, { type: 'rename', name: '回来还是同一桌' });
  await context.setOffline(false);
  await expect(page.getByText('回来还是同一桌').first()).toBeVisible();
  await page.reload();
  expect((await game.get(0)).self.playerId).toBe(old.self.playerId);
  await expect(page.getByText('回来还是同一桌').first()).toBeVisible();
  const size = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.width);
});

test('phone creates a standard room, edits extensions, and exposes a working invitation QR', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await page.getByLabel('你的公开名字').fill('烛火');
  await page.getByRole('button', { name: '7', exact: true }).click();
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page.getByRole('heading', { name: '游戏大厅' })).toBeVisible();
  await expect(page.getByRole('button', { name: /开始游戏/ })).toBeDisabled();
  await page.getByRole('button', { name: '调整', exact: true }).click();
  const rules = page.getByRole('dialog', { name: '设置本局规则' });
  await rules.getByLabel('兰斯洛特扩展').selectOption('fixed');
  await rules.getByLabel('兰斯洛特扩展').selectOption('changing');
  await rules.getByLabel('湖中仙女', { exact: false }).check();
  await rules.getByRole('button', { name: '保存规则' }).click();
  await expect(rules).toHaveCount(0);
  await expect(page.getByText('兰斯洛特：阵营变化', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '邀请好友' }).click();
  const share = page.getByRole('dialog', { name: '邀请好友' });
  await expect(share.locator('.qr-frame svg')).toBeVisible();
  const code = (await share.locator('.share-code').innerText()).trim();
  expect(code).toMatch(/^[1-9]\d{3}$/);
  expect(new URL(page.url()).searchParams.get('room')).toBe(code);
  await page.screenshot({ path: 'test-results/mobile-invite.png', fullPage: true });
  const visitor = await browser.newContext({
    ...devices['iPhone 13'],
    baseURL: new URL(page.url()).origin,
  });
  try {
    const guest = await visitor.newPage();
    await guest.goto('/');
    await guest.getByRole('button', { name: '加入', exact: true }).click();
    await guest.getByLabel('你的公开名字').fill('朋友');
    await guest.getByLabel('房间号', { exact: true }).fill(code);
    await guest.getByRole('button', { name: '加入房间', exact: true }).click();
    await expect(guest.getByRole('heading', { name: '游戏大厅' })).toBeVisible();
    await expect(guest.locator('.room-badge')).toContainText(code);
  } finally {
    await visitor.close();
  }
});

test('host arranges the physical circle, randomizes once, and everyone sees the next leaders', async ({
  page,
  request,
}) => {
  const game = await prepare(request);
  const before = await game.get(0);
  const ids = before.room.players.map((player) => player.id);
  await enter(page, game.sessions[0], game.code);
  await page.getByRole('button', { name: '调整带队顺序' }).click();
  let editor = page.getByRole('dialog', { name: '调整带队顺序' });
  await editor.getByRole('button', { name: '上移 骑士3', exact: true }).click();
  await editor.getByRole('button', { name: '反向', exact: true }).click();
  const wanted = [ids[0], ids[4], ids[3], ids[1], ids[2]];
  await expect
    .poll(() =>
      editor
        .locator('.seat-order-list li')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-player-id'))),
    )
    .toEqual(wanted);
  await editor.getByRole('button', { name: '保存顺序', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect
    .poll(async () => (await game.get(0)).room.players.map((player) => player.id))
    .toEqual(wanted);
  await page.reload();
  await expect
    .poll(() =>
      page
        .locator('.leader-queue li')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-player-id'))),
    )
    .toEqual(wanted);
  await page.getByRole('button', { name: '调整带队顺序' }).click();
  editor = page.getByRole('dialog', { name: '调整带队顺序' });
  await editor.getByRole('button', { name: '随机排序并保存' }).click();
  await expect(editor).toHaveCount(0);
  const shuffled = (await game.get(0)).room.players.map((player) => player.id);
  expect([...shuffled].sort()).toEqual([...ids].sort());
  await page.getByRole('button', { name: /开始游戏/ }).click();
  await expect.poll(async () => (await game.get(0)).room.phase).toBe('reveal');
  for (let i = 0; i < 5; i++) await game.command(i, { type: 'ready' });
  let current = await game.get(0);
  const index = shuffled.indexOf(current.room.leaderId!);
  const cycle = [...shuffled.slice(index), ...shuffled.slice(0, index)];
  const queueIds = () =>
    page
      .locator('.leader-queue li')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-player-id')));
  await expect.poll(queueIds).toEqual(cycle);
  await expect(page.locator('.leader-queue li').first()).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('.leader-queue li').nth(1)).toContainText('下一位');
  await expect(page.getByRole('button', { name: '调整带队顺序' })).toBeVisible();
  await game.command(ids.indexOf(current.room.leaderId!), {
    type: 'propose',
    team: ids.slice(0, 2),
  });
  for (let i = 0; i < 5; i++) await game.command(i, { type: 'teamVote', approve: false });
  current = await game.get(0);
  expect(current.room.leaderId).toBe(cycle[1]);
  await expect.poll(queueIds).toEqual([...cycle.slice(1), cycle[0]]);
  await page.reload();
  await expect.poll(queueIds).toEqual([...cycle.slice(1), cycle[0]]);
});

test('host changes order midgame, appoints the next leader while voting, and runs manual turns', async ({
  page,
  request,
}) => {
  const game = await prepare(request);
  await game.command(0, { type: 'start' });
  for (let i = 0; i < 5; i++) await game.command(i, { type: 'ready' });
  const initial = await game.get(0);
  const ids = initial.room.players.map((p) => p.id);
  await enter(page, game.sessions[0], game.code);
  await page.getByRole('button', { name: '调整带队顺序' }).click();
  const order = page.getByRole('dialog', { name: '调整带队顺序' });
  await order.getByLabel('带队方式').selectOption('manual');
  await order.getByRole('button', { name: '反向', exact: true }).click();
  await order.getByRole('button', { name: '保存顺序' }).click();
  await expect(order).toHaveCount(0);
  let current = await game.get(0);
  expect(current.room.leaderMode).toBe('manual');
  expect(current.room.leaderId).toBe(initial.room.leaderId);
  expect(current.room.players.map((p) => p.id)).toEqual([ids[0], ...ids.slice(1).reverse()]);
  await expect(page.locator('.manual-leaders')).toContainText('房主指定带队');
  const appoint = async (name: string) => {
    await page.getByRole('button', { name: '指定队长', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: '指定队长' });
    await dialog.getByRole('button', { name, exact: true }).click();
    await dialog.getByRole('button', { name: '确认指定' }).click();
    await expect(dialog).toHaveCount(0);
  };
  await appoint('林间');
  await expect.poll(async () => (await game.get(0)).room.leaderId).toBe(ids[0]);
  await game.command(0, { type: 'propose', team: ids.slice(0, 2) });
  await game.command(0, { type: 'teamVote', approve: true });
  await expect(page.locator('.action-copy h3')).toHaveText('组队投票');
  await page.getByRole('button', { name: '指定队长', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '指定队长' });
  await expect(dialog.getByLabel('生效时间')).toHaveValue('next');
  await expect(dialog.locator('option[value="current"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: '骑士3', exact: true }).click();
  await dialog.getByRole('button', { name: '确认指定' }).click();
  await expect(dialog).toHaveCount(0);
  current = await game.get(0);
  expect(current.room.nextLeaderId).toBe(ids[2]);
  expect(current.room.teamVotedIds).toEqual([ids[0]]);
  expect(current.room.leaderId).toBe(ids[0]);
  for (let i = 1; i < 5; i++) await game.command(i, { type: 'teamVote', approve: false });
  await expect(page.locator('.manual-leaders')).toContainText('当前：骑士3');
  await expect(page.locator('.manual-leaders')).toContainText('下一任：等待指定');
  await game.command(2, { type: 'propose', team: ids.slice(0, 2) });
  for (let i = 0; i < 5; i++) await game.command(i, { type: 'teamVote', approve: false });
  await page.reload();
  await expect(page.getByRole('heading', { name: '等待房主指定队长' })).toBeVisible();
  expect((await game.get(0)).room.leaderId).toBeNull();
  await appoint('骑士5');
  await expect.poll(async () => (await game.get(0)).room.leaderId).toBe(ids[4]);
  await expect(page.locator('.manual-leaders')).toContainText('当前：骑士5');
});

test('a lost mutation response can be retried with its original id without applying twice', async ({
  page,
  request,
}) => {
  const game = await prepare(request);
  await enter(page, game.sessions[0], game.code);
  const before = await game.get(0);
  const ids: string[] = [];
  await page.route('**/api', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload.action === 'command' && payload.command.type === 'rename') {
      ids.push(payload.requestId);
      if (ids.length === 1) {
        await route.fetch(); // The server commits, but the response is lost.
        await route.abort('failed');
        return;
      }
    }
    await route.continue();
  });
  await page.getByRole('button', { name: /1号 林间/ }).click();
  await page.getByLabel('修改公开名字').fill('重试只执行一次');
  await page.getByRole('button', { name: '保存名字' }).click();
  await expect(page.getByRole('button', { name: '确认结果' })).toBeVisible();
  await page.getByRole('button', { name: '确认结果' }).click();
  await expect(page.getByRole('button', { name: '确认结果' })).toHaveCount(0);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  const after = await game.get(0);
  expect(after.room.version).toBe(before.room.version + 1);
  expect(after.room.players[0].name).toBe('重试只执行一次');
});
