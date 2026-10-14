import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatDefaults as defaultSettings, makeMap, makeUnit, makeWave } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { composeMessage, missionText } from '../src/narrator.js';

const S = defaultSettings();
const rules = { ...S.rules, variance: 0 };
const fixed = () => 0.5;

/** 10x5 全平原的小地图 */
function arena(placements, over = {}) {
    return makeMap({ w: 10, h: 5, tiles: new Array(50).fill('plain'), placements, ...over });
}

const hero = makeUnit({ id: 'hero', name: '勇者', side: 'player', hp: 30, atk: 10, def: 5, mov: 4 });
const weak = makeUnit({ id: 'weak', name: '村民', side: 'player', hp: 5, atk: 1, def: 0, mov: 4 });
const orc = makeUnit({ id: 'orc', name: '兽人', side: 'enemy', hp: 20, atk: 9, def: 2, mov: 4 });
const gate = makeUnit({ id: 'gate', name: '城门', side: 'player', kind: 'object', keyTarget: true, hp: 30, def: 0, mdef: 0 });
const crystal = makeUnit({ id: 'crystal', name: '水晶', side: 'enemy', kind: 'object', keyTarget: true, hp: 10, def: 0, mdef: 0 });
const defs = [hero, weak, orc, gate, crystal];

test('歼灭战：敌人攻击最近的角色，而不是更弱的远处角色', () => {
    const map = arena([
        { unitId: 'hero', x: 3, y: 2 },
        { unitId: 'weak', x: 0, y: 0 },
        { unitId: 'orc', x: 6, y: 2 },
    ]);
    const b = E.createBattle(map, defs, S.terrains);
    const orcU = b.units[2];
    const ev = E.aiAct(b, orcU, rules, fixed);
    const atk = ev.find(e => e.type === 'attack');
    assert.equal(atk.target.name, '勇者');
});

test('守城战：敌人无视附近的角色，直奔城门', () => {
    const map = arena([
        { unitId: 'gate', x: 0, y: 2 },
        { unitId: 'hero', x: 6, y: 0 }, // 就在兽人旁边，但不挡路
        { unitId: 'orc', x: 7, y: 2 },
    ], { mission: { type: 'defend', turns: 3 } });
    const b = E.createBattle(map, defs, S.terrains);
    const orcU = b.units[2];
    const ev = E.aiAct(b, orcU, rules, fixed);
    assert.ok(ev.some(e => e.type === 'move'));
    assert.ok(!ev.some(e => e.type === 'attack' && e.target.name === '勇者'), '不应攻击勇者');
    assert.ok(orcU.x < 7, '向城门方向前进');
    // 下一回合兽人够得到城门
    orcU.acted = false;
    const ev2 = E.aiAct(b, orcU, rules, fixed);
    assert.equal(ev2.find(e => e.type === 'attack')?.target.name, '城门');
});

test('守城战：城门被摧毁即失败；坚守到回合数即胜利', () => {
    const map = arena([{ unitId: 'gate', x: 0, y: 2 }, { unitId: 'hero', x: 0, y: 0 }, { unitId: 'orc', x: 9, y: 4 }],
        { mission: { type: 'defend', turns: 2 } });
    const b = E.createBattle(map, defs, S.terrains);
    b.units[0].hp = 0;
    assert.equal(E.checkResult(b).result, 'defeat');

    const b2 = E.createBattle(map, defs, S.terrains);
    b2.units[2].ai = 'stationary';
    E.endPlayerPhase(b2, rules, fixed);
    assert.equal(b2.result, null);
    const ev = E.endPlayerPhase(b2, rules, fixed);
    assert.equal(b2.result, 'victory');
    assert.match(ev.at(-1).reason, /坚守了 2 回合/);
});

test('守城战多个关键目标：被摧毁数量达到设定才失败，超过数量按全部计，默认任意一个即失败', () => {
    const civ = makeUnit({ id: 'civ', name: '平民', side: 'ally', keyTarget: true, hp: 10 });
    const all = [...defs, civ];
    const place = [{ unitId: 'gate', x: 0, y: 2 }, { unitId: 'civ', x: 0, y: 4 }, { unitId: 'civ', x: 1, y: 4 }, { unitId: 'hero', x: 0, y: 0 }, { unitId: 'orc', x: 9, y: 4 }];
    const make = mission => E.createBattle(arena(place, { mission: { type: 'defend', turns: 3, ...mission } }), all, S.terrains);

    const strict = make({});
    assert.equal(E.defendLossLimit(strict), 1);
    assert.match(composeMessage(strict, [{ type: 'mission', turn: 1, text: missionText(strict) }], S), /任意一个被摧毁即失败/);
    strict.units[1].hp = 0;
    assert.equal(E.checkResult(strict).result, 'defeat');

    const b = make({ lossLimit: 2 });
    const [gateU, civ1, civ2] = b.units;
    civ1.hp = 0;
    assert.equal(E.checkResult(b), null, '损失1个仍可继续');
    assert.match(missionText(b), /2 个被摧毁才算失败（已摧毁 1\/3）/);
    gateU.hp = 0;
    const r = E.checkResult(b);
    assert.equal(r.result, 'defeat');
    assert.match(r.reason, /守卫目标「城门」「平民A」被摧毁/);
    assert.match(r.reason, /2\/3，达到失败条件/);

    const allLost = make({ lossLimit: 99 });
    assert.equal(E.defendLossLimit(allLost), 3);
    assert.match(missionText(allLost), /全部被摧毁才算失败/);
    allLost.units.slice(0, 2).forEach(u => { u.hp = 0; });
    assert.equal(E.checkResult(allLost), null);
    allLost.units[2].hp = 0;
    assert.equal(E.checkResult(allLost).result, 'defeat');
});

