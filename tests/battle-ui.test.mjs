import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, META_KEY, makeUnit, makeMap } from '../src/defaults.js';
import { newBattleUi, renderBattleTab } from '../src/ui/battle.js';
import { renderProfilesTab } from '../src/ui/profiles-tab.js';

// Minimal DOM for exercising the real battle renderer and its event handlers.
class TestNode {
    constructor(tag = '', text = '') {
        this.tag = tag;
        this.text = text;
        this.children = [];
        this.style = {};
        this.dataset = {};
        this.disabled = false;
        this.checked = false;
        this.listeners = {};
        this.classes = new Set();
        this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    }
    get firstChild() { return this.children[0]; }
    get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
    set textContent(value) { this.text = String(value); this.children = []; }
    append(...children) {
        for (const child of children) { child.parent = this; this.children.push(child); }
    }
    remove() { this.parent?.removeChild(this); }
    focus() { document.activeElement = this; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(key, value) {
        this[key] = value;
        if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value);
    }
}

function find(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children) {
        const found = find(child, predicate);
        if (found) return found;
    }
}

function setup(t) {
    const context = { chatId: 'test-chat', chatMetadata: {}, saveMetadataDebounced() { saves++; } };
    let saves = 0;
    const setGlobal = (key, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        });
    };
    setGlobal('Node', TestNode);
    setGlobal('document', {
        createElement: tag => new TestNode(tag),
        createTextNode: text => new TestNode('', text),
    });
    setGlobal('window', { toastr: { success() {} } });
    setGlobal('SillyTavern', { getContext: () => context });
    const settings = defaultSettings();
    settings.bindings['char:test.png'] = settings.profiles[0].id;
    context.characterId = 0;
    context.characters = [{ name: '测试角色', avatar: 'test.png' }];
    context.extensionSettings = { tavern_srpg: settings };
    settings.ui.animate = false; // 常规交互测试即时结算；回放另行验证。
    settings.ui.confirmDefense = false; // 交互选择另行验证，常规测试自动响应。
    const root = new TestNode('div');
    let injections = 0;
    const app = {
        settings, data: settings.profiles[0], bs: newBattleUi(),
        panel: new TestNode('div'),
        cellFor: () => 32,
        updateInjection() { injections++; },
        render() { renderBattleTab(this, root); },
    };
    const click = label => {
        const button = find(root, n => n.tag === 'button' && n.textContent === label);
        assert.ok(button, `Missing button: ${label}`);
        return button.listeners.click();
    };
    app.render();
    return { app, root, context, click, saves: () => saves, injections: () => injections };
}

test('开始战斗后显示棋盘，并可选择单位和待机', t => {
    const { app, root, context, click } = setup(t);
    click('开始战斗');
    const battle = context.chatMetadata[META_KEY];
    assert.equal(battle.active, true);
    assert.equal(battle.profileId, app.data.id);
    assert.ok(root.textContent.includes('第 1 回合'));
    const board = find(root, n => n.classes.has('tsrpg-board'));
    assert.equal(board.children.length, battle.w * battle.h);
    const unit = battle.units.find(u => u.side === 'player');
    const cell = board.children[unit.y * battle.w + unit.x];
    board.listeners.mousedown({ button: 0, target: { closest: () => cell } });
    assert.equal(app.bs.sel, unit.uid);
    assert.equal(app.bs.mode, 'move');
    click('原地行动');
    click('待机');
    assert.equal(unit.acted, true);
    assert.ok(find(root, n => n.classes.has('tsrpg-board')));
});

test('小窗结束战斗需要明确确认，取消保留进度，旧确认不能清除新战斗', t => {
    const { app, root, context, click, saves } = setup(t);
    app.settings.ui.layout = 'compact';
    app.render();
    click('开始战斗');
    const battle = context.chatMetadata[META_KEY];
    const beforeSave = saves();
    const management = find(root, n => n.classes.has('tsrpg-battle-management'));
    assert.ok(management);
    assert.ok(!management.open, '结束战斗入口默认折叠');
    const dialogClick = label => {
        const node = find(app.panel, n => n.tag === 'button' && n.textContent === label);
        assert.ok(node);
        node.listeners.click();
    };
    click('结束战斗');
    assert.equal(context.chatMetadata[META_KEY], battle);
    assert.equal(saves(), beforeSave);
    assert.equal(document.activeElement.textContent, '继续战斗');
    dialogClick('继续战斗');
    assert.equal(context.chatMetadata[META_KEY], battle);
    assert.equal(app.endBattleDialog, null);
    click('结束战斗');
    const newerBattle = structuredClone(battle);
    context.chatMetadata[META_KEY] = newerBattle;
    dialogClick('确认结束战斗');
    assert.equal(context.chatMetadata[META_KEY], newerBattle);
    click('结束战斗');
    dialogClick('确认结束战斗');
    assert.equal(context.chatMetadata[META_KEY], undefined);
    assert.ok(root.textContent.includes('开始战斗'));
});

