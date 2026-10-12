// 单位 / 地形 / 地图 编辑器
import { h, clear, toast, button, select, field, numInput, textInput, textArea, checkbox, renderBoard, renderToken, contrast } from './dom.js';
import { makeUnit, makeSkill, makeMap, makeWave, uid, DEFAULT_TERRAINS } from '../defaults.js';
import { MISSION_NAMES, EFFECTS, normalizeSkill } from '../engine.js';
import * as ST from '../st.js';

const SIDES = [['player', '我方'], ['ally', '友军'], ['enemy', '敌方']];
const AIS = [['aggressive', '主动出击（会接近目标）'], ['defensive', '原地迎击（只攻击可触及的目标）'], ['stationary', '固守不动（不移动）']];
const KINDS = [['physical', '物理伤害（ATK vs DEF）'], ['magical', '魔法伤害（MATK vs MDEF）'], ['support', '辅助（治疗 / 增益 / 减益）']];
const TARGETS = [['ally', '友方（含自己）'], ['enemy', '敌方'], ['self', '仅自己']];

export function newEditorUi() {
    return { unitId: null, skillUnitId: null, skillId: null, terrainId: null, mapId: null, tool: 'paint', brush: 'plain', placeUnit: null, wbBook: null };
}

/** 编辑器顶部：提示正在编辑哪张资料卡 */
function profileNote(app) {
    return h('div.tsrpg-row.tsrpg-muted.tsrpg-profile-note', h('i.fa-solid.fa-address-card'), ` 正在编辑资料卡：${app.data.name}`,
        h('a.tsrpg-link', { onclick: () => app.setTab('profiles') }, '切换'));
}

function listItem(active, onclick, ...content) {
    return h(`div.tsrpg-list-item${active ? '.active' : ''}`, { onclick }, ...content);
}

// ================================================================ 单位

export function renderUnitsTab(app, root) {
    clear(root);
    const s = app.settings, ed = app.ed;
    if (!app.data.units.some(u => u.id === ed.unitId)) ed.unitId = app.data.units[0]?.id || null;
    const cur = app.data.units.find(u => u.id === ed.unitId);

    const add = side => {
        const u = makeUnit({ side, name: side === 'enemy' ? '新敌人' : side === 'ally' ? '新友军' : '新角色' });
        app.data.units.push(u); ed.unitId = u.id; app.save(); app.render();
    };
    const list = h('div.tsrpg-list',
        h('div.tsrpg-row',
            button('我方', () => add('player'), { icon: 'fa-plus' }),
            button('敌方', () => add('enemy'), { icon: 'fa-plus' }),
            button('友军', () => add('ally'), { icon: 'fa-plus' })),
        SIDES.map(([side, label]) => {
            const us = app.data.units.filter(u => u.side === side);
            if (!us.length) return null;
            return [h('div.tsrpg-list-group', label), us.map(u => listItem(u.id === ed.unitId, () => { ed.unitId = u.id; ed.wbBook = null; app.render(); },
                renderToken({ ...u, maxHp: 0 }), h('span', u.name), u.wb ? h('i.fa-solid.fa-book.tsrpg-muted', { title: `${u.wb.book} › ${u.wb.label}` }) : null))];
        }),
    );
    root.append(profileNote(app));
    root.append(h('div.tsrpg-editor', list, h('div.tsrpg-form', cur ? unitForm(app, cur) : h('div.tsrpg-empty', '新建一个单位开始吧。'))));
}

