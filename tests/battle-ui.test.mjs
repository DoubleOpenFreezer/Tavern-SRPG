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
    append(...children) { this.children.push(...children); }
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