test('战斗中的世界书绑定从当前资料卡同步，变更时保存并更新注入', t => {
    const { app, context, click, saves, injections } = setup(t);
    click('开始战斗');
    const battle = context.chatMetadata[META_KEY];
    const def = app.data.units.find(d => battle.units.some(u => u.defId === d.id));
    const units = battle.units.filter(u => u.defId === def.id);
    for (const binding of [{ book: '人物', label: '骑士', keys: ['罗兰'] }, null]) {
        def.wb = binding;
        const beforeSave = saves(), beforeInjection = injections();
        app.render();
        for (const unit of units) {
            assert.deepEqual(unit.wb, binding);
            if (binding) assert.notEqual(unit.wb, binding);
        }
        assert.equal(saves(), beforeSave + 1);
        assert.equal(injections(), beforeInjection + 1);
        app.render();
        assert.equal(saves(), beforeSave + 1, 'unchanged bindings do not save again');
        assert.equal(injections(), beforeInjection + 1);
    }
});

test('战斗小窗只显示地图和操作，仍可行动、结束回合并恢复完整界面', async t => {
    const { app, root, context, click } = setup(t);
    app.settings.ui.layout = 'compact';
    app.settings.send.autoOnEndTurn = false;
    app.render();
    assert.ok(!root.textContent.includes('资料卡：'));
    click('开始战斗');
    const battle = context.chatMetadata[META_KEY];
    assert.ok(!root.textContent.includes('待发送的行动'));
    assert.ok(!find(root, n => n.tag === 'textarea'));
    const board = find(root, n => n.classes.has('tsrpg-board'));
    assert.equal(board.children.length, battle.w * battle.h);
    const unit = battle.units.find(u => u.side === 'player');
    const cell = board.children[unit.y * battle.w + unit.x];
    board.listeners.mousedown({ button: 0, target: { closest: () => cell } });
    click('原地行动');
    click('待机');
    assert.equal(unit.acted, true);
    for (const other of battle.units.filter(u => u.side === 'player' && !u.acted && !u.object)) {
        const nextBoard = find(root, n => n.classes.has('tsrpg-board'));
        const nextCell = nextBoard.children[other.y * battle.w + other.x];
        nextBoard.listeners.mousedown({ button: 0, target: { closest: () => nextCell } });
        click('原地行动');
        click('待机');
    }
    await click('结束回合');
    assert.equal(battle.turn, 2);
    assert.ok(find(root, n => n.classes.has('tsrpg-board')));
    app.settings.ui.layout = 'float';
    app.render();
    assert.ok(root.textContent.includes('待发送的行动'));
    assert.ok(find(root, n => n.tag === 'textarea'));
    assert.equal(context.chatMetadata[META_KEY], battle);
});

