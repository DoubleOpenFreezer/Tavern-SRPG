// 默认数据：地形、示例单位、示例地图、插件设置
export const MODULE_NAME = 'tavern_srpg';
export const META_KEY = 'tavern_srpg';

export function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export const DEFAULT_TERRAINS = [
    { id: 'plain', name: '平原', symbol: '', color: '#9ccc65', moveCost: 1, passable: true, flyable: true, avoid: 0, defBonus: 0, healPct: 0, desc: '开阔的草地，视野良好' },
    { id: 'forest', name: '森林', symbol: '♣', color: '#2e7d32', moveCost: 2, passable: true, flyable: true, avoid: 15, defBonus: 20, healPct: 0, desc: '茂密的树林，便于隐蔽，提高闪避并减少受到的伤害' },
    { id: 'mountain', name: '山地', symbol: '▲', color: '#8d6e63', moveCost: 3, passable: true, flyable: true, avoid: 20, defBonus: 30, healPct: 0, desc: '崎岖的山岭，难以行进但易守难攻' },
    { id: 'river', name: '河流', symbol: '≈', color: '#42a5f5', moveCost: 1, passable: false, flyable: true, avoid: 0, defBonus: 0, healPct: 0, desc: '湍急的河水，步行无法通过，飞行单位可越过' },
    { id: 'canyon', name: '峡谷', symbol: '▼', color: '#5d4037', moveCost: 1, passable: false, flyable: true, avoid: 0, defBonus: 0, healPct: 0, desc: '深不见底的裂谷，只有飞行单位能跨越' },
    { id: 'bridge', name: '桥梁', symbol: '=', color: '#bcaaa4', moveCost: 1, passable: true, flyable: true, avoid: 0, defBonus: 0, healPct: 0, desc: '横跨河流的木桥，兵家必争之地' },
    { id: 'desert', name: '沙地', symbol: '∴', color: '#ffe082', moveCost: 2, passable: true, flyable: true, avoid: -10, defBonus: 0, healPct: 0, desc: '松软的沙地，拖慢行军，难以闪避' },
    { id: 'fort', name: '堡垒', symbol: '⌂', color: '#b0bec5', moveCost: 1, passable: true, flyable: true, avoid: 10, defBonus: 30, healPct: 10, desc: '坚固的据点，回合开始时恢复10%生命' },
    { id: 'wall', name: '城墙', symbol: '█', color: '#455a64', moveCost: 1, passable: false, flyable: false, avoid: 0, defBonus: 0, healPct: 0, desc: '高耸的石墙，任何单位都无法通过' },
];

export function makeUnit(over = {}) {
    return {
        id: uid('unit'),
        name: '新单位',
        kind: 'unit', // unit: 角色 ; object: 建筑物 / 目标物（不会行动）
        keyTarget: false, // 关键目标：守城战中需要保护，进攻战中需要破坏
        side: 'player',
        icon: '',
        color: '',
        hp: 20, atk: 8, matk: 4, def: 4, mdef: 3, agi: 5, mov: 5,
        rangeMin: 1, rangeMax: 1,
        atkType: 'physical',
        flying: false,
        ai: 'aggressive',
        skills: [],
        wb: null,
        aliases: '', // 故事中的名字 / 别名，逗号分隔，可以写 {{user}} {{char}}
        notes: '',
        ...over,
    };
}

export function makeSkill(over = {}) {
    return {
        id: uid('sk'),
        name: '新技能',
        kind: 'physical', // physical 物理伤害 | magical 魔法伤害 | support 辅助
        target: 'enemy', // 辅助技能的作用对象：ally 友方（含自己）| enemy 敌方 | self 仅自己
        power: 150, // 伤害技能的百分比倍率
        rangeMin: 1, rangeMax: 1,
        radius: 0, // 0 = 单体，>0 = 以目标格为中心的范围
        cooldown: 0, // 冷却回合：N = 每 N 回合可用一次，0 = 无冷却
        hitMod: 0, // 命中修正（±%）
        sureHit: false, // 必中
        uses: 0, // 0 = 无限
        effects: [], // 预设效果 [{ type, value, turns }]，type 见 engine.js 的 EFFECTS
        desc: '',
        ...over,
    };
}

