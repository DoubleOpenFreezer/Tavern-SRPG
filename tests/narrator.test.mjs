import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatDefaults as defaultSettings } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { composeMessage } from '../src/narrator.js';
import { buildBattleContext, defaultContextOptions } from '../src/context.js';

const S = defaultSettings();

function battleWithEvents() {
    const b = E.createBattle(S.maps[0], S.units, S.terrains);
    const [knight, , gob] = b.units;
    const ev = [];
    ev.push(E.doMove(b, knight, 5, 3));
    gob.x = 7; gob.y = 3; // 桥对岸
    knight.x = 6; knight.y = 3;
    ev.push(E.doAttack(b, knight, gob, S.rules, () => 0.5));
    ev.push(...E.endPlayerPhase(b, S.rules, () => 0.5));
    return { b, ev };
}

test('关闭“描写移动”时，移动进入背景信息', () => {
    const { b, ev } = battleWithEvents();
    const s = structuredClone(S);
    s.narration.move = false;
    const msg = composeMessage(b, ev, s, '重点描写骑士');
    const [need, bg] = msg.split('【背景信息');
    assert.ok(!/移动到/.test(need), 'move not in narrate section');
    assert.ok(/移动到/.test(bg), 'move in brief section');
    assert.ok(msg.includes('【用户补充要求】\n重点描写骑士'));
});

test('关闭“描写敌人行动”且不简要告知时，敌方行动完全省略', () => {
    const { b, ev } = battleWithEvents();
    const s = structuredClone(S);
    s.narration.enemy = false;
    s.narration.brief = false;
    const msg = composeMessage(b, ev, s);
    assert.ok(!/哥布林.{0,4} 对 /.test(msg));
    assert.ok(/骑士 对 哥布林A/.test(msg));
});

test('绑定世界书的单位带上关键词，状态摘要包含 HP 与地形', () => {
    const units = structuredClone(S.units);
    units[0].wb = { book: '书', uid: 0, label: '骑士·罗兰', keys: ['罗兰'] };
    const b = E.createBattle(S.maps[0], units, S.terrains);
    const ev = E.doWait(b, b.units[0]);
    assert.ok(composeMessage(b, [ev], S).includes('骑士〈罗兰〉'));
    const st = buildBattleContext(b, defaultContextOptions(), { u0: '罗兰是骑士团长' });
    assert.match(st, /\[P1\] 骑士（又名：罗兰）｜我方｜位于 \(2,4\) 平原｜HP 32\/32/);
    assert.ok(st.includes('- 骑士：罗兰是骑士团长'));
});
