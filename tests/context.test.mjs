import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { composeMessage } from '../src/narrator.js';
import { buildBattleContext, defaultContextOptions, unitLabels } from '../src/context.js';

const S = defaultSettings();

function sample() {
    const units = structuredClone(S.units);
    units.find(u => u.id === 'unit_sample_knight').aliases = '罗兰, {{user}}';
    return E.createBattle(S.maps[0], units, S.terrains);
}

test('地图网格：坐标说明、单位编号与地形字符', () => {
    const b = sample();
    const text = buildBattleContext(b);
    assert.match(text, /## 地图（12×8）/);
    assert.match(text, /x 是列，从左到右 1–12；y 是行，从上到下 1–8/);
    const rows = text.split('\n').filter(l => /^\s+\d+ /.test(l) && !l.trim().startsWith('1 2'));
    assert.equal(rows.length, 8);
    // 第 4 行：骑士 P1 在 x=2，桥 = 在 x=7，哥布林A E1 在 x=10
    assert.deepEqual(rows[3].trim().split(' ').slice(1), ['·', 'P1', '·', '·', '·', '·', '=', '·', '·', 'E1', '·', '·']);
    assert.match(text, /- ≈ 河流（步行不可通过，飞行可越过）/);
    assert.match(text, /- ♣ 森林（移动消耗2，减伤20%，闪避\+15%）/);
});

test('单位详情：别名、属性变化、状态、技能冷却、最近的敌人', () => {
    const b = sample();
    const [knight, mage] = b.units;
    knight.statuses.push({ type: 'def_up', value: 30, turns: 2, srcSide: 'player' });
    knight.skills[0].cdLeft = 2;
    knight.hp = 20;
    const text = buildBattleContext(b);
    assert.match(text, /\[P1\] 骑士（又名：罗兰、\{\{user\}\}）｜我方｜位于 \(2,4\) 平原｜HP 20\/32/);
    assert.match(text, /ATK 12 MATK 2 DEF 9→12 MDEF 3 AGI 4 MOV 5｜物理攻击 射程1/);
    assert.match(text, /状态：防御力上升30%（增益，剩 2 回合）/);
    assert.match(text, /冲锋〔冷却中，第 3 回合可用〕/);
    assert.match(text, /挑衅〔可用〕辅助·自身/);
    assert.match(text, /最近的敌人：哥布林A\[E1\] 在东 8 格/);
    assert.match(text, /本回合：尚未行动/);
    assert.ok(text.includes(`[P2] ${mage.name}`));
});

test('可以只输出部分内容，选项可以关闭某些部分', () => {
    const b = sample();
    const units = buildBattleContext(b, { ...defaultContextOptions(), sections: ['units'] });
    assert.ok(!units.includes('## 地图'));
    assert.ok(units.includes('## 单位'));
    const noMap = buildBattleContext(b, { ...defaultContextOptions(), map: false, skills: false });
    assert.ok(!noMap.includes('## 地图'));
    assert.ok(noMap.includes('## 地形'));
    assert.ok(!noMap.includes('技能：'));
});

test('倒下的单位、建筑、关键目标都会标出', () => {
    const b = E.createBattle(S.maps[1], S.units, S.terrains);
    b.units.find(u => u.name === '哥布林A').hp = 0;
    const text = buildBattleContext(b);
    assert.match(text, /城门｜我方｜建筑｜★关键目标（保护它）/);
    assert.match(text, /已倒下：哥布林A（敌方）/);
    assert.match(text, /增援出现点：\(12,5\)/);
    assert.deepEqual(Object.values(unitLabels(b)).slice(0, 4), ['P1', 'P2', 'P3', 'E1']);
});

test('描写消息使用故事中的名字', () => {
    const b = sample();
    const ev = E.doWait(b, b.units[0]);
    assert.match(composeMessage(b, [ev], S), /骑士〈罗兰〉 在平原原地待命/);
});