export function makeMap(over = {}) {
    const w = over.w || 10, h = over.h || 8;
    return {
        id: uid('map'),
        name: '新地图',
        w, h,
        tiles: new Array(w * h).fill('plain'),
        desc: '',
        placements: [],
        mission: { type: 'annihilate', turns: 0 }, // annihilate 歼灭 / defend 守城 / assault 进攻；turns 见设置说明
        reinforcements: [],
        ...over,
    };
}

export function makeWave(over = {}) {
    return {
        id: uid('wave'),
        unitId: null,
        x: 0, y: 0,
        count: 1, // 每次出现的数量
        startTurn: 2, // 第几回合（敌方阶段结束时）出现
        every: 0, // 每隔几回合再次出现，0＝只出现一次
        times: 0, // 最多出现几次，0＝无限（every>0 时）
        ...over,
    };
}

function sampleData() {
    const knight = makeUnit({ id: 'unit_sample_knight', name: '骑士', side: 'player', icon: '骑', hp: 32, atk: 12, matk: 2, def: 9, mdef: 3, agi: 4, mov: 5,
        skills: [
            makeSkill({ id: 'sk_sample_charge', name: '冲锋', kind: 'physical', power: 160, cooldown: 2, sureHit: true, desc: '全力冲刺后的重击' }),
            makeSkill({ id: 'sk_sample_provoke', name: '挑衅', kind: 'support', target: 'self', rangeMin: 0, rangeMax: 0, cooldown: 3,
                effects: [{ type: 'taunt', value: 0, turns: 1 }, { type: 'def_up', value: 20, turns: 1 }], desc: '高举盾牌大声挑衅，吸引所有敌人的攻击' }),
        ] });
    const mage = makeUnit({ id: 'unit_sample_mage', name: '法师', side: 'player', icon: '法', hp: 22, atk: 3, matk: 13, def: 3, mdef: 9, agi: 6, mov: 4, rangeMin: 1, rangeMax: 2, atkType: 'magical',
        skills: [
            makeSkill({ id: 'sk_sample_fireball', name: '火球术', kind: 'magical', power: 130, rangeMin: 1, rangeMax: 3, radius: 1, cooldown: 2, hitMod: 10, desc: '在目标处炸开的火球' }),
            makeSkill({ id: 'sk_sample_heal', name: '治愈', kind: 'support', target: 'ally', rangeMin: 0, rangeMax: 2, cooldown: 1,
                effects: [{ type: 'heal', value: 120, turns: 0 }], desc: '温暖的治愈之光' }),
            makeSkill({ id: 'sk_sample_guard', name: '守护之光', kind: 'support', target: 'ally', rangeMin: 0, rangeMax: 2, radius: 1, cooldown: 3,
                effects: [{ type: 'def_up', value: 30, turns: 2 }, { type: 'mdef_up', value: 30, turns: 2 }], desc: '笼罩同伴的金色光幕' }),
        ] });
    const goblin = makeUnit({ id: 'unit_sample_goblin', name: '哥布林', side: 'enemy', icon: '哥', hp: 18, atk: 9, matk: 0, def: 3, mdef: 1, agi: 8, mov: 5 });
    const archer = makeUnit({ id: 'unit_sample_archer', name: '哥布林弓手', side: 'enemy', icon: '弓', hp: 15, atk: 8, matk: 0, def: 2, mdef: 2, agi: 9, mov: 4, rangeMin: 2, rangeMax: 3, ai: 'defensive',
        skills: [makeSkill({ id: 'sk_sample_poison', name: '毒箭', kind: 'physical', power: 80, rangeMin: 2, rangeMax: 3, cooldown: 3,
            effects: [{ type: 'poison', value: 10, turns: 2 }], desc: '箭头涂着绿色的毒液' })] });

    const w = 12, h = 8;
    const tiles = new Array(w * h).fill('plain');
    const set = (x, y, t) => { tiles[y * w + x] = t; };
    for (let y = 0; y < h; y++) set(6, y, 'river');
    set(6, 3, 'bridge'); set(6, 4, 'bridge');
    [[2, 1], [3, 1], [2, 2], [8, 6], [9, 6], [9, 5]].forEach(([x, y]) => set(x, y, 'forest'));
    [[10, 0], [11, 0], [11, 1]].forEach(([x, y]) => set(x, y, 'mountain'));
    set(10, 4, 'fort');
    const map = makeMap({ id: 'map_sample', name: '河畔之战', w, h, tiles, desc: '一条河流将平原一分为二，唯一的木桥位于中央。敌人占据了东岸的堡垒。',
        placements: [
            { unitId: knight.id, x: 1, y: 3 },
            { unitId: mage.id, x: 1, y: 5 },
            { unitId: goblin.id, x: 9, y: 3 },
            { unitId: goblin.id, x: 8, y: 5 },
            { unitId: archer.id, x: 10, y: 4 },
        ] });

    // 守城战示例：守住城门 5 回合，敌人每 2 回合从东边增援
    const gate = makeUnit({ id: 'unit_sample_gate', name: '城门', kind: 'object', keyTarget: true, side: 'player', icon: '门', color: '#8d6e63', hp: 60, def: 8, mdef: 6, mov: 0 });
    const dw = 12, dh = 9;
    const dtiles = new Array(dw * dh).fill('plain');
    const dset = (x, y, t) => { dtiles[y * dw + x] = t; };
    for (let y = 0; y < dh; y++) if (y !== 4) dset(2, y, 'wall');
    dset(2, 4, 'fort');
    [[6, 1], [7, 1], [6, 7], [7, 7], [8, 6]].forEach(([x, y]) => dset(x, y, 'forest'));
    const defend = makeMap({ id: 'map_sample_defend', name: '死守城门', w: dw, h: dh, tiles: dtiles,
        desc: '城墙由北向南贯穿战场，唯一的城门是敌人的目标。只要城门不倒，援军就会在第 5 回合后赶到。',
        mission: { type: 'defend', turns: 5 },
        placements: [
            { unitId: gate.id, x: 2, y: 4 },
            { unitId: knight.id, x: 3, y: 4 },
            { unitId: mage.id, x: 1, y: 4 },
            { unitId: goblin.id, x: 9, y: 3 },
            { unitId: goblin.id, x: 10, y: 5 },
        ],
        reinforcements: [makeWave({ id: 'wave_sample_def', unitId: goblin.id, x: 11, y: 4, count: 2, startTurn: 1, every: 2, times: 0 })] });

    // 进攻战示例：破坏敌阵后方的魔法水晶，敌人第 2 回合起每 3 回合增援，最多 2 次
    const crystal = makeUnit({ id: 'unit_sample_crystal', name: '魔法水晶', kind: 'object', keyTarget: true, side: 'enemy', icon: '晶', color: '#7e57c2', hp: 40, def: 6, mdef: 12, mov: 0 });
    const aw = 12, ah = 8;
    const atiles = new Array(aw * ah).fill('plain');
    const aset = (x, y, t) => { atiles[y * aw + x] = t; };
    [[4, 0], [4, 1], [4, 2], [4, 5], [4, 6], [4, 7]].forEach(([x, y]) => aset(x, y, 'canyon'));
    [[7, 2], [7, 5], [8, 2], [8, 5]].forEach(([x, y]) => aset(x, y, 'mountain'));
    aset(10, 3, 'fort'); aset(10, 4, 'fort');
    const assault = makeMap({ id: 'map_sample_assault', name: '破坏水晶', w: aw, h: ah, tiles: atiles,
        desc: '峡谷中间只有一条通路，魔法水晶被安置在敌阵后方的堡垒里，源源不断地召唤着援兵。',
        mission: { type: 'assault', turns: 0 },
        placements: [
            { unitId: knight.id, x: 1, y: 3 },
            { unitId: mage.id, x: 1, y: 4 },
            { unitId: crystal.id, x: 10, y: 3 },
            { unitId: archer.id, x: 9, y: 4 },
            { unitId: goblin.id, x: 6, y: 3 },
        ],
        reinforcements: [makeWave({ id: 'wave_sample_asl', unitId: goblin.id, x: 11, y: 4, count: 1, startTurn: 2, every: 3, times: 2 })] });

    return { units: [knight, mage, goblin, archer, gate, crystal], maps: [map, defend, assault] };
}

