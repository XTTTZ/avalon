import { test, expect, devices, type APIRequestContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { standardConfig } from '../shared/rules';
import type { ApiRequest, GameCommand, RoomView, Session } from '../shared/types';
const id = () => randomBytes(24).toString('hex');
async function call<T>(
  request: APIRequestContext,
  payload: ApiRequest,
  session?: Session,
  retryFixtureLogin = true,
): Promise<T> {
  const response = await request.post('/api', {
    data: payload,
    headers: session ? { Authorization: `Bearer ${session.token}` } : {},
  });
  const body = await response.json();
  // All test phones share localhost. Large suites can legitimately exhaust
  // its 60 logins/minute; honor Retry-After once for fixture setup only.
  // Gameplay errors and browser login behavior must still fail immediately.
  if (response.status() === 429 && payload.action === 'auth.guest' && retryFixtureLogin) {
    const delay = Math.min(60, Math.max(1, Number(response.headers()['retry-after']) || 60)) * 1000;
    test.setTimeout(test.info().timeout + delay + 5000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return call<T>(request, payload, session, false);
  }
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
  return { sessions, code, get, command, playerIds: view.room.players.map((player) => player.id) };
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

  const target = game.playerIds[1];
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
  await page.locator('.notes-player').filter({ hasText: '只属于我的代号' }).click();
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
  await reopened.locator('.notes-player').filter({ hasText: '只属于我的代号' }).click();
  await expect(reopened.getByLabel('推理笔记')).toHaveValue('重新进入后仍然只有我能看见。');
});

test('holding identity keeps the card and button fixed even with long private information', async ({
  page,
  request,
}) => {
  const game = await prepare(request, 12);
  for (let index = 0; index < 12; index++)
    await game.command(index, {
      type: 'rename',
      name: `${index + 1}号名字比较长的朋友一起玩阿瓦隆`,
    });
  await game.command(0, { type: 'start' });
  const views = await Promise.all(game.sessions.map((_, index) => game.get(index)));
  const merlinIndex = views.findIndex((view) => view.self.role === 'merlin');
  expect(views[merlinIndex].self.knownPlayers).toHaveLength(4);
  await page.setViewportSize({ width: 320, height: 568 });
  await enter(page, game.sessions[merlinIndex], game.code);
  await page
    .getByRole('button', { name: /我的身份/ })
    .last()
    .click();
  const card = page.locator('.secret-card');
  const hold = page.getByRole('button', { name: '按住显示身份，松开隐藏' });
  await hold.scrollIntoViewIfNeeded();
  // The fixed bottom navigation can cover a button that is inside the viewport.
  // Let actionability scrolling expose the button before measuring a held press.
  await hold.click({ trial: true });
  const buttonBefore = (await hold.boundingBox())!;
  const cardBefore = (await card.boundingBox())!;
  await page.mouse.move(
    buttonBefore.x + buttonBefore.width / 2,
    buttonBefore.y + buttonBefore.height / 2,
  );
  await page.mouse.down();
  await expect(card.locator('.secret-content')).toBeVisible();
  await expect(card.locator('.known-players > div')).toHaveCount(4);
  expect(await hold.boundingBox()).toEqual(buttonBefore);
  expect(await card.boundingBox()).toEqual(cardBefore);
  // Extra information scrolls inside the card instead of pushing the held control away.
  const viewport = card.locator('.secret-viewport');
  expect(await viewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await page.mouse.up();
  await expect(card.locator('.secret-content')).toHaveCount(0);
  expect(await hold.boundingBox()).toEqual(buttonBefore);
  expect(await card.boundingBox()).toEqual(cardBefore);

  await hold.focus();
  await page.keyboard.down('Space');
  await expect(card.locator('.secret-content')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(card.locator('.secret-content')).toHaveCount(0);
  await page.keyboard.up('Space');
  await expect(page.getByRole('button', { name: '确认身份', exact: true })).toBeEnabled();
});

test('private nickname replaces names across seats, leader controls and every history record', async ({
  page,
  browser,
  request,
}) => {
  const game = await prepare(request);
  const initial = await game.get(0);
  const target = initial.room.players[1];
  const nickname = '我的长昵称好友一起玩阿瓦隆';
  await enter(page, game.sessions[0], game.code);
  await page.getByRole('button', { name: '私人笔记', exact: true }).click();
  await page.getByLabel('私人昵称').fill(nickname);
  await page.getByRole('button', { name: '保存私人笔记' }).click();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await expect(page.locator('.note-editor h3')).toHaveText(nickname);
  await page.getByRole('button', { name: '公共圆桌', exact: true }).click();
  const seat = page
    .locator('.players-grid')
    .getByRole('button', { name: `2号 ${nickname}`, exact: true });
  await expect(seat).toBeVisible();
  await expect(seat).not.toContainText(target.name);
  await expect(page.locator(`.player-seat[data-player-id="${target.id}"] .player-name`)).toHaveText(
    nickname,
  );
  const heights = await page
    .locator('.players-grid .player-seat')
    .evaluateAll((seats) => seats.map((item) => item.getBoundingClientRect().height));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const sizes = await page
      .locator('.player-seat')
      .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/mobile-table-nicknames.png', fullPage: true });

  await page.getByRole('button', { name: '调整带队顺序' }).click();
  await expect(
    page
      .locator('.sorting-players')
      .getByRole('button', { name: `2号 ${nickname} 拖动排序`, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.sorting-players')).not.toContainText(target.name);
  await page.getByRole('button', { name: '取消', exact: true }).click();

  await game.command(0, { type: 'start' });
  for (let index = 0; index < 5; index++) await game.command(index, { type: 'ready' });
  await game.command(0, { type: 'assignLeader', targetId: target.id, timing: 'current' });
  const team = initial.room.players.slice(0, 2).map((player) => player.id);
  await game.command(1, { type: 'propose', team });
  await page.reload();
  await expect(page.locator('.action-panel')).toContainText(nickname);
  await expect(page.locator('.action-panel')).not.toContainText(target.name);
  for (let index = 0; index < 5; index++)
    await game.command(index, { type: 'teamVote', approve: true });
  for (let index = 0; index < 2; index++)
    await game.command(index, { type: 'questVote', success: true });
  await page.reload();
  await page.getByRole('button', { name: '圆桌战报', exact: true }).click();
  await expect(page.locator('.history-card')).toContainText(nickname);
  await expect(page.locator('.vote-record summary')).toContainText(`队长 ${nickname}`);
  await page.locator('.vote-record summary').click();
  await expect(page.locator('.public-votes')).toContainText(nickname);
  await expect(page.locator('.event-list')).toContainText(`${nickname} 提交了任务队伍`);
  await expect(page.locator('.event-list')).toContainText(`${nickname} 加入了房间`);
  for (const group of await page.locator('.history-group').all())
    await expect(group).not.toContainText(target.name);
  await page.screenshot({ path: 'test-results/mobile-history-nicknames.png', fullPage: true });

  // A nickname is only a local presentation choice; neither public records nor another player inherit it.
  const publicView = await game.get(1);
  expect(publicView.room.players.find((player) => player.id === target.id)?.name).toBe(target.name);
  expect(JSON.stringify(publicView)).not.toContain(nickname);
  const otherContext = await browser.newContext({
    ...devices['iPhone 13'],
    baseURL: new URL(page.url()).origin,
  });
  try {
    const otherPage = await otherContext.newPage();
    await enter(otherPage, game.sessions[1], game.code);
    await expect(otherPage.locator('.players-grid')).toContainText(target.name);
    await expect(otherPage.locator('.players-grid')).not.toContainText(nickname);
  } finally {
    await otherContext.close();
  }
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
  const leaderIndex = game.playerIds.indexOf(views[0].room.leaderId!);
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
  page,
  request,
}) => {
  const game = await prepare(request);
  await game.command(0, { type: 'start' });
  for (let i = 0; i < 5; i++) await game.command(i, { type: 'ready' });
  for (let round = 1; round <= 3; round++) {
    let current = await game.get(0);
    expect(current.room.round).toBe(round);
    const leaderIndex = game.playerIds.indexOf(current.room.leaderId!);
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
          game.sessions[game.playerIds.indexOf(playerId)],
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
  await enter(page, game.sessions[assassin], game.code);
  await page
    .getByRole('button', { name: /我的身份/ })
    .last()
    .click();
  await page.getByRole('button', { name: /临时显示 5 秒/ }).click();
  await expect(page.locator('.secret-content')).toBeVisible();
  await expect(page.locator('.secret-content')).toHaveCount(0, { timeout: 7000 });
  await page.getByRole('button', { name: '公共圆桌', exact: true }).click();
  const assassination = page.locator('.assassination-action');
  const merlinPlayer = merlin.room.players.find((player) => player.id === merlin.self.playerId)!;
  const choose = assassination.getByRole('button', {
    name: `${merlinPlayer.seat + 1}. ${merlinPlayer.name}`,
    exact: true,
  });
  await choose.click();
  await page.waitForTimeout(5500);
  await expect(page.locator('.secret-content')).toHaveCount(0);
  await expect(choose).toHaveAttribute('aria-pressed', 'true');
  const kill = assassination.getByRole('button', {
    name: `确认刺杀 · ${merlinPlayer.name}`,
    exact: true,
  });
  await expect(kill).toBeEnabled();
  await page.screenshot({ path: 'test-results/mobile-assassination.png', fullPage: true });
  await kill.click();
  await page
    .getByRole('dialog', { name: '确认刺杀目标？' })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect.poll(async () => (await game.get(assassin)).room.phase).toBe('finished');
  const final = await game.get(assassin);
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

async function cardOrder(page: Page) {
  return page
    .locator('.players-grid [data-player-id]')
    .evaluateAll((cards) =>
      cards
        .sort(
          (a, b) =>
            Number(a.getAttribute('data-position')) - Number(b.getAttribute('data-position')),
        )
        .map((card) => card.getAttribute('data-player-id')),
    );
}
async function dragCard(page: Page, fromId: string, toId: string, touch = true) {
  const grid = page.locator('.sorting-players');
  await grid.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250); // Wait for the toolbar's smooth scroll to settle.
  const from = (await grid.locator(`[data-player-id="${fromId}"]`).boundingBox())!;
  const to = (await grid.locator(`[data-player-id="${toId}"]`).boundingBox())!;
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  if (touch) {
    const client = await page.context().newCDPSession(page);
    try {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...start, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ ...end, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await client.detach();
    }
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y);
    await page.mouse.up();
  }
}

test('host drags the player cards with touch and mouse, saves their circle, and play follows it', async ({
  page,
  request,
}) => {
  const game = await prepare(request);
  const ids = game.playerIds;
  await enter(page, game.sessions[0], game.code);
  await expect(page.locator('.leader-queue')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '指定队长', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '调整带队顺序' }).click();
  await dragCard(page, ids[1], ids[0]);
  const desired = [ids[1], ids[0], ...ids.slice(2)];
  await expect.poll(() => cardOrder(page)).toEqual(desired);
  expect((await game.get(0)).room.players.map((player) => player.id)).toEqual(ids);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect.poll(() => cardOrder(page)).toEqual(ids);
  await page.getByRole('button', { name: '调整带队顺序' }).click();
  await dragCard(page, ids[1], ids[0], false);
  await expect.poll(() => cardOrder(page)).toEqual(desired);
  await page.screenshot({ path: 'test-results/mobile-card-sort.png', fullPage: true });
  await page.getByRole('button', { name: '保存顺序', exact: true }).click();
  await expect(page.locator('.sorting-players')).toHaveCount(0);
  await page.getByRole('button', { name: '刷新游戏状态' }).click();
  await expect.poll(() => cardOrder(page)).toEqual(desired);
  await page.getByRole('button', { name: /开始游戏/ }).click();
  await expect.poll(async () => (await game.get(0)).room.phase).toBe('reveal');
  for (let i = 0; i < 5; i++) await game.command(i, { type: 'ready' });
  let current = await game.get(0);
  const startedOrder = current.room.players.map((player) => player.id);
  expect([...startedOrder].sort()).toEqual([...ids].sort());
  expect(current.room.orderCustomized).toBe(false);
  expect(current.room.leaderId).toBe(startedOrder[0]);
  await page.getByRole('button', { name: '刷新游戏状态' }).click();
  await expect.poll(() => cardOrder(page)).toEqual(startedOrder);
  const roleViews = await Promise.all(game.sessions.map((_, index) => game.get(index)));
  expect(roleViews.map((view) => view.self.role).sort()).toEqual(
    [...current.room.config.roles].sort(),
  );
  expect(current.room.revealedRoles).toEqual([]);
  await game.command(game.playerIds.indexOf(startedOrder[0]), {
    type: 'propose',
    team: startedOrder.slice(0, 2),
  });
  for (let i = 0; i < 5; i++) await game.command(i, { type: 'teamVote', approve: false });
  current = await game.get(0);
  expect(current.room.leaderId).toBe(startedOrder[1]);
  await page.getByRole('button', { name: '刷新游戏状态' }).click();
  await expect.poll(() => cardOrder(page)).toEqual(startedOrder);
  await expect(page.locator(`[data-player-id="${startedOrder[1]}"]`)).toHaveAttribute(
    'data-leader',
    'true',
  );
});

test('midgame card sorting preserves current votes and controls the next leader', async ({
  page,
  request,
}) => {
  const game = await prepare(request);
  await game.command(0, { type: 'start' });
  for (let i = 0; i < 5; i++) await game.command(i, { type: 'ready' });
  const original = await game.get(0);
  const ids = original.room.players.map((player) => player.id);
  expect(original.room.leaderId).toBe(ids[0]);
  await game.command(game.playerIds.indexOf(ids[0]), { type: 'propose', team: ids.slice(0, 2) });
  await game.command(0, { type: 'teamVote', approve: true });
  await enter(page, game.sessions[0], game.code);
  await page.getByRole('button', { name: '调整带队顺序' }).click();
  await dragCard(page, ids[2], ids[1]);
  const desired = [ids[0], ids[2], ids[1], ...ids.slice(3)];
  await expect.poll(() => cardOrder(page)).toEqual(desired);
  await page.getByRole('button', { name: '保存顺序', exact: true }).click();
  await expect
    .poll(async () => (await game.get(0)).room.players.map((player) => player.id))
    .toEqual(desired);
  const voting = await game.get(0);
  expect(voting.room.leaderId).toBe(ids[0]);
  expect(voting.room.teamVotedIds).toEqual([game.playerIds[0]]);
  for (let i = 1; i < 5; i++) await game.command(i, { type: 'teamVote', approve: false });
  expect((await game.get(0)).room.leaderId).toBe(ids[2]);
  await page.getByRole('button', { name: '刷新游戏状态' }).click();
  await expect(page.locator(`[data-player-id="${ids[2]}"]`)).toHaveAttribute('data-leader', 'true');
});

test('manual refresh preserves the page and unsaved notes while updating room state', async ({
  page,
  request,
}) => {
  const game = await prepare(request);
  await enter(page, game.sessions[0], game.code);
  await page.evaluate(() => {
    (window as unknown as { refreshSentinel: string }).refreshSentinel = 'same-document';
  });
  await page.getByRole('button', { name: '私人笔记', exact: true }).click();
  await page.getByLabel('推理笔记').fill('还没有保存的笔记');
  await game.command(1, { type: 'rename', name: '最新公开名' });
  await page.getByRole('button', { name: '刷新游戏状态' }).click();
  await expect(page.locator('.notes-player')).toContainText([
    '最新公开名',
    '骑士3',
    '骑士4',
    '骑士5',
  ]);
  await expect(page.getByLabel('推理笔记')).toHaveValue('还没有保存的笔记');
  expect(
    await page.evaluate(() => (window as unknown as { refreshSentinel: string }).refreshSentinel),
  ).toBe('same-document');
  await expect(page.getByRole('button', { name: '私人笔记', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('host removes a lobby player, and a live removal ends the game and revokes access', async ({
  page,
  browser,
  request,
}) => {
  const lobby = await prepare(request);
  await enter(page, lobby.sessions[0], lobby.code);
  await page.getByRole('button', { name: '踢人', exact: true }).click();
  await page
    .getByRole('dialog', { name: '移除玩家', exact: true })
    .getByRole('button', { name: '2. 骑士2' })
    .click();
  await page
    .getByRole('dialog', { name: '移除玩家？' })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect.poll(async () => (await lobby.get(0)).room.players.length).toBe(4);
  await expect(lobby.get(1)).rejects.toThrow('FORBIDDEN');

  const game = await prepare(request);
  await game.command(0, { type: 'start' });
  const before = await game.get(0);
  const target = before.room.players.find((player) => player.id === game.playerIds[1])!;
  await call(
    request,
    {
      action: 'notes.save',
      code: game.code,
      expectedRevision: 0,
      notes: {
        [target.id]: { nickname: '我的朋友', roleGuess: '', alignmentGuess: 'unknown', text: '' },
      },
    },
    game.sessions[0],
  );
  const guestContext = await browser.newContext({
    ...devices['iPhone 13'],
    baseURL: new URL(page.url()).origin,
  });
  try {
    const guestPage = await guestContext.newPage();
    await enter(guestPage, game.sessions[1], game.code);
    await expect(guestPage.getByRole('button', { name: '踢人', exact: true })).toHaveCount(0);
    await enter(page, game.sessions[0], game.code);
    await page.getByRole('button', { name: '踢人', exact: true }).click();
    await page
      .getByRole('dialog', { name: '移除玩家', exact: true })
      .getByRole('button', { name: `${target.seat + 1}. 我的朋友` })
      .click();
    const confirmation = page.getByRole('dialog', { name: '结束本局并移除玩家？' });
    await expect(confirmation).toContainText('公开所有身份');
    await confirmation.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('heading', { name: '本局已结束', exact: true })).toBeVisible();
    const finished = await game.get(0);
    expect(finished.room.players).toHaveLength(4);
    expect(finished.room.revealedRoles).toHaveLength(5);
    await page.getByRole('button', { name: '刷新游戏状态' }).click();
    await expect(page.locator('.departed-player')).toContainText('我的朋友 · 已移除');
    await page.getByRole('button', { name: '私人笔记', exact: true }).click();
    await page.locator('.notes-player').filter({ hasText: '我的朋友' }).click();
    await expect(page.getByLabel('私人昵称')).toHaveValue('我的朋友');
    await page.getByLabel('推理笔记').fill('结算保留我的笔记');
    await page.getByRole('button', { name: '保存私人笔记' }).click();
    await expect(page.getByText('已保存', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '圆桌战报', exact: true }).click();
    await expect(page.locator('.event-list')).toContainText('我的朋友 已被移出房间');
    await guestPage.getByRole('button', { name: '刷新游戏状态' }).click();
    await expect(guestPage.getByRole('button', { name: '创建房间', exact: true })).toBeVisible();
    await expect(game.get(1)).rejects.toThrow('FORBIDDEN');
    await expect(
      call(request, { action: 'notes.get', code: game.code }, game.sessions[1]),
    ).rejects.toThrow('FORBIDDEN');
  } finally {
    await guestContext.close();
  }
});
