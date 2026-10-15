import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleProfile } from '../src/defaults.js';
import { buildDesignPrompt, parseDesignReply, normalizeDesign, applyDesign, designSummary } from '../src/designer.js';
import * as E from '../src/engine.js';

const reply = `<think>先想想世界观</think>
好的，下面是设计：
\`\`\`json
{
  "unitTypes": [
    { "name": "狼骑", "desc": "骑狼的哥布林", "color": "#795548", "vs": [{ "target": "法师", "dmg": 140, "tough": 2 }, { "target": "不存在", "dmg": 200 }] },
    { "name": "法师", "desc": "施法者", "vs": {} }
  ],
  "terrains": [{ "name": "沼泽", "symbol": "~~", "color": "teal", "moveCost": 3, "avoid": -10, "conceal": 1, "desc": "泥泞的沼泽" }],
  "units": [
    { "name": "狼骑兵", "side": "enemy", "type": "狼骑", "hp": 24, "atk": 11, "mov": 7, "ai": "aggressive", "wbEntry": "狼骑兵",
      "skills": [{ "name": "撕咬", "kind": "physical", "power": 140, "effects": [{ "type": "中毒", "value": 10, "turns": 2 }, { "type": "teleport_bad" }] }],
      "traits": [{ "name": "迅捷", "effects": [{ "type": "agi_up", "value": 3, "flat": true }] }] },
    { "name": "骑士", "side": "player", "hp": 30 },
    { "name": "图腾", "side": "enemy", "kind": "object", "keyTarget": true, "hp": 40, "def": 5, "atk": 50 }
  ],
  "maps": [{
    "name": "沼泽伏击", "desc": "雾气弥漫的沼泽", "w": 6, "h": 4,
    "legend": { ".": "平原", "~": "沼泽", "#": "城墙", "?": "火山" },
    "rows": ["..~~..", ".#~~..", "..~~.?", "......"],
    "placements": [{ "unit": "骑士", "x": 1, "y": 1 }, { "unit": "法师", "x": 2, "y": 2 }, { "unit": "狼骑兵", "x": 6, "y": 4 }, { "unit": "图腾", "x": 6, "y": 1 }, { "unit": "幽灵", "x": 3, "y": 3 }],
    "mission": { "type": "assault", "turns": 8 },
    "fog": { "enabled": true },
    "reinforcements": [{ "unit": "狼骑兵", "x": 6, "y": 2, "count": 2, "startTurn": 3 }]
  }],
}
\`\`\``;

test('解析回复：去掉思考过程和代码块，容忍尾逗号；截断时给出明确提示', () => {
    const data = parseDesignReply(reply);
    assert.equal(data.maps[0].name, '沼泽伏击');
    assert.deepEqual(parseDesignReply('[{"name":"兵"}]'), { units: [{ name: '兵' }] });
    assert.throws(() => parseDesignReply('{"units": [{"name": "兵"'), /截断/);
    assert.throws(() => parseDesignReply('没有内容'), /没有找到 JSON/);
});

test('转换设计：名字引用、去重改名、数值校验、预设效果、世界书绑定、地图网格与放置', () => {
    const profile = sampleProfile();
    const entries = [{ book: '哥布林设定', uid: 3, label: '狼骑兵', keys: ['狼骑'] }];
    const d = normalizeDesign(parseDesignReply(reply), profile, { entries });
    assert.equal(designSummary(d), '兵种 2 · 地形 1 · 单位 3 · 地图 1');

    const [wolfType, mageType] = d.unitTypes;
    assert.deepEqual(wolfType.vs[mageType.id], { dmg: 140, hit: 0, tough: 2 }, '兵种可以引用同一批新建的兵种');
    assert.ok(d.warnings.some(w => w.includes('不存在')));

    const swamp = d.terrains[0];
    assert.equal(swamp.symbol, '~');
    assert.equal(swamp.color, '#a1887f', '无效颜色用默认值');
    assert.equal(swamp.conceal, 1);

    const [wolf, knight, totem] = d.units;
    assert.equal(wolf.typeId, wolfType.id);
    assert.deepEqual(wolf.wb, { book: '哥布林设定', uid: 3, label: '狼骑兵', keys: ['狼骑'] });
    assert.deepEqual(wolf.skills[0].effects, [{ type: 'poison', value: 10, turns: 2 }], '中文效果名可识别，未知效果丢弃');
    assert.deepEqual(wolf.traits[0].effects, [{ type: 'agi_up', value: 3, flat: true }]);
    assert.equal(knight.name, '骑士（2）', '与已有单位重名时改名');
    assert.equal(totem.atk, 0, '建筑没有攻击力');
    assert.equal(totem.vision, 0);

    const map = d.maps[0];
    assert.equal(map.w, 6); assert.equal(map.h, 4);
    assert.equal(map.tiles[2], swamp.id);
    assert.equal(map.tiles[1 * 6 + 1], 'wall');
    assert.equal(map.tiles[2 * 6 + 5], 'plain', '未知地形替换为平原');
    assert.ok(d.warnings.some(w => w.includes('火山')));
    assert.ok(d.warnings.some(w => w.includes('幽灵')));
    assert.deepEqual(map.placements[0], { unitId: knight.id, x: 0, y: 0 }, '「骑士」优先匹配本次新建的单位');
    assert.equal(map.placements.length, 4, '「法师」引用资料卡已有的单位，「幽灵」不存在被跳过');
    assert.equal(map.placements[1].unitId, 'unit_sample_mage');
    assert.deepEqual(map.mission, { type: 'assault', turns: 8 });
    assert.deepEqual(map.fog, { enabled: true, ai: true });
    assert.equal(map.reinforcements[0].unitId, wolf.id);
});