function unitForm(app, u) {
    const s = app.settings;
    const set = (k, rerender = false) => v => { u[k] = v; app.save(); if (rerender) app.render(); };
    const stat = (k, label, opts) => field(label, numInput(u[k], set(k), { min: 0, ...opts }));

    return h('div',
        h('div.tsrpg-row',
            h('b.tsrpg-form-title', u.name),
            h('div.tsrpg-spacer'),
            button('复制', () => {
                const c = structuredClone(u); c.id = uid('unit'); c.name += '·副本';
                c.skills.forEach(sk => { sk.id = uid('sk'); });
                app.data.units.push(c); app.ed.unitId = c.id; app.save(); app.render();
            }, { icon: 'fa-copy' }),
            button('删除', () => {
                if (!confirm(`删除单位「${u.name}」？地图上它的放置和增援也会被移除。`)) return;
                app.data.units.splice(app.data.units.indexOf(u), 1);
                app.data.maps.forEach(m => {
                    m.placements = m.placements.filter(p => p.unitId !== u.id);
                    m.reinforcements = (m.reinforcements || []).filter(w => w.unitId !== u.id);
                });
                app.save(); app.render();
            }, { icon: 'fa-trash', cls: 'danger' }),
        ),
        h('div.tsrpg-grid3',
            field('名称', textInput(u.name, set('name', true))),
            field('阵营', select(SIDES, u.side, set('side', true))),
            field('类型', select([['unit', '角色（会行动）'], ['object', '建筑 / 目标物（不会行动）']], u.kind || 'unit', set('kind', true)),
                '建筑物只有 HP / DEF / MDEF，例如城门、水晶、旗帜'),
            field('故事中的名字 / 别名', textInput(u.aliases, set('aliases'), '逗号分隔，可写 {{user}} {{char}}'),
                'LLM 在故事里怎么称呼这个单位；会写进战场信息，让两边对上号'),
            field('棋子文字', textInput(u.icon, set('icon', true), '默认取名称首字')),
            field('棋子颜色', h('div.tsrpg-row',
                h('input', { type: 'color', value: u.color || '#2f6fd6', onchange: e => set('color', true)(e.target.value) }),
                button('', () => set('color', true)(''), { icon: 'fa-rotate-left', title: '使用阵营默认色' }))),
        ),
        h('div.tsrpg-row',
            checkbox('★ 关键目标', u.keyTarget, set('keyTarget', true), '守城战：我方/友军的关键目标是敌人进攻的对象，被摧毁即失败；进攻战：敌方的关键目标全部被摧毁即胜利'),
            h('small.tsrpg-muted', u.side === 'enemy' ? '敌方关键目标：进攻战中需要破坏它' : '我方关键目标：守城战中敌人会直奔它，被摧毁即失败'),
        ),
        h('div.tsrpg-section-title', '基础数值'),
        u.kind === 'object' ? h('div.tsrpg-grid7', stat('hp', 'HP', { min: 1 }), stat('def', 'DEF'), stat('mdef', 'MDEF')) : [
            h('div.tsrpg-grid7',
                stat('hp', 'HP', { min: 1 }), stat('atk', 'ATK'), stat('matk', 'MATK'),
                stat('def', 'DEF'), stat('mdef', 'MDEF'), stat('agi', 'AGI'), stat('mov', 'MOV'),
            ),
            h('small.tsrpg-muted', 'AGI（敏捷）影响命中与闪避：命中率＝基础命中 ＋（攻方AGI − 守方AGI）× 系数 − 地形闪避。'),
            h('div.tsrpg-grid3',
                field('普通攻击类型', select(KINDS.slice(0, 2), u.atkType, set('atkType'))),
                field('攻击射程（最小）', numInput(u.rangeMin, set('rangeMin'), { min: 1 })),
                field('攻击射程（最大）', numInput(u.rangeMax, set('rangeMax'), { min: 1 })),
            ),
            h('div.tsrpg-grid2',
                field('武器名称', textInput(u.weaponName || '', set('weaponName'), '例如：大剑、长枪')),
                field('普通攻击顺序', select([['normal', '普通：主动攻击时先出手'], ['last', '后手：大剑 / 重武器']], u.attackOrder || 'normal', set('attackOrder')))),
            h('small.tsrpg-muted', '后手角色主动普通攻击时，可回击且非后手的目标先攻击；若先被击败则无法出手。双方都是后手时仍由主动方先攻。目标无法回击、眩晕或是建筑时不抢先；MAP技能不触发这一规则。'),
            h('div.tsrpg-row',
                checkbox('飞行单位', u.flying, set('flying'), '飞行单位无视地形移动消耗，可越过河流、峡谷等'),
            ),
            u.side !== 'player' ? field('AI 行为', select(AIS, u.ai, set('ai'))) : null,
        ],
        h('div.tsrpg-section-title', '世界书绑定'),
        wbBinder(app, u),
        u.kind === 'object' ? null : skillEditor(app, u),
        field('备注', textArea(u.notes, set('notes'), 2, '仅自己可见的备注')),
    );
}

