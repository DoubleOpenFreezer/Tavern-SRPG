import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, META_KEY } from '../src/defaults.js';
import { newBattleUi, renderBattleTab } from '../src/ui/battle.js';

// Minimal DOM for exercising the real battle renderer and its event handlers.
class TestNode {
    constructor(tag = '', text = '') {
        this.tag = tag;
        this.text = text;
        this.children = [];
        this.style = {};
        this.dataset = {};
        this.listeners = {};
        this.classes = new Set();
        this.classList = { add: name => this.classes.add(name) };
    }
    get firstChild() { return this.children[0]; }
    get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
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
