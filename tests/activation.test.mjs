import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, MODULE_NAME, META_KEY } from '../src/defaults.js';
import { createBattle } from '../src/engine.js';
import * as ST from '../src/st.js';
import { registerMacros, registerTool } from '../src/llm.js';
import { handleMessage, revertMessage, handleDeleted } from '../src/ui/llm-flow.js';
import { installBattleMessageFolding } from '../src/ui/chat-messages.js';

// Editors register their mouse-up listener at import time.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
globalThis.window = { addEventListener() {} };
const { App } = await import('../src/ui/panel.js');
if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
else delete globalThis.window;

function fixture(t) {
    const settings = defaultSettings();
    const profile = settings.profiles[0];
    const raw = createBattle(profile.maps[0], profile.units, profile.terrains);
    raw.profileId = profile.id; raw.profileName = profile.name;
    raw.log = ['不应泄露的旧战斗记录'];
    const prompts = [], macros = new Map();
    let saves = 0, quietCalls = 0, tool;
    const context = {
        chatId: 'alice-chat', characterId: 0,
        characters: [{ name: 'Alice', avatar: 'alice.png' }, { name: 'Bob', avatar: 'bob.png' }],
        extensionSettings: { [MODULE_NAME]: settings }, chatMetadata: { [META_KEY]: raw },
        chat: [{ is_user: false, mes: '普通聊天 <srpg>damage P1 5 落石</srpg>' }],
        saveMetadataDebounced() { saves++; },
        setExtensionPrompt(key, text) { prompts.push(text); },
        registerMacro(name, fn) { macros.set(name, fn); },
        registerFunctionTool(value) { tool = value; },
        async generateQuietPrompt() { quietCalls++; return ''; },
    };
    for (const [key, value] of Object.entries({ SillyTavern: { getContext: () => context }, document: { getElementById() { throw new Error('未绑定时不应操作输入框'); } } })) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
    }
    return { settings, profile, raw, context, prompts, macros, app: new App(), saves: () => saves, quietCalls: () => quietCalls, tool: () => tool };
}

test('未绑定角色不会读写旧战斗、注入提示词、改写回复或调用LLM', async t => {
    const { settings, raw, context, prompts, app, saves, quietCalls } = fixture(t);
    settings.llm.commands = true;
    settings.llm.hideBlock = true;
    raw.llm = { proposals: { mesId: 0 }, applied: { mesId: 0, rev: 7, snapshot: { turn: 99 } } };
    raw.rev = 7;
    const before = structuredClone(context.chatMetadata), message = context.chat[0].mes;
    assert.equal(ST.isEnabledForChat(), false);
    assert.equal(ST.getBattle(), null);
    assert.equal(ST.setBattle(null), false);
    ST.saveBattle();
    await app.updateInjection();
    ST.setInjection('不应该注入的内容');
    assert.ok(prompts.every(text => text === ''));
    assert.equal(app.battleContext(), '');
    await handleMessage(app, 0, 'normal');
    revertMessage(app, 0); handleDeleted(app);
    await ST.rewriteMessage(0, '不应该改写');
    assert.equal(ST.sendAsUser('不应该发送'), false);
    assert.equal(ST.writeMainInput('不应该填入'), false);
    await assert.rejects(ST.quietGenerate('不应该生成'), /未绑定/);
    assert.equal(context.chat[0].mes, message);
    assert.deepEqual(context.chatMetadata, before);
    assert.equal(saves(), 0); assert.equal(quietCalls(), 0);
});

test('未绑定聊天的宏为空，工具不暴露；显式绑定后可用，解绑后立即停用', async t => {
    const { app, settings, profile, raw, macros, tool, prompts } = fixture(t);
    settings.tool.enabled = true;
    registerMacros(app); registerTool(app);
    for (const fn of macros.values()) assert.equal(fn(), '');
    assert.equal(tool().shouldRegister(), false);
    settings.bindings['char:alice.png'] = profile.id;
    assert.equal(ST.getBattle(), raw);
    assert.equal(macros.get('srpg_turn')(), '1');
    assert.equal(tool().shouldRegister(), true);
    await app.updateInjection();
    assert.ok(prompts.at(-1).includes('河畔之战'));
    delete settings.bindings['char:alice.png'];
    await app.updateInjection();
    assert.equal(prompts.at(-1), '');
    for (const fn of macros.values()) assert.equal(fn(), '');
    assert.equal(tool().shouldRegister(), false);
});