for (const layout of ['float', 'compact']) {
    test(`${layout}：移动与行动过程锁定操作，播放完成后恢复操作`, async t => {
        const { app, root, context, click } = setup(t);
        app.settings.ui.layout = layout;
        app.settings.ui.animate = true;
        const renderedFrames = [];
        const render = app.render.bind(app);
        app.render = () => {
            render();
            if (app.bs.playback) renderedFrames.push(app.bs.playback.label);
        };
        t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
        app.render();
        click('开始战斗');
        const b = context.chatMetadata[META_KEY];
        const hero = b.units.find(u => u.side === 'player');
        let board = find(root, n => n.classes.has('tsrpg-board'));
        board.listeners.mousedown({ button: 0, target: { closest: () => board.children[hero.y * b.w + hero.x] } });
        const oldX = hero.x;
        board = find(root, n => n.classes.has('tsrpg-board'));
        board.listeners.mousedown({ button: 0, target: { closest: () => board.children[hero.y * b.w + oldX + 1] } });
        assert.ok(app.bs.busy);
        assert.ok(find(root, n => n.tag === 'button' && n.textContent === '跳过过程'));
        assert.ok(!find(root, n => n.classes.has('tsrpg-actions')));
        const undo = find(root, n => n.tag === 'button' && n.textContent === '撤销');
        assert.ok(undo.disabled);
        for (let i = 0; i < 100 && app.bs.busy; i++) await Promise.resolve();
        assert.equal(app.bs.busy, null);
        assert.equal(app.bs.playback, null);
        assert.equal(hero.x, oldX + 1);
        await click('待机');
        assert.ok(renderedFrames.some(label => label.includes('移动')));
        assert.ok(renderedFrames.some(label => label.includes('待机')));
        assert.equal(hero.acted, true);
        assert.equal(app.bs.busy, null);
    });

    test(`${layout}：仅结算回合跳过LLM指挥官和自动发送`, async t => {
        const { app, root, context, click } = setup(t);
        let llmCalls = 0;
        context.generateQuietPrompt = async () => { llmCalls++; return ''; };
        app.settings.ui.layout = layout;
        app.settings.llm.commander.enemy = true;
        app.settings.llm.commander.ally = true;
        app.settings.send.autoOnEndTurn = true;
        app.render();
        click('开始战斗');
        const b = context.chatMetadata[META_KEY];
        for (const u of b.units.filter(u => u.side === 'player')) u.acted = true;
        await click('仅结算回合');
        assert.equal(b.turn, 2);
        assert.ok(b.pending.length > 2, '行动保留待稍后发送');
        assert.equal(app.panel.children.length, 0, '不打开自动发送预览');
        assert.equal(app.bs.busy, null);
        assert.equal(llmCalls, 0, '不能调用后台LLM指挥官');
        assert.ok(find(root, n => n.classes.has('tsrpg-board')));
    });

    test(`${layout}：手动修改HP、放置单位并撤销，资料卡不变`, t => {
        const { app, root, context, click } = setup(t);
        app.settings.ui.layout = layout;
        app.render();
        click('开始战斗');
        const dataBefore = structuredClone(app.data);
        click('手动修改');
        let b = context.chatMetadata[META_KEY];
        const hero = b.units.find(u => u.side === 'player');
        const board = find(root, n => n.classes.has('tsrpg-board'));
        const cell = board.children[hero.y * b.w + hero.x];
        board.listeners.mousedown({ button: 0, target: { closest: () => cell } });
        const hpField = find(root, n => n.tag === 'label' && n.children[0]?.textContent === '当前HP');
        const hpInput = find(hpField, n => n.tag === 'input');
        hpInput.listeners.change({ target: { value: String(hero.hp - 5) } });
        assert.equal(hero.hp, hero.maxHp - 5);
        click('撤销');
        b = context.chatMetadata[META_KEY];
        assert.equal(b.units.find(u => u.uid === hero.uid).hp, hero.maxHp);
        const panel = find(root, n => n.classes.has('tsrpg-manual-panel'));
        find(panel, n => n.tag === 'select').listeners.change({ target: { value: 'spawn' } });
        const newBoard = find(root, n => n.classes.has('tsrpg-board'));
        const count = b.units.length;
        newBoard.listeners.mousedown({ button: 0, target: { closest: () => newBoard.children[0] } });
        assert.equal(b.units.length, count + 1);
        click('退出手动修改');
        assert.equal(app.bs.cheat, false);
        assert.deepEqual(app.data, dataBefore);
    });
}

test('玩家移动到致命熔岩后立即判负，不能继续选择攻击或技能', t => {
    const { app, root, context, click } = setup(t);
    click('开始战斗');
    const b = context.chatMetadata[META_KEY];
    const hero = b.units.find(u => u.side === 'player');
    for (const other of b.units.filter(u => u.side === 'player' && u !== hero)) other.hp = 0;
    hero.hp = 1;
    const targetIndex = hero.y * b.w + hero.x + 1;
    b.tiles[targetIndex] = 'lava';
    let board = find(root, n => n.classes.has('tsrpg-board'));
    board.listeners.mousedown({ button: 0, target: { closest: () => board.children[hero.y * b.w + hero.x] } });
    board = find(root, n => n.classes.has('tsrpg-board'));
    board.listeners.mousedown({ button: 0, target: { closest: () => board.children[targetIndex] } });
    assert.equal(hero.hp, 0);
    assert.equal(b.result, 'defeat');
    assert.equal(app.bs.mode, 'idle');
    assert.equal(app.bs.sel, null);
    assert.ok(b.pending.some(e => e.type === 'result' && e.result === 'defeat'));
    assert.ok(!find(root, n => n.classes.has('tsrpg-actions')));
});