test('放置在不能站立的格子上时挪到附近空位', () => {
    const profile = sampleProfile();
    const d = normalizeDesign({ maps: [{ name: '墙', legend: { '#': '城墙', '.': '平原' }, rows: ['#..', '...', '...'],
        placements: [{ unit: '骑士', x: 1, y: 1 }, { unit: '法师', x: 2, y: 1 }, { unit: '哥布林', x: 3, y: 3 }] }] }, profile);
    const [p1, p2] = d.maps[0].placements;
    assert.notDeepEqual([p1.x, p1.y], [0, 0]);
    assert.notDeepEqual([p1.x, p1.y], [p2.x, p2.y]);
    assert.ok(d.warnings.some(w => w.includes('挪到了')));
    const b = E.createBattle(d.maps[0], profile.units, profile.terrains);
    assert.equal(b.units.length, 3, '可以直接开战');
});

test('导入：选中地图时自动带上它用到的新单位、地形和兵种；未导入的克制对象被去掉', () => {
    const profile = sampleProfile();
    const before = { units: profile.units.length, terrains: profile.terrains.length };
    const d = normalizeDesign(parseDesignReply(reply), profile);
    const { added, auto } = applyDesign(profile, d, new Set([d.maps[0].id]));
    assert.equal(added.maps, 1);
    assert.equal(profile.terrains.length, before.terrains + 1);
    assert.equal(profile.units.length, before.units + 3);
    assert.ok(auto.includes('狼骑兵') && auto.includes('沼泽') && auto.includes('狼骑'));
    const wolfType = profile.unitTypes.find(t => t.name === '狼骑');
    assert.deepEqual(Object.keys(wolfType.vs), [], '「法师」兵种没有导入，克制关系去掉');
    const m = profile.maps.at(-1);
    assert.deepEqual(E.validateMission(m, profile.units), []);
});

test('提示词包含世界书、已有内容、效果预设和任务要求；修改时附上上一版', () => {
    const profile = sampleProfile();
    const { system, user } = buildDesignPrompt(profile, { task: 'map', request: '一场夜战', size: { w: 14, h: 9 }, allowNew: false, lore: '【哥布林设定｜狼骑兵】骑狼的哥布林', character: '名字：艾琳' });
    assert.match(system, /世界观/);
    assert.match(system, /poison（中毒/);
    assert.match(user, /骑狼的哥布林/);
    assert.match(user, /名字：艾琳/);
    assert.match(user, /- 骑士｜我方/);
    assert.match(user, /宽 14 × 高 9/);
    assert.match(user, /只能使用已有的单位和地形/);
    assert.match(user, /一场夜战/);
    const again = buildDesignPrompt(profile, { task: 'units', previous: '{"units":[]}', feedback: '更强一点' });
    assert.match(again.user, /上一版设计[\s\S]*更强一点/);
});

test('「导出全部」不包含 AI 设计助手的设置（API Key）', async () => {
    const { allPayload } = await import('../src/profiles.js');
    const { defaultSettings } = await import('../src/defaults.js');
    const s = defaultSettings();
    s.designer.custom.key = 'sk-secret';
    assert.doesNotMatch(JSON.stringify(allPayload(s)), /sk-secret/);
});