test('一张资料卡绑定多个角色，分别使用各自聊天进度；群组必须单独绑定', t => {
    const { settings, profile, raw, context } = fixture(t);
    settings.bindings['char:alice.png'] = profile.id;
    settings.bindings['char:bob.png'] = profile.id;
    assert.equal(ST.getBattle(), raw);
    const bob = structuredClone(raw); bob.turn = 7;
    context.characterId = 1; context.chatId = 'bob-chat'; context.chatMetadata = { [META_KEY]: bob };
    assert.equal(ST.getBattle(), bob);
    assert.equal(raw.turn, 1);
    context.groupId = 'g'; context.chatId = 'group-chat';
    assert.equal(ST.isEnabledForChat(), false, '不能继承群组成员的绑定');
    settings.bindings['group:g'] = profile.id;
    assert.equal(ST.isEnabledForChat(), true);
});

test('失效绑定或旧战斗所属资料卡不匹配时不得启用或覆盖旧战斗', async t => {
    const { settings, raw, context, app, prompts, saves } = fixture(t);
    settings.bindings['char:alice.png'] = 'missing';
    assert.equal(ST.isEnabledForChat(), false);
    settings.bindings['char:alice.png'] = settings.profiles[0].id;
    raw.profileId = 'other-profile';
    assert.equal(ST.getBattle(), null);
    assert.equal(ST.setBattle(null), false);
    ST.saveBattle();
    await app.updateInjection();
    assert.equal(prompts.at(-1), '');
    assert.equal(context.chatMetadata[META_KEY], raw);
    assert.equal(saves(), 0);
});

test('异步世界书读取中切换到未绑定角色，完成后不能把旧提示词注入新聊天', async t => {
    const { settings, profile, raw, context, app, prompts } = fixture(t);
    settings.bindings['char:alice.png'] = profile.id;
    settings.inject.includeWb = true;
    raw.units[0].wb = { book: 'async-binding-test', uid: 1, label: '秘密', keys: ['勇者'] };
    let finish;
    context.loadWorldInfo = () => new Promise(resolve => { finish = resolve; });
    t.mock.method(globalThis, 'setTimeout', () => 0);
    const pending = app.updateInjection();
    assert.ok(finish);
    context.characterId = 1; context.chatId = 'bob-chat'; context.chatMetadata = {};
    finish({ entries: { 1: { uid: 1, comment: '秘密', key: ['勇者'], content: '仅绑定角色能读取的秘密' } } });
    await pending;
    assert.ok(prompts.every(text => text === ''));
    assert.deepEqual(app.wbCache, {});
});

test('未绑定角色附带资料卡也不会自动启用，自动界面收起且不弹导入提示', async t => {
    const { settings, context, app, profile } = fixture(t);
    context.characters[0].data = { extensions: { tavern_srpg: { format: 'tavern-srpg-profile', profile } } };
    context.callGenericPopup = () => { throw new Error('不应自动弹窗'); };
    app.panel = { hidden: false };
    app._open = true;
    await app.syncProfileWithChat();
    assert.equal(app.isOpen, false);
    assert.equal(app.panel.hidden, true);
    assert.deepEqual(settings.bindings, {});
    assert.equal(ST.isEnabledForChat(), false);
});

test('未绑定角色不启动聊天折叠观察器，绑定后启动、解绑后断开', t => {
    const { settings, context, profile } = fixture(t);
    context.eventTypes = {};
    context.eventSource = { on() {} };
    document.getElementById = () => ({ querySelectorAll: () => [] });
    let observed = 0, disconnected = 0;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
    globalThis.MutationObserver = class {
        observe() { observed++; }
        disconnect() { disconnected++; }
    };
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'MutationObserver', descriptor); else delete globalThis.MutationObserver; });
    const refresh = installBattleMessageFolding();
    assert.equal(observed, 0);
    settings.bindings['char:alice.png'] = profile.id;
    refresh();
    assert.equal(observed, 1);
    delete settings.bindings['char:alice.png'];
    refresh();
    assert.equal(disconnected, 1);
});
