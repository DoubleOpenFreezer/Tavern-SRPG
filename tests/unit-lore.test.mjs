import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleProfile, makeTrait } from '../src/defaults.js';
import { unitLoreList, unitLoreText, buildUnitLore, loreTriggered, UNIT_LORE_HEADER } from '../src/unit-lore.js';

function profile() {
    const p = sampleProfile();
    const knight = p.units.find(u => u.name === '骑士');
    Object.assign(knight, { aliases: '罗兰, {{user}}', weaponName: '圣剑', wb: { book: '人物', uid: 1, label: '罗兰', keys: ['白银骑士'] } });
    knight.traits = [makeTrait({ name: '强壮', desc: '体格强健', effects: [{ type: 'atk_up', value: 10 }] })];
    p.unitTypes = [{ id: 't1', name: '坦克', desc: '重甲前排', vs: {} }];
    knight.typeId = 't1';
    return p;
}

test('单位资料文字：属性、兵种、武器、特质、技能、别名；不包含备注', () => {
    const p = profile();
    const knight = p.units.find(u => u.name === '骑士');
    knight.notes = '只有我知道的秘密';
    const text = unitLoreText(knight, p);
    assert.match(text, /^【骑士】（又名：罗兰、\{\{user\}\}）我方｜兵种：坦克（重甲前排）/);
    assert.match(text, /HP 32 ATK 12 .*韧性 2 视野 4｜物理攻击 射程1｜武器：圣剑/);
    assert.match(text, /特质【强壮】ATK\+10%：体格强健/);
    assert.match(text, /技能：冲锋（物理 160%.*）——全力冲刺后的重击/);
    assert.doesNotMatch(text, /秘密/);
    assert.doesNotMatch(unitLoreText(knight, p, { skills: false }), /技能：/);
    assert.match(unitLoreText(p.units.find(u => u.name === '城门'), p), /建筑.*\n  HP 60 DEF 8 MDEF 6｜不会行动/);
});

test('条目范围与关键词：默认只含我方与友军，关键词包含名字、别名（替换宏）和绑定的世界书关键词', () => {
    const p = profile();
    const subst = s => s.replaceAll('{{user}}', '阿尔');
    const list = unitLoreList(p, { subst });
    assert.ok(list.every(e => !['哥布林', '哥布林弓手'].includes(e.name)));
    const knight = list.find(e => e.name === '骑士');
    assert.deepEqual(knight.keys, ['骑士', '罗兰', '阿尔', '白银骑士']);
    assert.match(knight.text, /又名：罗兰、阿尔/);
    assert.ok(unitLoreList(p, { scope: 'all' }).some(e => e.name === '哥布林'));
    assert.ok(!unitLoreList(p, { exclude: new Set([p.units[0].id]) }).some(e => e.id === p.units[0].id));
});

test('按关键词触发：提到才附上；单个字的别名不会误触发；总是附上模式包含全部', () => {
    const p = profile();
    const list = unitLoreList(p);
    const r = buildUnitLore(list, { scanText: '罗兰拔出了剑，看向远方的法师。' });
    assert.deepEqual(r.used, ['骑士', '法师']);
    assert.ok(r.text.startsWith(UNIT_LORE_HEADER));
    assert.deepEqual(buildUnitLore(list, { scanText: '今天天气不错' }), { text: '', used: [] });
    assert.ok(!loreTriggered({ name: '艾琳', keys: ['艾琳', '琳'] }, '琳琅满目'), '单字别名不触发');
    assert.ok(loreTriggered({ name: '琳', keys: ['琳'] }, '琳笑了'), '名字本身是单字时可以触发');
    assert.equal(buildUnitLore(list, { trigger: 'constant' }).used.length, list.length);
});