/** 先选择技能，再编辑；切换单位或删除技能时修正当前选择。 */
function skillEditor(app, u) {
    const ed = app.ed;
    if (ed.skillUnitId !== u.id || !u.skills.some(sk => sk.id === ed.skillId)) {
        ed.skillUnitId = u.id;
        ed.skillId = u.skills[0]?.id || null;
    }
    const selected = u.skills.find(sk => sk.id === ed.skillId);
    return h('div.tsrpg-skill-editor',
        h('div.tsrpg-section-title', '技能'),
        h('div.tsrpg-row.tsrpg-skill-picker',
            u.skills.length ? field('选择已有技能', select(
                u.skills.map(sk => [sk.id, sk.name || '未命名技能']), ed.skillId,
                id => { ed.skillId = id; app.render(); },
            )) : null,
            button('创建新技能', () => {
                const sk = makeSkill();
                u.skills.push(sk);
                ed.skillId = sk.id;
                app.save(); app.render();
            }, { icon: 'fa-plus' }),
        ),
        selected ? skillForm(app, u, selected) : h('div.tsrpg-muted', '还没有技能，点击「创建新技能」开始编辑。'),
    );
}

/** 预设效果下拉框（按 立即 / 增益 / 减益 分组），效果类型只能从预设中选择 */
function effectSelect(value, onchange) {
    const groups = {};
    for (const [id, def] of Object.entries(EFFECTS)) (groups[def.group] ||= []).push([id, def.name]);
    const el = h('select.text_pole', { onchange: e => onchange(e.target.value) },
        Object.entries(groups).map(([g, opts]) => h('optgroup', { label: g }, opts.map(([id, name]) => h('option', { value: id }, name)))));
    el.value = value;
    return el;
}

function effectRow(app, sk, e) {
    const def = EFFECTS[e.type] || {};
    const save = () => { app.save(); };
    return h('div.tsrpg-effect',
        effectSelect(e.type, v => {
            // 换类型时套用该预设的默认数值
            e.type = v;
            e.value = EFFECTS[v].value ?? 0;
            e.turns = EFFECTS[v].instant ? 0 : (e.turns || 2);
            app.save(); app.render();
        }),
        def.noValue ? h('span.tsrpg-muted', '—') : h('label.tsrpg-inline',
            numInput(e.value, v => { e.value = v; save(); }, { min: e.type === 'taunt' ? 0 : 1 }), h('small', def.unit || '')),
        def.instant ? h('small.tsrpg-muted', '立即生效') : h('label.tsrpg-inline',
            numInput(e.turns, v => { e.turns = Math.max(1, v); save(); }, { min: 1 }), h('small', '回合')),
        h('small.tsrpg-muted.tsrpg-effect-help', def.help || ''),
        button('', () => { sk.effects.splice(sk.effects.indexOf(e), 1); app.save(); app.render(); }, { icon: 'fa-xmark', cls: 'danger', title: '移除效果' }),
    );
}

