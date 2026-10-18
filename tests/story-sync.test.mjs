import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, MODULE_NAME, META_KEY } from '../src/defaults.js';
import { createBattle } from '../src/engine.js';
import * as ST from '../src/st.js';
import { handleStoryMessage, handleStorySwiped, handleStoryDeleted, syncStory, syncInfo } from '../src/ui/story-flow.js';

const GROWTH = JSON.stringify({
    summary: '法师学会了星落；一行人在神殿前与暗影教团对峙',
    growth: { updates: [{ unit: '法师', reason: '在图书馆学会', addSkills: [{ name: '星落', kind: 'magical', power: 140, rangeMax: 4, cooldown: 3 }] }] },
    battle: { place: '废弃神殿', summary: '暗影教团伏击' },
});

/** 一个绑定了资料卡的聊天；generateRaw 按顺序返回 replies（可以是等待中的 Promise） */
function fixture(t, replies = []) {
    const settings = defaultSettings();
    const profile = settings.profiles[0];
    settings.bindings['char:alice.png'] = profile.id;
    settings.designer.books = [];
    settings.designer.includeChar = false;
    Object.assign(settings.designer.story, { enabled: true, trigger: 'interval', every: 2, chatDepth: 4 });
    const calls = [];
    const context = {
        chatId: 'chat-1', characterId: 0, characters: [{ name: 'Alice', avatar: 'alice.png' }],
        extensionSettings: { [MODULE_NAME]: settings }, chatMetadata: {}, chat: [],
        saveMetadataDebounced() {},
        setExtensionPrompt() { throw new Error('剧情同步不应注入提示词'); },
        async generateQuietPrompt() { throw new Error('剧情同步不应使用聊天生成'); },
        async generateRaw({ prompt, systemPrompt }) { calls.push({ prompt, system: systemPrompt }); return replies.shift() ?? '{}'; },
    };
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SillyTavern');
    globalThis.SillyTavern = { getContext: () => context };
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'SillyTavern', descriptor); else delete globalThis.SillyTavern; });
    const app = {
        settings, data: profile, isOpen: false, bs: { undo: [] },
        render() {}, save() {}, updateInjection() {}, setTab() {}, battleContext: () => '【战场状态】',
    };
    const say = (mes, isUser = false) => { context.chat.push({ name: isUser ? '我' : 'Alice', is_user: isUser, mes }); return context.chat.length - 1; };
    return { settings, profile, context, calls, app, say, store: () => ST.getStory() };
}

/** 等待后台同步与关卡生成结束 */
async function idle() {
    for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 0));
    assert.equal(syncInfo().working, null);
}

