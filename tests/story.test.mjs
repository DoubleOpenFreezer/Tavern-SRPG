import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleProfile, makeMap } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { extractStory, storyGuide, buildGrowthPrompt, normalizeGrowth, applyGrowth, revertGrowth, growthLines, growthIds, growthSummary } from '../src/story.js';
import { buildDesignPrompt, parseDesignReply } from '../src/designer.js';

test('剧情标记：解析成长与关卡，从正文中移除；没有标记时原样返回', () => {
    const text = '艾琳合上古书，掌心浮现出星光。\n\n<srpg-story>\ngrow 艾琳 | 学会了「星落」\n成长 骑士｜换上了圣剑\nbattle 废弃神殿 | 暗影教团伏击\n乱写的一行\n</srpg-story>';
    const { clean, items } = extractStory(text);
    assert.equal(clean, '艾琳合上古书，掌心浮现出星光。');
    assert.deepEqual(items, [
        { kind: 'grow', subject: '艾琳', text: '学会了「星落」' },
        { kind: 'grow', subject: '骑士', text: '换上了圣剑' },
        { kind: 'battle', subject: '废弃神殿', text: '暗影教团伏击' },
    ]);
    assert.deepEqual(extractStory('普通的回复'), { clean: '普通的回复', items: [] });
});

test('注入说明：列出我方角色；战斗进行中不提示开战标记', () => {
    const p = sampleProfile();
    const guide = storyGuide(p);
    assert.match(guide, /grow <角色名>/);
    assert.match(guide, /battle <地点>/);
    assert.match(guide, /当前我方角色：骑士、法师、斥候/);
    assert.doesNotMatch(storyGuide(p, { inBattle: true }), /battle <地点>/);
    assert.doesNotMatch(storyGuide(p, { battle: false }), /battle <地点>/);
});

const reply = JSON.stringify({
    updates: [
        { unit: '法师', reason: '在图书馆学会星落', changes: { matk: 15, mdef: 9, flying: false, antiAir: true },
            addSkills: [{ name: '星落', kind: 'magical', power: 140, rangeMin: 2, rangeMax: 4, attackMode: 'mapArea', radius: 1, cooldown: 3, antiAir: true, desc: '召唤流星' },
                { name: '治愈', kind: 'support', target: 'ally', rangeMax: 3, effects: [{ type: 'heal', value: 150 }] }],
            removeSkills: ['守护之光', '不存在的技能'], addTraits: [{ name: '星辰眷顾', effects: [{ type: 'matk_up', value: 10 }] }] },
        { unit: '罗兰', changes: { atk: 14, weaponName: '圣剑' }, editSkills: [{ name: '冲锋', power: 180 }] },
        { unit: '哥布林', changes: { atk: 9 } },
        { unit: '不存在的人', changes: { atk: 99 } },
    ],
    newUnits: [{ name: '莉娜', side: 'ally', hp: 24, atk: 9, agi: 10, skills: [{ name: '连射', power: 80, rangeMax: 3, antiAir: true }] }],
});

function profileWithAlias() {
    const p = sampleProfile();
    p.units.find(u => u.name === '骑士').aliases = '罗兰';
    return p;
}

test('成长：数值、技能（新增 / 同名升级 / 修改 / 移除）、特质、别名查找、无变化与未知单位的处理', () => {
    const p = profileWithAlias();
    const g = normalizeGrowth(parseDesignReply(reply), p);
    assert.equal(growthSummary(g), '2 个单位成长 · 1 个新单位');
    const [mage, knight] = g.updates;
    assert.deepEqual(mage.patch, { matk: 15, antiAir: true }, 'MDEF 与飞行没有变化，不写入');
    assert.equal(mage.addSkills.length, 1, '「治愈」已存在，视为升级');
    assert.equal(mage.editSkills[0].after.name, '治愈');
    assert.equal(mage.editSkills[0].after.effects[0].value, 150);
    assert.equal(mage.editSkills[0].id, 'sk_sample_heal', '升级保留原技能 id');
    assert.deepEqual(mage.removeSkills.map(s => s.name), ['守护之光']);
    assert.equal(knight.unitName, '骑士', '用别名找到单位');
    assert.equal(knight.editSkills[0].after.power, 180);
    assert.equal(knight.editSkills[0].after.sureHit, true, '只修改给出的字段');
    assert.ok(g.warnings.some(w => w.includes('不存在的技能')));
    assert.ok(g.warnings.some(w => w.includes('不存在的人')));
    assert.ok(g.warnings.some(w => w.includes('哥布林') && w.includes('相同')), '数值没变的修改被忽略');
    const lines = growthLines(mage, p.units.find(u => u.name === '法师'), p.unitTypes);
    assert.ok(lines.includes('MATK 13 → 15'));
    assert.ok(lines.some(l => l.startsWith('学会技能【星落】') && l.includes('可对空')));
    assert.ok(lines.includes('失去技能【守护之光】'));
    assert.equal(g.design.units[0].name, '莉娜');
});