function skillForm(app, u, sk) {
    normalizeSkill(sk);
    const set = (k, rerender = false) => v => { sk[k] = v; app.save(); if (rerender) app.render(); };
    const support = sk.kind === 'support';
    const self = support && sk.target === 'self';
    const map = ['mapLine', 'mapArea'].includes(sk.attackMode);
    return h('div.tsrpg-skill',
        h('div.tsrpg-grid3',
            field('技能名', textInput(sk.name, set('name', true))),
            field('类型', select(KINDS, sk.kind, v => {
                sk.kind = v;
                sk.target = v === 'support' ? 'ally' : 'enemy';
                if (v === 'support') sk.attackMode = 'normal';
                app.save(); app.render();
            })),
            support
                ? field('作用对象', select(TARGETS, sk.target, set('target', true)))
                : field('威力 %', numInput(sk.power, set('power'), { min: 0, step: 10 })),
        ),
        support ? null : h('div.tsrpg-grid2',
            field('攻击方式', select([['normal', '普通技能'], ['mapLine', 'MAP：直线路径攻击'], ['mapArea', 'MAP：指定地块范围攻击']], sk.attackMode, v => {
                sk.attackMode = v;
                if (v === 'mapArea') sk.radius = Math.max(1, Number(sk.radius) || 1);
                app.save(); app.render();
            })),
            map ? field('MAP作用对象', select([['all', '敌我全部（不伤害自己）'], ['enemy', '仅敌方']], sk.mapTargets, set('mapTargets', true))) : null),
        map ? h('small.tsrpg-muted', 'MAP不触发反击或后手交换；同时攻击所有覆盖目标。默认会误伤友军，可切换为仅敌方。') : null,
        h('div.tsrpg-grid5',
            self || sk.attackMode === 'mapLine' ? null : field('射程最小', numInput(sk.rangeMin, set('rangeMin'), { min: 0 }), '0＝可以对自己所在格使用'),
            self || sk.attackMode === 'mapLine' ? null : field('射程最大', numInput(sk.rangeMax, set('rangeMax'), { min: 0 })),
            sk.attackMode === 'mapLine' ? field('直线长度', numInput(sk.lineLength, set('lineLength'), { min: 1, max: 100 }), '从自己向上下左右延伸；点击方向上的任一格') : self ? null : field('范围半径', numInput(sk.radius, set('radius'), { min: sk.attackMode === 'mapArea' ? 1 : 0 }), '按格子距离计算菱形范围；普通技能0＝单体'),
            field('冷却回合', numInput(sk.cooldown, set('cooldown'), { min: 0 }), '每 N 回合可用一次；0 或 1＝每回合可用'),
            field('次数', numInput(sk.uses, set('uses'), { min: 0 }), '每场战斗；0＝无限'),
        ),
        support && sk.target !== 'enemy' ? null : h('div.tsrpg-row',
            h('span.tsrpg-label', '命中修正 %'),
            h('div', { style: { width: '90px' } }, numInput(sk.hitMod, set('hitMod'), { min: -100, max: 100, step: 5 })),
            checkbox('必中（无视闪避）', sk.sureHit, set('sureHit', true)),
            h('small.tsrpg-muted', '对友方的技能必定命中'),
        ),
        h('div.tsrpg-label', support ? '效果' : '附加效果（命中且未被击败的目标获得）'),
        sk.effects.map(e => effectRow(app, sk, e)),
        h('div.tsrpg-row',
            button('添加效果', () => {
                const type = support ? (sk.target === 'enemy' ? 'atk_down' : 'heal') : 'def_down';
                sk.effects.push({ type, value: EFFECTS[type].value, turns: EFFECTS[type].instant ? 0 : 2 });
                app.save(); app.render();
            }, { icon: 'fa-plus' }),
            support && !sk.effects.length ? h('small.tsrpg-warn', '辅助技能至少需要一个效果') : null,
        ),
        h('div.tsrpg-row',
            textInput(sk.desc, set('desc'), '技能描述（会告诉 LLM，用于描写）'),
            button('', () => { u.skills.splice(u.skills.indexOf(sk), 1); app.save(); app.render(); }, { icon: 'fa-trash', cls: 'danger', title: '删除技能' }),
        ),
    );
}

function wbBinder(app, u) {
    const ed = app.ed;
    const book = ed.wbBook ?? u.wb?.book ?? '';
    const bookSel = select([['', '— 选择世界书 —']], '', v => { ed.wbBook = v; app.render(); });
    const entrySel = select([['', '— 选择条目 —']], '', async v => {
        if (!v) return;
        const entries = await ST.loadBookEntries(book);
        const e = entries.find(x => String(x.uid) === v);
        if (!e) return;
        u.wb = { book, uid: e.uid, label: e.label, keys: e.keys };
        ed.wbBook = null;
        app.save(); app.render();
    });
    const status = h('div.tsrpg-muted');

    ST.listWorldBooks().then(names => {
        names.forEach(n => bookSel.append(h('option', { value: n }, n)));
        bookSel.value = book;
        if (book && !names.includes(book)) status.textContent = `⚠ 世界书「${book}」不存在或未加载`;
    }).catch(() => { status.textContent = '无法读取世界书列表'; });

    if (book) {
        ST.loadBookEntries(book, true).then(entries => {
            entries.forEach(e => entrySel.append(h('option', { value: String(e.uid) }, `${e.label}${e.keys.length ? `  [${e.keys.slice(0, 3).join(', ')}]` : ''}${e.disabled ? '（已禁用）' : ''}`)));
            if (u.wb?.book === book) entrySel.value = String(u.wb.uid);
            if (u.wb?.book === book && !entries.some(e => e.uid === u.wb.uid)) status.textContent = '⚠ 绑定的条目已不存在';
        }).catch(err => { status.textContent = `读取条目失败：${err.message || err}`; });
    }

    return h('div',
        h('div.tsrpg-grid2', field('世界书', bookSel), field('条目', entrySel)),
        u.wb ? h('div.tsrpg-row',
            h('span', h('i.fa-solid.fa-link'), ` 已绑定：${u.wb.book} › ${u.wb.label}`, u.wb.keys?.length ? h('small.tsrpg-muted', `  关键词：${u.wb.keys.join(', ')}`) : null),
            h('div.tsrpg-spacer'),
            button('用条目名命名', () => { u.name = u.wb.label; app.save(); app.render(); }, { icon: 'fa-signature' }),
            button('刷新', async () => {
                const e = (await ST.loadBookEntries(u.wb.book, true)).find(x => x.uid === u.wb.uid);
                if (!e) return toast('warning', '条目已不存在');
                Object.assign(u.wb, { label: e.label, keys: e.keys }); app.save(); app.render();
            }, { icon: 'fa-rotate', title: '重新读取条目名称与关键词' }),
            button('解除', () => { u.wb = null; app.save(); app.render(); }, { icon: 'fa-link-slash', cls: 'danger' }),
        ) : h('div.tsrpg-muted', '绑定后，发送战斗描写时会带上条目的第一个关键词，从而触发该世界书条目；也可在设置中选择把条目内容注入战场状态。'),
        status,
    );
}