export const DEFAULT_HEADER = '【SRPG 战斗系统】以下行动结果已由战斗系统计算完成，请据此生动地描写战斗过程。严格遵循给出的数值与结果（伤害、击败、位置），不要自行改变或追加判定。';

export function defaultRules() {
    return {
        formula: 'subtract', // subtract: 攻-防 ; ratio: 攻²/(攻+防)
        variance: 10, // 伤害浮动 ±%
        counter: true, // 普通攻击是否触发反击
        minDamage: 1,
        hitEnabled: true, // 命中判定
        baseHit: 90, // 基础命中率 %
        agiFactor: 3, // 每 1 点敏捷差影响的命中率 %
    };
}

/** 资料卡：一套完整的游戏内容（单位、地形、地图、战斗规则），可以绑定到角色卡 */
export function makeProfile(over = {}) {
    return {
        id: uid('profile'),
        name: '新资料卡',
        desc: '',
        terrains: structuredClone(DEFAULT_TERRAINS),
        units: [],
        maps: [],
        rules: defaultRules(),
        updatedAt: Date.now(),
        ...over,
    };
}

export const SAMPLE_PROFILE_ID = 'profile_sample';

export function sampleProfile() {
    const sample = sampleData();
    return makeProfile({
        id: SAMPLE_PROFILE_ID,
        name: '示例：哥布林战役',
        desc: '内置示例：河畔之战（歼灭）、死守城门（守城）、破坏水晶（进攻）。',
        units: sample.units,
        maps: sample.maps,
    });
}