test('应用成长：更新资料卡和进行中战斗里的同一单位，撤销后资料卡恢复', () => {
    const p = profileWithAlias();
    const b = E.createBattle(makeMap({ w: 6, h: 4, placements: [{ unitId: 'unit_sample_mage', x: 0, y: 0 }, { unitId: 'unit_sample_knight', x: 1, y: 0 }] }), p.units, p.terrains);
    const bm = b.units[0];
    bm.hp = 10;
    const g = normalizeGrowth(parseDesignReply(JSON.stringify({ updates: [{ unit: '法师', changes: { hp: 30, matk: 15 }, addSkills: [{ name: '星落', kind: 'magical', power: 140, uses: 2 }] }] })), p);
    const before = structuredClone(p.units.find(u => u.name === '法师'));
    const res = applyGrowth(p, g, new Set(growthIds(g)), b);
    const mage = p.units.find(u => u.name === '法师');
    assert.equal(mage.hp, 30); assert.equal(mage.matk, 15);
    assert.ok(mage.skills.some(s => s.name === '星落'));
    assert.equal(res.synced, 1);
    assert.equal(bm.maxHp, 30); assert.equal(bm.hp, 18, '最大 HP 提高 8，当前 HP 也恢复 8');
    assert.equal(bm.matk, 15);
    const star = bm.skills.find(s => s.name === '星落');
    assert.deepEqual([star.usesLeft, star.cdLeft], [2, 0]);
    assert.ok(res.lines.some(l => l.startsWith('法师：MATK 13 → 15')));
    assert.equal(revertGrowth(p, res.before), 1);
    assert.deepEqual(p.units.find(u => u.name === '法师'), before);
});

test('只应用选中的项；新同伴加入资料卡', () => {
    const p = profileWithAlias();
    const g = normalizeGrowth(parseDesignReply(reply), p);
    const n = p.units.length;
    const res = applyGrowth(p, g, new Set([g.design.units[0].id]));
    assert.equal(p.units.length, n + 1);
    assert.equal(p.units.find(u => u.name === '法师').matk, 13, '未选中的成长不应用');
    assert.ok(res.lines.includes('莉娜加入了友军'));
});

test('成长提示词包含剧情、事件、可修改单位的完整资料；默认不含敌人。剧情关卡任务带上聊天记录', () => {
    const p = sampleProfile();
    const { system, user } = buildGrowthPrompt(p, { hint: '法师学会了星落', chat: '法师：我感受到了星辰的力量。' });
    assert.match(system, /成长要克制/);
    assert.match(system, /"editSkills"/);
    assert.match(user, /星辰的力量/);
    assert.match(user, /法师学会了星落/);
    assert.match(user, /"name":"法师".*"skills":\[/);
    assert.doesNotMatch(user, /"name":"哥布林"/);
    assert.match(buildGrowthPrompt(p, { scope: 'all' }).user, /"name":"哥布林"/);
    const story = buildDesignPrompt(p, { task: 'story', request: '废弃神殿：暗影教团伏击', chat: '骑士：小心，有埋伏！' });
    assert.match(story.user, /最近的剧情[\s\S]*小心，有埋伏/);
    assert.match(story.user, /根据「最近的剧情」设计/);
});
