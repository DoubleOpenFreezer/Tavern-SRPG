import assert from 'node:assert/strict';
import { test } from 'node:test';
import { battleMessageTitle, foldBattleMessage } from '../src/ui/chat-messages.js';
import { composeMessage } from '../src/narrator.js';
import { defaultSettings } from '../src/defaults.js';

const report = '自定义提示词\n〔战场：河畔之战｜第 1–2 回合〕\n\n【需要描写的行动】\n· 骑士待机。';

test('只识别用户战斗报告，自定义提示词和关闭行动描写也支持', () => {
    assert.equal(battleMessageTitle({ is_user: true, mes: report }), '河畔之战 · 第 1–2 回合');
    assert.equal(battleMessageTitle({ is_user: false, mes: report }), null);
    assert.equal(battleMessageTitle({ is_user: true, is_system: true, mes: report }), null);
    assert.equal(battleMessageTitle({ is_user: true, mes: '普通聊天文字' }), null);
    assert.equal(battleMessageTitle({ is_user: true, mes: '〔战场：河畔之战｜第 1 回合〕\n聊一下地图' }), null);
    const settings = defaultSettings();
    settings.send.header = '';
    const mes = composeMessage({ mapName: '<地图>', turn: 3 }, [], settings);
    assert.equal(battleMessageTitle({ is_user: true, mes }), '<地图> · 第 3 回合');
});

// Small DOM fixture checks node movement, rather than replacing text with HTML.
class Element {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.className = ''; }
    append(...nodes) {
        for (const node of nodes) {
            if (node.parent) node.parent.childNodes.splice(node.parent.childNodes.indexOf(node), 1);
            node.parent = this;
            this.childNodes.push(node);
        }
    }
    querySelector(selector) {
        for (const child of this.childNodes) {
            if (selector.includes('textarea') && child.tagName === 'textarea') return child;
            if (selector.includes('.tsrpg-chat-report') && child.className === 'tsrpg-chat-report') return child;
            const found = child.querySelector(selector);
            if (found) return found;
        }
        return null;
    }
}

test('默认折叠，保留原消息和格式化节点，重复渲染不嵌套且编辑器不被包裹', t => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    globalThis.document = { createElement: tag => new Element(tag) };
    t.after(() => {
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
        else delete globalThis.document;
    });
    const message = { is_user: true, mes: report };
    const before = structuredClone(message);
    const text = new Element('div');
    const paragraph = new Element('p');
    paragraph.textContent = '原始格式化内容';
    text.append(paragraph);
    foldBattleMessage(text, message);
    const details = text.childNodes[0];
    assert.equal(details.tagName, 'details');
    assert.ok(!details.open);
    assert.equal(details.childNodes[0].tagName, 'summary');
    assert.ok(details.childNodes[0].childNodes[0].textContent.includes('第 1–2 回合'));
    assert.equal(details.childNodes[1].childNodes[0], paragraph);
    assert.deepEqual(message, before);
    details.open = true;
    foldBattleMessage(text, message);
    assert.equal(text.childNodes.length, 1);
    assert.equal(details.open, true, '重复渲染保留展开状态');
    const editing = new Element('div');
    editing.append(new Element('textarea'));
    foldBattleMessage(editing, message);
    assert.equal(editing.childNodes[0].tagName, 'textarea');
    const rerendered = new Element('p');
    text.childNodes = [];
    text.append(rerendered);
    foldBattleMessage(text, message);
    assert.equal(text.childNodes[0].childNodes[1].childNodes[0], rerendered);
});