// ================================================================ 地形

export function renderTerrainsTab(app, root) {
    clear(root);
    const s = app.settings, ed = app.ed;
    if (!app.data.terrains.some(t => t.id === ed.terrainId)) ed.terrainId = app.data.terrains[0]?.id || null;
    const cur = app.data.terrains.find(t => t.id === ed.terrainId);
    const list = h('div.tsrpg-list',
        button('新建地形', () => {
            const t = { id: uid('ter'), name: '新地形', symbol: '', color: '#a1887f', moveCost: 1, passable: true, flyable: true, defBonus: 0, healPct: 0, desc: '' };
            app.data.terrains.push(t); ed.terrainId = t.id; app.save(); app.render();
        }, { icon: 'fa-plus' }),
        button('添加熔岩', () => {
            let lava = app.data.terrains.find(t => t.id === 'lava');
            if (!lava) { lava = structuredClone(DEFAULT_TERRAINS.find(t => t.id === 'lava')); app.data.terrains.push(lava); app.save(); }
            ed.terrainId = lava.id; app.render();
        }, { icon: 'fa-fire' }),
        app.data.terrains.map(t => listItem(t.id === ed.terrainId, () => { ed.terrainId = t.id; app.render(); },
            h('span.tsrpg-swatch', { style: { background: t.color, color: contrast(t.color) } }, t.symbol || ''), h('span', t.name))),
    );
    root.append(profileNote(app));
    root.append(h('div.tsrpg-editor', list, h('div.tsrpg-form', cur ? terrainForm(app, cur) : null)));
}

function terrainForm(app, t) {
    const s = app.settings;
    const set = (k, rerender = false) => v => { t[k] = v; app.save(); if (rerender) app.render(); };
    return h('div',
        h('div.tsrpg-row', h('b.tsrpg-form-title', t.name), h('div.tsrpg-spacer'),
            button('删除', () => {
                if (app.data.terrains.length <= 1) return toast('warning', '至少保留一种地形');
                const fallback = app.data.terrains.find(x => x !== t);
                if (!confirm(`删除地形「${t.name}」？地图上使用它的格子会变为「${fallback.name}」。`)) return;
                app.data.terrains.splice(app.data.terrains.indexOf(t), 1);
                app.data.maps.forEach(m => { m.tiles = m.tiles.map(id => id === t.id ? fallback.id : id); });
                app.save(); app.render();
            }, { icon: 'fa-trash', cls: 'danger' })),
        h('div.tsrpg-grid3',
            field('名称', textInput(t.name, set('name', true))),
            field('符号', textInput(t.symbol, set('symbol', true), '如 ♣ ≈ ▲')),
            field('颜色', h('input', { type: 'color', value: t.color, onchange: e => set('color', true)(e.target.value) })),
        ),
        h('div.tsrpg-grid4',
            field('移动消耗', numInput(t.moveCost, set('moveCost'), { min: 1 }), '进入此格消耗的移动力'),
            field('减伤 %', numInput(t.defBonus, set('defBonus'), { min: -100, max: 100 }), '站在此格时受到伤害的减免（可为负）'),
            field('闪避加成 %', numInput(t.avoid ?? 0, set('avoid'), { min: -100, max: 100 }), '站在此格时，敌人对它的命中率降低（可为负）'),
            field('回合回复 %', numInput(t.healPct, set('healPct'), { min: 0, max: 100 }), '回合开始时恢复最大 HP 的比例'),
        ),
        h('div.tsrpg-row',
            checkbox('步行可通过', t.passable, set('passable')),
            checkbox('飞行可通过', t.flyable, set('flyable')),
        ),
        h('div.tsrpg-section-title', '地形伤害'),
        h('div.tsrpg-grid4',
            field('落脚扣血', numInput(t.enterDamage ?? 0, set('enterDamage'), { min: 0 }), '移动终点落在此格时扣除固定HP'),
            field('落脚扣血 %', numInput(t.enterDamagePct ?? 0, set('enterDamagePct'), { min: 0, max: 100 }), '按最大HP计算，与固定伤害相加'),
            field('回合扣血', numInput(t.turnDamage ?? 0, set('turnDamage'), { min: 0 }), '该单位所属阵营阶段开始时扣血'),
            field('回合扣血 %', numInput(t.turnDamagePct ?? 0, set('turnDamagePct'), { min: 0, max: 100 }), '按最大HP计算，与固定伤害相加'),
        ),
        checkbox('地形伤害也影响飞行单位', t.damageFlying ?? false, set('damageFlying')),
        h('small.tsrpg-muted', '地形伤害可致死，不受防御减免；只结算落脚格，不计算沿途经过的格子。'),
        field('描述（会告诉 LLM）', textArea(t.desc, set('desc'), 2, '例如：湍急的河流，水声隆隆')),
    );
}