test('每隔 N 轮 AI 回复自动同步：只用插件模型，读取指定楼层，不改写聊天', async t => {
    const { context, calls, app, say, store, profile } = fixture(t, [GROWTH, '{}']);
    say('出发吧', true);
    handleStoryMessage(app, say('我们走。'), 'normal');
    assert.equal(calls.length, 0, '第一次只记下起点');
    assert.equal(store().syncedTo, 0);
    say('去图书馆', true);
    const id = say('法师在古书中领悟了星落。远处，暗影教团已经包围了神殿。');
    const before = context.chat.map(m => m.mes);
    handleStoryMessage(app, id, 'normal');
    assert.ok(syncInfo().working, '第二轮回复后开始同步');
    await idle();

    assert.equal(calls.length, 2, '一次同步 + 一次关卡设计');
    assert.match(calls[0].system, /剧情同步助手/);
    assert.match(calls[0].prompt, /## 之前的剧情（已经同步过，只作参考）\n#0 我：出发吧/);
    assert.match(calls[0].prompt, /## 新的剧情（只处理这一部分）\n#1 Alice：我们走。[\s\S]*#3 Alice：法师在古书中领悟了星落/);
    assert.deepEqual(context.chat.map(m => m.mes), before, '不改写聊天消息');

    const s = store();
    assert.equal(s.syncedTo, 3);
    assert.deepEqual(s.sync.found, ['角色成长', '剧情关卡']);
    const grow = s.items.find(x => x.kind === 'grow');
    assert.equal(grow.status, 'ready');
    assert.equal(grow.subject, '法师');
    assert.deepEqual([grow.from, grow.mesId, grow.profileId], [1, 3, profile.id]);
    const level = s.items.find(x => x.kind === 'battle');
    assert.deepEqual([level.subject, level.text, level.status], ['废弃神殿', '暗影教团伏击', 'ready']);
    assert.equal(profile.units.find(u => u.name === '法师').skills.some(sk => sk.name === '星落'), false, '默认等待确认，不直接修改资料卡');
});

test('重新生成、滑动或删除已同步的楼层：同步作废，下次从那次同步的起点重新读取', async t => {
    const { app, say, store } = fixture(t, [GROWTH, '{}']);
    say('出发吧', true);
    handleStoryMessage(app, say('我们走。'), 'normal');
    say('去图书馆', true);
    handleStoryMessage(app, say('法师领悟了星落。'), 'normal');
    await idle();
    handleStorySwiped(app, 3);
    assert.equal(store().syncedTo, 0);
    assert.ok(store().items.every(x => x.status === 'dismissed'));
    assert.deepEqual(syncInfo().fresh, 2);
    handleStoryDeleted(app); // 没有被删的楼层：什么都不变
    assert.equal(store().syncedTo, 0);
});

test('同步期间这一楼被重新生成：结果作废，不更新进度', async t => {
    let release;
    const pending = new Promise(r => { release = r; });
    const { app, say, store } = fixture(t, [pending]);
    say('出发吧', true);
    handleStoryMessage(app, say('我们走。'), 'normal');
    say('去图书馆', true);
    handleStoryMessage(app, say('法师领悟了星落。'), 'normal');
    assert.ok(syncInfo().working);
    handleStorySwiped(app, 3);
    assert.equal(syncInfo().working, null, '作废后可以立即开始新的同步');
    release(GROWTH);
    await idle();
    assert.equal(store().syncedTo, 0);
    assert.equal(store().items.length, 0);
});

test('手动模式：回复不会触发同步；点击后可以指定楼层范围', async t => {
    const { settings, app, say, store, calls } = fixture(t, ['{"summary":"无","growth":{"updates":[]}}', '{}']);
    settings.designer.story.trigger = 'manual';
    for (let i = 0; i < 4; i++) { say(`第${i}句`, true); handleStoryMessage(app, say(`回复${i}`), 'normal'); }
    await idle();
    assert.equal(calls.length, 0);
    assert.equal(syncInfo().fresh, 4);
    assert.equal(await syncStory(app, { from: 2, to: 5, manual: true }), true);
    assert.match(calls[0].prompt, /## 新的剧情（只处理这一部分）\n#2 我：第1句[\s\S]*#5 Alice：回复2$/);
    assert.equal(store().syncedTo, 5);
    assert.deepEqual(store().sync.found, []);
    assert.equal(syncInfo().fresh, 1);
    assert.equal(await syncStory(app, { manual: true }), true);
    assert.equal(store().syncedTo, 7);
    assert.equal(await syncStory(app, { manual: true }), false, '没有新剧情时不调用模型');
    assert.equal(calls.length, 2);
});

test('战斗中：附上战场状态，剧情造成的战场变化列为待确认的提议；不再提出新关卡', async t => {
    const { settings, profile, context, app, say, calls } = fixture(t, [JSON.stringify({ summary: '落石', battleChanges: ['damage E1 3 被落石砸中'] })]);
    settings.llm.commands = true;
    const b = createBattle(profile.maps[0], profile.units, profile.terrains);
    b.profileId = profile.id;
    context.chatMetadata[META_KEY] = b;
    say('攻击！', true);
    handleStoryMessage(app, say('洞顶的石块砸了下来。'), 'normal');
    assert.equal(await syncStory(app, { manual: true }), true);
    assert.match(calls[0].system, /battleChanges/);
    assert.doesNotMatch(calls[0].system, /"battle": null 或/);
    assert.match(calls[0].prompt, /## 进行中的战斗（战场状态由战斗系统计算）\n【战场状态】/);
    assert.deepEqual(b.llm.proposals.cmds.map(c => c.raw), ['damage E1 3 被落石砸中']);
    assert.equal(b.llm.proposals.mesId, 1);
});