function setupExchange(t, range = 1) {
    const env = setup(t);
    const { app, click } = env;
    app.data.units = [
        makeUnit({ id: 'p', name: '勇者', hp: 100, atk: 20, def: 0, mov: 0 }),
        makeUnit({ id: 'e', name: '兽人', side: 'enemy', hp: 100, atk: 20, def: 0, mov: 0, ai: 'stationary', rangeMin: range, rangeMax: range }),
    ];
    app.data.maps = [makeMap({ w: 4, h: 1, placements: [{ unitId: 'p', x: 0, y: 0 }, { unitId: 'e', x: range, y: 0 }] })];
    Object.assign(app.data.rules, { hitEnabled: false, variance: 0, counter: true });
    app.settings.send.autoOnEndTurn = false;
    app.render(); click('开始战斗');
    return env;
}

async function waitForReaction(app) {
    for (let i = 0; i < 100 && !app.bs.cancelReaction; i++) await Promise.resolve();
    assert.ok(app.bs.cancelReaction, '敌方攻击应暂停等待玩家');
}

test('选择攻击对象只显示预览，取消不结算，确认战斗后才扣血和反击', async t => {
    const { app, root, context, click } = setupExchange(t);
    const b = context.chatMetadata[META_KEY], [hero, foe] = b.units;
    let board = find(root, n => n.classes.has('tsrpg-board'));
    board.listeners.mousedown({ button: 0, target: { closest: () => board.children[0] } });
    click('原地行动');
    board = find(root, n => n.classes.has('tsrpg-board'));
    board.listeners.mousedown({ button: 0, target: { closest: () => board.children[1] } });
    assert.equal(hero.hp, 100); assert.equal(foe.hp, 100);
    assert.ok(root.textContent.includes('期望伤害'));
    assert.ok(root.textContent.includes('存活后反击'));
    click('取消');
    assert.equal(hero.hp, 100); assert.equal(foe.hp, 100);
    board = find(root, n => n.classes.has('tsrpg-board'));
    board.listeners.mousedown({ button: 0, target: { closest: () => board.children[1] } });
    await click('战斗');
    assert.equal(hero.hp, 80); assert.equal(foe.hp, 80);
    assert.equal(app.bs.engagement, null);
});

test('战斗并生成描写只发送本次交战，先前待发送行动保留', async t => {
    const { app, root, context, click } = setupExchange(t);
    const sent = [];
    const input = { value: '', dispatchEvent() {} };
    document.getElementById = id => id === 'send_textarea' ? input : id === 'send_but' ? { click: () => sent.push(input.value) } : null;
    const b = context.chatMetadata[META_KEY];
    const oldPending = [...b.pending];
    let board = find(root, n => n.classes.has('tsrpg-board'));
    board.listeners.mousedown({ button: 0, target: { closest: () => board.children[0] } });
    click('原地行动');
    board = find(root, n => n.classes.has('tsrpg-board'));
    board.listeners.mousedown({ button: 0, target: { closest: () => board.children[1] } });
    await click('战斗并生成描写');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /勇者.*兽人.*20 点伤害.*反击/);
    assert.ok(!sent[0].includes('任务：'));
    assert.deepEqual(b.pending, oldPending);
    assert.equal(b.log.length, 1);
});