// ================================================================ 地图

let painting = false;
let lastPaint = null;
window.addEventListener('mouseup', () => { painting = false; lastPaint = null; });

export function renderMapsTab(app, root) {
    clear(root);
    const s = app.settings, ed = app.ed;
    if (!app.data.maps.some(m => m.id === ed.mapId)) ed.mapId = app.data.maps[0]?.id || null;
    const cur = app.data.maps.find(m => m.id === ed.mapId);
    const list = h('div.tsrpg-list',
        button('新建地图', () => {
            const m = makeMap({ tiles: undefined });
            m.tiles = new Array(m.w * m.h).fill(app.data.terrains[0]?.id || 'plain');
            app.data.maps.push(m); ed.mapId = m.id; app.save(); app.render();
        }, { icon: 'fa-plus' }),
        app.data.maps.map(m => listItem(m.id === ed.mapId, () => { ed.mapId = m.id; app.render(); }, h('span', m.name), h('small.tsrpg-muted', ` ${m.w}×${m.h}`))),
    );
    root.append(profileNote(app));
    root.append(h('div.tsrpg-editor.wide', list, h('div.tsrpg-form', cur ? mapForm(app, cur) : h('div.tsrpg-empty', '新建一张地图吧。'))));
}

function resizeMap(m, w, h2, fill) {
    w = Math.max(3, Math.min(40, w | 0)); h2 = Math.max(3, Math.min(40, h2 | 0));
    const tiles = new Array(w * h2).fill(fill);
    for (let y = 0; y < Math.min(h2, m.h); y++) for (let x = 0; x < Math.min(w, m.w); x++) tiles[y * w + x] = m.tiles[y * m.w + x];
    m.tiles = tiles; m.w = w; m.h = h2;
    m.placements = m.placements.filter(p => p.x < w && p.y < h2);
    m.reinforcements = (m.reinforcements || []).filter(r => r.x < w && r.y < h2);
}

const TURNS_LABEL = {
    annihilate: ['回合限制', '0＝不限；超过回合数仍未歼灭敌人即失败'],
    defend: ['坚守回合数', '坚守到该回合结束即胜利；0＝必须击退所有敌人'],
    assault: ['回合限制', '0＝不限；超过回合数仍未摧毁关键目标即失败'],
};
const MISSION_HELP = {
    annihilate: '击败所有敌人（包括后续增援）。敌人会寻找最近的角色攻击。',
    defend: '放置一个我方/友军的「★ 关键目标」（如城门）。敌人会朝它前进并攻击，只在被挡住时攻击挡路的角色。目标被摧毁即失败。',
    assault: '放置至少一个敌方「★ 关键目标」（如水晶、旗帜），全部摧毁即胜利。可配合增援让敌人源源不断。',
};