test('进攻战：摧毁全部敌方关键目标即胜利，即使敌人还活着', () => {
    const map = arena([{ unitId: 'hero', x: 4, y: 2 }, { unitId: 'crystal', x: 5, y: 2 }, { unitId: 'orc', x: 9, y: 4 }],
        { mission: { type: 'assault', turns: 0 } });
    const b = E.createBattle(map, defs, S.terrains);
    const [h, c] = b.units;
    const ev = E.commit(b, E.doAttack(b, h, c, rules, fixed));
    assert.equal(c.hp, 0);
    assert.equal(ev.at(-1).type, 'result');
    assert.equal(b.result, 'victory');
    assert.equal(ev[0].counter, null, '建筑物不会反击');
});

test('增援：按首次回合、间隔、次数出现，出生点被占时就近出现', () => {
    const map = arena([{ unitId: 'hero', x: 0, y: 0 }, { unitId: 'orc', x: 9, y: 2 }], {
        reinforcements: [makeWave({ id: 'w1', unitId: 'orc', x: 9, y: 2, count: 2, startTurn: 1, every: 2, times: 2 })],
    });
    const b = E.createBattle(map, defs, S.terrains);
    b.units[1].ai = 'stationary';
    const spawned = () => b.units.filter(u => u.name.includes('增援')).length;
    E.endPlayerPhase(b, rules, fixed); // 第1回合结束：第一波
    assert.equal(spawned(), 2);
    assert.ok(b.units.filter(u => u.name.includes('增援')).every(u => !(u.x === 9 && u.y === 2)), '出生点被占，就近出现');
    for (const u of b.units) if (u.side === 'enemy') u.ai = 'stationary';
    E.endPlayerPhase(b, rules, fixed); // 第2回合：无
    assert.equal(spawned(), 2);
    for (const u of b.units) if (u.side === 'enemy') u.ai = 'stationary';
    E.endPlayerPhase(b, rules, fixed); // 第3回合：第二波
    assert.equal(spawned(), 4);
    for (const u of b.units) if (u.side === 'enemy') u.ai = 'stationary';
    E.endPlayerPhase(b, rules, fixed); E.endPlayerPhase(b, rules, fixed); // 次数用完
    assert.equal(spawned(), 4);
    assert.equal(E.wavesRemaining(b), false);
});

test('歼灭战：还有增援没来时，清空场上敌人不算胜利', () => {
    const map = arena([{ unitId: 'hero', x: 4, y: 2 }, { unitId: 'orc', x: 5, y: 2 }], {
        reinforcements: [makeWave({ id: 'w', unitId: 'orc', x: 9, y: 4, startTurn: 2 })],
    });
    const b = E.createBattle(map, defs, S.terrains);
    b.units[1].hp = 1;
    E.commit(b, E.doAttack(b, b.units[0], b.units[1], rules, fixed));
    assert.equal(b.result, null);
    const msg = composeMessage(b, E.endPlayerPhase(b, rules, fixed).concat(E.endPlayerPhase(b, rules, fixed)), S);
    assert.match(msg, /敌方增援从 \(10,5\)平原 出现：兽人·增援1/);
});

test('validateMission 提示缺少关键目标和无限增援', () => {
    const d = arena([{ unitId: 'hero', x: 0, y: 0 }, { unitId: 'orc', x: 9, y: 4 }], { mission: { type: 'defend', turns: 3 } });
    assert.match(E.validateMission(d, defs).join(), /关键目标/);
    const a = arena([{ unitId: 'hero', x: 0, y: 0 }, { unitId: 'orc', x: 9, y: 4 }], {
        reinforcements: [makeWave({ unitId: 'orc', every: 1, times: 0 })],
    });
    assert.match(E.validateMission(a, defs).join(), /无限/);
    for (const m of S.maps) assert.deepEqual(E.validateMission(m, S.units), [], m.name);
});
