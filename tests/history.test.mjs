import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatDefaults as defaultSettings } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { recordCheckpoint, rewindBattle, MAX_CHECKPOINTS } from '../src/history.js';
import { composeMessage } from '../src/narrator.js';

const S = defaultSettings();

function battle() {
    const b = E.createBattle(S.maps[0], S.units, S.terrains);
    recordCheckpoint(b, { chat: 3, kind: 'start' });
    return b;
}

test('回溯到开战存档：战场恢复，存档列表保留并记录回溯前的进度', () => {
    const b = battle();
    const knight = b.units.find(u => u.side === 'player');
    E.doMove(b, knight, knight.x, knight.y);
    knight.hp = 1;
    b.pending.push(...E.endPlayerPhase(b, S.rules, () => 0.5));
    recordCheckpoint(b, { chat: 5 });
    b.llm = { proposals: null, applied: { snapshot: structuredClone(b) } };
    const before = structuredClone(b);

    const next = rewindBattle(b, b.history[0].id, { chat: 8 });
    assert.deepEqual(b, before, '原战斗不变');
    assert.equal(next.turn, 1);
    assert.equal(next.phase, 'player');
    assert.equal(next.units.find(u => u.uid === knight.uid).hp, knight.maxHp);
    assert.equal(next.units.find(u => u.uid === knight.uid).acted, false);
    assert.equal(next.llm, undefined);
    assert.deepEqual(next.history.map(c => c.kind), ['start', 'turn', 'rewind']);
    assert.equal(next.history[2].chat, 8);
    assert.ok(!('history' in next.history[2].state), '存档不嵌套存档');
    assert.equal(next.pending.at(-1).type, 'rewind');
    assert.match(composeMessage(next, next.pending, S), /【需要描写的行动】[\s\S]*战场回到第 1 回合我方阶段开始时的状态（原进度为第 2 回合）/);

    // 回溯前的进度保留了当时的待发送行动，可以回去
    const back = rewindBattle(next, next.history[2].id);
    assert.equal(back.turn, 2);
    assert.equal(back.units.find(u => u.uid === knight.uid).hp, 1);
    assert.ok(back.pending.some(e => e.type === 'phase'));
    assert.ok(back.pending.at(-1).restore);
});

test('回合存档：战斗结束或非我方阶段不记录；超出上限保留开战存档', () => {
    const b = battle();
    b.result = 'victory';
    assert.equal(recordCheckpoint(b), null);
    b.result = null; b.phase = 'enemy';
    assert.equal(recordCheckpoint(b), null);
    b.phase = 'player';
    for (let i = 2; i < MAX_CHECKPOINTS + 10; i++) { b.turn = i; recordCheckpoint(b); }
    assert.equal(b.history.length, MAX_CHECKPOINTS);
    assert.equal(b.history[0].kind, 'start');
    assert.equal(b.history.at(-1).turn, MAX_CHECKPOINTS + 9);
    assert.equal(new Set(b.history.map(c => c.id)).size, MAX_CHECKPOINTS);
    assert.equal(rewindBattle(b, 'missing'), null);
});