function missionEditor(app, m) {
    const s = app.settings;
    const ms = m.mission;
    const [label, hint] = TURNS_LABEL[ms.type] || TURNS_LABEL.annihilate;
    const unitOpts = app.data.units.map(u => [u.id, `${u.name}（${SIDES.find(x => x[0] === u.side)?.[1]}）`]);
    const num = (w, k, min = 0, offset = 0) => numInput((Number(w[k]) || 0) + offset, v => { w[k] = Math.max(min, v - offset); app.save(); app.render(); }, { min: min + offset });
    return h('div',
        h('div.tsrpg-section-title', '任务'),
        h('div.tsrpg-grid3',
            field('任务类型', select(Object.entries(MISSION_NAMES), ms.type, v => { ms.type = v; app.save(); app.render(); })),
            field(label, numInput(ms.turns, v => { ms.turns = Math.max(0, v); app.save(); }, { min: 0 }), hint),
        ),
        h('div.tsrpg-muted', MISSION_HELP[ms.type]),
        h('div.tsrpg-section-title', '增援', h('div.tsrpg-spacer'),
            button('添加增援', () => {
                m.reinforcements.push(makeWave({ unitId: app.data.units.find(u => u.side === 'enemy')?.id || app.data.units[0]?.id, x: m.w - 1, y: Math.floor(m.h / 2) }));
                app.save(); app.render();
            }, { icon: 'fa-plus' })),
        m.reinforcements.length ? m.reinforcements.map(w => h('div.tsrpg-skill',
            h('div.tsrpg-grid4',
                field('单位', select(unitOpts, w.unitId, v => { w.unitId = v; app.save(); app.render(); })),
                field('出现位置 X', num(w, 'x', 0, 1)),
                field('出现位置 Y', num(w, 'y', 0, 1)),
                field('每次数量', num(w, 'count', 1)),
            ),
            h('div.tsrpg-grid4',
                field('首次出现回合', num(w, 'startTurn', 1), '该回合的敌方/友军阶段结束时出现'),
                field('间隔回合', num(w, 'every', 0), '0＝只出现一次'),
                field('最多次数', num(w, 'times', 0), '0＝无限（间隔 > 0 时）'),
                h('div.tsrpg-row', button('删除', () => { m.reinforcements.splice(m.reinforcements.indexOf(w), 1); app.save(); app.render(); }, { icon: 'fa-trash', cls: 'danger' })),
            ),
        )) : h('div.tsrpg-muted', '没有增援。可以点「添加增援」，或用上方的「增援点」工具直接在地图上点选位置。'),
    );
}