for (const response of ['反击', '防御']) {
    test(`敌方普通攻击暂停，玩家选择${response}后继续结算`, async t => {
        const { app, context, click } = setupExchange(t);
        app.settings.ui.confirmDefense = true;
        const b = context.chatMetadata[META_KEY], [hero, foe] = b.units;
        hero.acted = true;
        const run = click('仅结算回合');
        await waitForReaction(app);
        assert.equal(hero.hp, 100); assert.equal(foe.hp, 100);
        assert.ok(app.panel.classes.has('tsrpg-reaction-open'));
        assert.ok(find(app.panel, n => n.tag === 'button' && n.textContent === '反击'));
        find(app.panel, n => n.tag === 'button' && n.textContent === response).listeners.click();
        await run;
        assert.equal(hero.hp, response === '防御' ? 90 : 80);
        assert.equal(foe.hp, response === '防御' ? 100 : 80);
        assert.equal(b.turn, 2);
        assert.equal(app.bs.busy, null);
        assert.equal(app.bs.cancelReaction, null);
        assert.equal(app.panel.children.length, 0);
        assert.ok(!app.panel.classes.has('tsrpg-reaction-open'));
    });
}

test('射程不够时只有防御；取消回合恢复原有战场，不留下等待状态', async t => {
    const { app, context, click } = setupExchange(t, 2);
    app.settings.ui.confirmDefense = true;
    const b = context.chatMetadata[META_KEY];
    b.units[0].acted = true;
    const before = structuredClone(b);
    const run = click('仅结算回合');
    await waitForReaction(app);
    assert.ok(!find(app.panel, n => n.tag === 'button' && n.textContent === '反击'));
    find(app.panel, n => n.tag === 'button' && n.textContent === '取消本次回合').listeners.click();
    await run;
    const restored = context.chatMetadata[META_KEY];
    assert.equal(restored.turn, before.turn);
    assert.deepEqual(restored.units, before.units);
    assert.equal(app.bs.busy, null);
    assert.equal(app.bs.cancelReaction, null);
});

test('等待防御时切换聊天不能结算到新战场', async t => {
    const { app, context, click } = setupExchange(t);
    app.settings.ui.confirmDefense = true;
    context.chatMetadata[META_KEY].units[0].acted = true;
    const run = click('仅结算回合');
    await waitForReaction(app);
    app.bs.cancelReaction();
    app.bs = newBattleUi();
    const next = { active: true, units: [], turn: 99 };
    context.chatId = 'next-chat'; context.chatMetadata = { [META_KEY]: next };
    app.render = () => {};
    await run;
    assert.equal(context.chatMetadata[META_KEY], next);
    assert.equal(next.turn, 99);
    assert.equal(app.bs.busy, null);
});

test('资料卡多选绑定可同时关联多个角色，解除一个不会影响其他角色', async t => {
    const { app, root, context } = setup(t);
    context.characters.push({ name: '第二角色', avatar: 'second.png' });
    let syncs = 0;
    app.save = () => {};
    app.syncProfileWithChat = async () => { syncs++; };
    app.render = () => renderProfilesTab(app, root);
    app.render();
    const picker = () => find(root, n => n.classes.has('tsrpg-multi-bindings'));
    const check = name => find(picker(), n => n.tag === 'label' && n.textContent.includes(name)).children[0];
    assert.equal(check('测试角色').checked, true);
    assert.equal(check('第二角色').checked, false);
    await check('第二角色').listeners.change({ target: { checked: true } });
    assert.equal(app.settings.bindings['char:test.png'], app.data.id);
    assert.equal(app.settings.bindings['char:second.png'], app.data.id);
    assert.equal(syncs, 0, '绑定另一个角色不切换当前编辑卡');
    await check('测试角色').listeners.change({ target: { checked: false } });
    assert.equal(app.settings.bindings['char:test.png'], undefined);
    assert.equal(app.settings.bindings['char:second.png'], app.data.id);
    assert.equal(syncs, 1);
});