/** 资料卡里的内容字段 */
export const PROFILE_KEYS = ['terrains', 'units', 'maps', 'rules'];

export function defaultSettings() {
    return {
        version: 4,
        profiles: [sampleProfile()],
        activeProfile: SAMPLE_PROFILE_ID,
        defaultProfile: SAMPLE_PROFILE_ID, // 没有绑定资料卡的聊天使用它
        bindings: {}, // 'char:<头像文件名>' | 'group:<群组 id>' -> 资料卡 id
        declinedEmbeds: {}, // 不再询问导入的角色卡内置资料卡
        narration: {
            move: true, // 描写移动
            attack: true, // 描写普通攻击
            skill: true, // 描写技能
            enemy: true, // 描写敌方行动
            ally: true, // 描写友军行动
            turn: true, // 描写回合切换/地形恢复
            reinforce: true, // 描写增援出现
            status: true, // 描写状态变化（中毒 / 持续恢复 / 眩晕 / 效果结束）
            brief: true, // 不描写的行动以简要背景告知
        },
        send: {
            mode: 'preview', // send: 直接发送 ; fill: 填入输入框 ; preview: 预览后发送
            autoOnEndTurn: true, // 结束回合时自动整理消息
            header: DEFAULT_HEADER,
            includeInput: true, // 把主输入框已有的文字作为补充要求一起发送
        },
        inject: {
            enabled: true,
            position: 'chat', // chat: 聊天记录中（按深度）; before: 主提示词之前; after: 主提示词之后
            depth: 2,
            role: 'system', // system | user | assistant
            includeWb: false, // 把绑定的世界书条目内容一并注入
            // 注入哪些部分
            map: true, legend: true, stats: true, skills: true, nearest: true,
            logLines: 0, // 附带最近 N 条战斗记录
        },
        tool: {
            enabled: false, // 注册函数调用工具，让 LLM 主动查询战场（需要支持函数调用的 Chat Completion 接口）
        },
        llm: {
            // ① 剧情指令：LLM 在回复末尾写 <srpg> 指令块修改战场
            commands: false,
            mode: 'confirm', // confirm: 由我确认后应用 ; auto: 自动应用
            allow: { damage: true, heal: true, status: true, unstatus: true, move: true, retreat: true, spawn: true, terrain: true, end: false },
            maxChangePct: 50, // 单条指令的 HP 变化上限（目标最大 HP 的百分比）
            allowKill: false, // 指令能否直接击败单位
            hideBlock: true, // 从聊天消息中移除指令块
            // ② LLM 指挥官：由 LLM 为 AI 单位选择行动
            commander: { enemy: false, ally: false },
            options: 6, // 每个单位最多列出几个选项
            intent: true, // 让 LLM 附带一句意图，写进战斗描写
        },
        ui: {
            layout: 'dock', // dock: 停靠在右侧 ; float: 自由浮动
            dockWidth: 440,
            fab: true, // 显示悬浮按钮
            squeeze: true, // 停靠时让聊天区域让出位置
            fabPos: { right: 20, bottom: 140 },
            cell: 40, // 格子大小上限（会根据面板宽度自动缩小）
            left: null, top: null, width: null, height: null, tab: 'battle',
        },
    };
}

/** 测试用：把示例资料卡的内容平铺到设置上（units / terrains / maps / rules + 全局设置） */
export function flatDefaults() {
    const d = defaultSettings();
    return { ...d, ...d.profiles[0] };
}