function mapForm(app, m) {
    const s = app.settings, ed = app.ed;
    const set = (k, rerender = false) => v => { m[k] = v; app.save(); if (rerender) app.render(); };
    m.mission ||= { type: 'annihilate', turns: 0 };
    m.reinforcements ||= [];
    if (!app.data.terrains.some(t => t.id === ed.brush)) ed.brush = app.data.terrains[0]?.id;
    if (!app.data.units.some(u => u.id === ed.placeUnit)) ed.placeUnit = app.data.units[0]?.id || null;
    const terrains = new Map(app.data.terrains.map(t => [t.id, t]));
    const terr = id => terrains.get(id) || { name: id, color: '#999' };
    const unitDefs = new Map(app.data.units.map(u => [u.id, u]));

    const apply = (x, y, cell) => {
        if (ed.tool === 'paint') {
            m.tiles[y * m.w + x] = ed.brush;
            const t = terr(ed.brush);
            if (cell) {
                cell.style.background = t.color; cell.style.color = contrast(t.color); cell.title = `(${x + 1},${y + 1}) ${t.name}`;
                const sym = cell.querySelector('.tsrpg-sym');
                if (sym) sym.textContent = t.symbol || ''; else if (t.symbol) cell.prepend(h('span.tsrpg-sym', t.symbol));
            }
            app.save();
            return false;
        }
        if (ed.tool === 'spawn') {
            if (ed.placeUnit) m.reinforcements.push(makeWave({ unitId: ed.placeUnit, x, y }));
            app.save();
            return true;
        }
        m.placements = m.placements.filter(p => p.x !== x || p.y !== y);
        if (ed.tool === 'place' && ed.placeUnit) m.placements.push({ unitId: ed.placeUnit, x, y });
        app.save();
        return true;
    };
    const marks = new Map();
    for (const w of m.reinforcements) marks.set(`${w.x},${w.y}`, ['m-spawn']);

    const board = renderBoard({
        w: m.w, h: m.h, tiles: m.tiles, terrain: terr, cell: app.cellFor(m.w, 192), marks,
        units: m.placements.filter(p => unitDefs.has(p.unitId)).map(p => ({ ...unitDefs.get(p.unitId), x: p.x, y: p.y, maxHp: 0 })),
        onCell: (x, y, e) => {
            painting = ed.tool === 'paint';
            lastPaint = [x, y];
            if (apply(x, y, e.target.closest('.tsrpg-cell'))) app.render();
        },
        onHover: (x, y, e) => {
            if (!painting || ed.tool !== 'paint') return;
            // 鼠标移动过快时补齐中间跳过的格子
            const [lx, ly] = lastPaint || [x, y];
            const steps = Math.max(Math.abs(x - lx), Math.abs(y - ly));
            for (let i = 1; i <= steps; i++) {
                const px = Math.round(lx + ((x - lx) * i) / steps), py = Math.round(ly + ((y - ly) * i) / steps);
                apply(px, py, board.querySelector(`[data-x="${px}"][data-y="${py}"]`));
            }
            lastPaint = [x, y];
        },
        onContext: (x, y) => {
            const key = ed.tool === 'spawn' ? 'reinforcements' : 'placements';
            const before = m[key].length;
            m[key] = m[key].filter(p => p.x !== x || p.y !== y);
            if (m[key].length !== before) { app.save(); app.render(); }
        },
    });

    const toolBtn = (tool, label, icon) => button(label, () => { ed.tool = tool; app.render(); }, { icon, cls: ed.tool === tool ? 'active' : '' });
    const sizeW = numInput(m.w, () => {}, { min: 3, max: 40 });
    const sizeH = numInput(m.h, () => {}, { min: 3, max: 40 });

    return h('div',
        h('div.tsrpg-row', h('b.tsrpg-form-title', m.name), h('div.tsrpg-spacer'),
            button('复制', () => {
                const c = structuredClone(m); c.id = uid('map'); c.name += '·副本';
                app.data.maps.push(c); ed.mapId = c.id; app.save(); app.render();
            }, { icon: 'fa-copy' }),
            button('删除', () => {
                if (!confirm(`删除地图「${m.name}」？`)) return;
                app.data.maps.splice(app.data.maps.indexOf(m), 1); app.save(); app.render();
            }, { icon: 'fa-trash', cls: 'danger' })),
        h('div.tsrpg-grid3',
            field('名称', textInput(m.name, set('name', true))),
            field('尺寸（宽×高）', h('div.tsrpg-row', sizeW, '×', sizeH,
                button('应用', () => { resizeMap(m, +sizeW.value, +sizeH.value, ed.brush); app.save(); app.render(); }, { icon: 'fa-check' }))),
        ),
        field('地图描述（会告诉 LLM）', textArea(m.desc, set('desc'), 2, '例如：一条河流将平原一分为二……')),
        h('div.tsrpg-row.tsrpg-toolbar',
            toolBtn('paint', '画地形', 'fa-paintbrush'),
            toolBtn('place', '放置单位', 'fa-chess-pawn'),
            toolBtn('erase', '移除单位', 'fa-eraser'),
            toolBtn('spawn', '增援点', 'fa-flag'),
            ed.tool === 'paint' ? button('全图填充', () => {
                if (!confirm(`用「${terr(ed.brush).name}」填满整张地图？`)) return;
                m.tiles.fill(ed.brush); app.save(); app.render();
            }, { icon: 'fa-fill-drip' }) : null,
        ),
        ed.tool === 'paint' ? h('div.tsrpg-palette', app.data.terrains.map(t =>
            h(`div.tsrpg-palette-item${t.id === ed.brush ? '.active' : ''}`, { onclick: () => { ed.brush = t.id; app.render(); }, title: t.desc },
                h('span.tsrpg-swatch', { style: { background: t.color, color: contrast(t.color) } }, t.symbol || ''), t.name))) : null,
        ['place', 'spawn'].includes(ed.tool) ? h('div.tsrpg-palette', app.data.units.map(u =>
            h(`div.tsrpg-palette-item${u.id === ed.placeUnit ? '.active' : ''}`, { onclick: () => { ed.placeUnit = u.id; app.render(); } },
                renderToken({ ...u, maxHp: 0 }), u.name))) : null,
        h('div.tsrpg-muted', ed.tool === 'spawn'
            ? '点击地图添加一个增援点（使用上面选中的单位），右键删除该格的增援点。红色虚线 ⚑ 为增援出现点，详细设置在地图下方。'
            : '提示：按住鼠标拖动可连续绘制地形；右键格子可移除单位。同一单位可放置多次（自动编号 A、B、C…）。'),
        h('div.tsrpg-board-wrap', board),
        missionEditor(app, m),
    );
}