test('单位特质先选择再编辑，模板与自定义组合保存且切换单位不串选', async t => {
    const { app, root } = setup(t);
    window.addEventListener = () => {};
    const { renderUnitsTab, newEditorUi } = await import('../src/ui/editors.js');
    app.ed = newEditorUi();
    let saves = 0;
    app.save = () => { saves++; };
    app.render = () => renderUnitsTab(app, root);
    app.render();
    const click = label => {
        const n = find(root, n => n.tag === 'button' && n.textContent === label);
        assert.ok(n, label); n.listeners.click();
    };
    const u = app.data.units.find(u => u.id === app.ed.unitId);
    click('强壮');
    assert.equal(u.traits[0].name, '强壮');
    assert.deepEqual(u.traits[0].effects, [{ type: 'atk_up', value: 10 }]);
    click('再生');
    assert.equal(app.ed.traitId, u.traits[1].id);
    click('添加特质效果');
    assert.equal(u.traits[1].effects.length, 2);
    assert.equal(find(root, n => n.tag === 'input' && n.value === '强壮'), undefined, '不会展开所有特质表单');
    const picker = find(root, n => n.tag === 'select' && n.value === app.ed.traitId);
    picker.listeners.change({ target: { value: u.traits[0].id } });
    assert.equal(app.ed.traitId, u.traits[0].id);
    click('删除特质');
    assert.equal(u.traits.length, 1);
    assert.equal(app.ed.traitId, u.traits[0].id);
    click('创建新特质');
    assert.equal(u.traits[1].name, '新特质');
    assert.deepEqual(u.traits[1].effects, []);
    app.ed.unitId = app.data.units.find(other => other.id !== u.id).id;
    app.render();
    assert.equal(app.ed.traitId, null);
    assert.ok(saves >= 5);
    await new Promise(resolve => setTimeout(resolve, 0));
});

for (const reaction of ['反击', '防御']) {
    test(`受击可选择${reaction}并生成描写，仅发送本回合选中的交战`, async t => {
        const { app, context, click } = setupExchange(t);
        app.settings.ui.confirmDefense = true;
        app.settings.send.autoOnEndTurn = true;
        const sent = [], input = { value: '', dispatchEvent() {} };
        document.getElementById = id => id === 'send_textarea' ? input : id === 'send_but' ? { click: () => sent.push(input.value) } : null;
        const b = context.chatMetadata[META_KEY], oldPending = [...b.pending];
        b.units[0].acted = true;
        const run = click('结束回合');
        await waitForReaction(app);
        find(app.panel, n => n.tag === 'button' && n.textContent === `${reaction}并生成描写`).listeners.click();
        await run;
        assert.equal(sent.length, 1);
        assert.match(sent[0], /兽人.*勇者/);
        assert.equal(sent[0].includes('任务：'), false);
        assert.equal(b.units[0].hp, reaction === '反击' ? 80 : 90);
        assert.equal(b.pending.some(e => e.type === 'attack'), false);
        assert.ok(oldPending.every(e => b.pending.includes(e)));
        assert.ok(b.pending.some(e => e.type === 'phase'));
        assert.equal(app.bs.busy, null);
    });
}

test('无法反击时仍可防御并生成描写，取消不发送', async t => {
    const { app, context, click } = setupExchange(t, 2);
    app.settings.ui.confirmDefense = true;
    context.chatMetadata[META_KEY].units[0].acted = true;
    const run = click('仅结算回合');
    await waitForReaction(app);
    assert.ok(find(app.panel, n => n.tag === 'button' && n.textContent === '防御并生成描写'));
    assert.ok(!find(app.panel, n => n.tag === 'button' && n.textContent === '反击并生成描写'));
    find(app.panel, n => n.tag === 'button' && n.textContent === '取消本次回合').listeners.click();
    await run;
    assert.equal(context.chatMetadata[META_KEY].units[0].hp, 100);
});

for (const layout of ['float', 'compact']) {
    test(`${layout}暂停保留战场，旧操作不生效，重新打开可继续`, async t => {
        const { dispatch, setBattlePaused } = await import('../src/ui/battle.js');
        const { app, context, root, click } = setupExchange(t);
        const b = context.chatMetadata[META_KEY];
        app.settings.ui.layout = layout; app.render();
        const end = find(root, n => n.tag === 'button' && n.textContent === '仅结算回合');
        const before = structuredClone(b);
        click('暂停战斗');
        assert.equal(b.paused, true);
        assert.deepEqual(b.units, before.units);
        assert.deepEqual(b.pending, before.pending);
        assert.equal(b.turn, before.turn);
        assert.ok(!find(root, n => n.tag === 'button' && n.textContent === '结束回合'));
        await end.listeners.click();
        dispatch(app, b);
        assert.equal(b.turn, before.turn);
        app.bs = newBattleUi(); app.render(); // 模拟关闭后重新打开
        assert.ok(root.textContent.includes('战斗已暂停'));
        click('继续战斗');
        assert.equal(b.paused, false);
        assert.deepEqual(b.units, before.units);
        app.bs.busy = '等待反应';
        setBattlePaused(app, b, true);
        assert.equal(b.paused, false, '中途不允许损坏尚未完成的回合');
    });
}
