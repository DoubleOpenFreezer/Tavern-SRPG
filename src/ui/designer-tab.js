// AI 设计页：选择 API、世界书，描述需求，预览 AI 设计的地图 / 单位 / 地形 / 兵种并导入资料卡
import { h, clear, toast, button, select, field, numInput, textInput, textArea, checkbox, renderBoard, renderToken, contrast, textDialog } from './dom.js';
import { DESIGN_TASKS, DESIGN_LABELS, buildDesignPrompt, parseDesignReply, normalizeDesign, applyDesign, designSummary } from '../designer.js';
import { DESIGN_SOURCES, designerGenerate, fetchModels } from '../ai-api.js';
import { MISSION_NAMES, matchupLabel, matchup, battleUnitTypes, SIDE_NAMES } from '../engine.js';
import { skillSummary } from '../narrator.js';
import * as ST from '../st.js';

const PLACEHOLDER = {
    battle: '例如：主角一行在夜里穿越精灵森林，被暗影教团伏击；敌人 6 个左右，有一个施法首领；开启战争迷雾。',
    map: '例如：一座被围困的山城，城门在西侧，守城战坚守 6 回合，敌人从东边分批增援。',
    units: '例如：设计 4 个暗影教团的敌人：两种近战杂兵、一个弓手、一个会召唤和治疗的祭司。',
    terrains: '例如：为冰原战场设计 3 种地形：冰面（滑，移动消耗低但闪避下降）、雪堆、冰裂缝。',
    types: '例如：按这个世界的兵种体系（骑士、游侠、法师、圣职者）设计克制关系。',
};

function state(app) {
    app.ds ||= { task: 'battle', request: '', w: 12, h: 8, allowNew: true, busy: false, error: '', reply: '', json: null, design: null,
        profileId: null, chosen: new Set(), imported: new Set(), feedback: '', entries: [], warningsOpen: false, bookNames: null, autoBooks: null, models: [] };
    return app.ds;
}

export function renderDesignerTab(app, root) {
    clear(root);
    const ds = state(app);
    const cfg = app.settings.designer;
    // 换了资料卡：按新资料卡重新解析，引用才能对上
    if (ds.json && ds.profileId !== app.data.id) renormalize(app);
    root.append(
        h('div.tsrpg-row.tsrpg-muted.tsrpg-profile-note', h('i.fa-solid.fa-address-card'), ` 设计结果会导入资料卡：${app.data.name}`,
            h('a.tsrpg-link', { onclick: () => app.setTab('profiles') }, '切换')),
        apiSection(app, cfg),
        loreSection(app, cfg, ds),
        taskSection(app, ds),
        resultSection(app, ds),
    );
}

// ---------------------------------------------------------------- API 设置

function apiSection(app, cfg) {
    const save = () => app.save();
    const set = (obj, k, rerender = false) => v => { obj[k] = v; save(); if (rerender) app.render(); };
    const ds = state(app);
    const profiles = ST.connectionProfiles();
    const summary = cfg.source === 'custom' ? `自定义：${cfg.custom.model || '未填写模型'}` : cfg.source === 'profile' ? `连接配置：${profiles.find(p => p.id === cfg.profileId)?.name || '未选择'}` : DESIGN_SOURCES.st;
    return h('details.tsrpg-design-box', { open: !!ds.apiOpen, ontoggle: e => { ds.apiOpen = e.target.open; } },
        h('summary', h('i.fa-solid.fa-plug'), ` API 设置　`, h('small.tsrpg-muted', summary)),
        field('使用哪个模型', select(Object.entries(DESIGN_SOURCES), cfg.source, set(cfg, 'source', true))),
        cfg.source === 'st' ? h('small.tsrpg-muted', '使用 SillyTavern 当前选择的 API 和模型（不带聊天记录和角色卡提示词，只发送设计任务）。生成期间不要同时在聊天里生成。') : null,
        cfg.source === 'profile' ? [
            profiles.length
                ? field('连接配置', select([['', '— 选择连接配置 —'], ...profiles.map(p => [p.id, `${p.name}${p.model ? `（${p.model}）` : ''}`])], cfg.profileId, set(cfg, 'profileId', true)))
                : h('div.tsrpg-warn', '没有找到连接配置。请在 SillyTavern 的「API 连接」页用「连接配置」保存一个配置。'),
            h('small.tsrpg-muted', '请求经由 SillyTavern 后端发送，密钥保存在 SillyTavern 里；可以和聊天使用不同的 API 与模型，不影响当前聊天的连接。'),
        ] : null,
        cfg.source === 'custom' ? [
            h('div.tsrpg-grid2',
                field('API 地址', textInput(cfg.custom.url, set(cfg.custom, 'url'), 'https://api.openai.com/v1'), 'OpenAI 兼容接口的地址，例如 …/v1；会自动补上 /chat/completions'),
                field('API Key', h('input.text_pole', { type: 'password', value: cfg.custom.key || '', placeholder: 'sk-…', autocomplete: 'off', onchange: e => set(cfg.custom, 'key')(e.target.value.trim()) }),
                    '保存在本机 SillyTavern 的扩展设置中；不会随「导出全部」导出')),
            h('div.tsrpg-grid2',
                field('模型', h('div.tsrpg-row',
                    h('input.text_pole', { type: 'text', value: cfg.custom.model || '', list: 'tsrpg-model-list', placeholder: '例如 gpt-4o、deepseek-chat', onchange: e => set(cfg.custom, 'model')(e.target.value.trim()) }),
                    h('datalist#tsrpg-model-list', ds.models.map(m => h('option', { value: m }))),
                    button('', async () => {
                        try { ds.models = await fetchModels(cfg.custom); toast('success', `获取到 ${ds.models.length} 个模型`); app.render(); } catch (err) { toast('error', err.message || String(err)); }
                    }, { icon: 'fa-list', title: '获取模型列表' }))),
                h('div', checkbox('通过 SillyTavern 代理转发', cfg.custom.proxy, set(cfg.custom, 'proxy'), '浏览器直接请求被跨域（CORS）拦截时使用；需要在 SillyTavern 的 config.yaml 中设置 enableCorsProxy: true'))),
        ] : null,
        h('div.tsrpg-grid3',
            field('最大输出长度', numInput(cfg.maxTokens, set(cfg, 'maxTokens'), { min: 512, step: 512 }), '地图越大需要越多，整场战斗建议 8000 以上'),
            cfg.source === 'custom' ? field('温度', numInput(cfg.temperature, set(cfg, 'temperature'), { min: 0, max: 2, step: 0.1 })) : null,
            h('div.tsrpg-row', button('测试连接', async e => {
                const btn = e.currentTarget; btn.disabled = true;
                try {
                    const { text } = await designerGenerate({ ...cfg, maxTokens: 512 }, { system: '你是连接测试助手。', user: '请只回复：连接正常' });
                    toast('success', `连接正常：${text.trim().slice(0, 60)}`);
                } catch (err) { toast('error', err.message || String(err)); } finally { btn.disabled = false; }
            }, { icon: 'fa-plug-circle-check' }))),
    );
}

// ---------------------------------------------------------------- 世界观资料

function loreSection(app, cfg, ds) {
    if (!ds.bookNames) {
        ds.bookNames = [];
        Promise.all([ST.listWorldBooks().catch(() => []), ST.chatLoreBooks().catch(() => [])]).then(([all, auto]) => {
            ds.bookNames = all; ds.autoBooks = auto;
            if (app.settings.ui.tab === 'design') app.render();
        });
    }
    const auto = cfg.books == null;
    const chosen = new Set(auto ? ds.autoBooks || [] : cfg.books);
    const toggle = (name, on) => {
        const list = new Set(chosen);
        if (on) list.add(name); else list.delete(name);
        cfg.books = [...list]; app.save(); app.render();
    };
    return h('details.tsrpg-design-box', { open: ds.loreOpen ?? true, ontoggle: e => { ds.loreOpen = e.target.open; } },
        h('summary', h('i.fa-solid.fa-book'), ' 世界观资料　', h('small.tsrpg-muted', `${chosen.size} 本世界书${cfg.includeChar ? ' ＋ 角色卡设定' : ''}`)),
        h('small.tsrpg-muted', 'AI 会读取勾选的世界书（只含启用的条目）和角色卡设定，让设计符合世界观；单位可以直接绑定到对应的世界书条目。'),
        h('div.tsrpg-row',
            checkbox('自动选择当前聊天的世界书', auto, on => { cfg.books = on ? null : [...chosen]; app.save(); app.render(); }, '角色卡绑定的世界书（含附加世界书）、聊天绑定的世界书和全局启用的世界书'),
            checkbox('附带角色卡设定', cfg.includeChar, v => { cfg.includeChar = v; app.save(); app.render(); })),
        ds.bookNames.length ? h('div.tsrpg-book-list', ds.bookNames.map(name =>
            h('label.tsrpg-check', h('input', { type: 'checkbox', checked: chosen.has(name), onchange: e => toggle(name, e.target.checked) }), h('span', name))))
            : h('div.tsrpg-muted', '没有读取到世界书。'),
        h('div.tsrpg-row',
            field('世界书字数上限', numInput(cfg.loreChars, v => { cfg.loreChars = Math.max(1000, v); app.save(); }, { min: 1000, step: 2000 }), '超出部分的条目不会发送；模型上下文较小时调低'),
            button('预览发送给 AI 的内容', async () => {
                const prompt = await buildPrompt(app, ds, false);
                textDialog(app.panel, '发送给 AI 设计助手的内容', `【系统提示】\n${prompt.system}\n\n【任务】\n${prompt.user}`, { note: prompt.note });
            }, { icon: 'fa-eye' })),
    );
}

async function buildPrompt(app, ds, revise) {
    const cfg = app.settings.designer;
    const books = cfg.books ?? await ST.chatLoreBooks().catch(() => []);
    const lore = await ST.loreForDesign(books, cfg.loreChars);
    ds.entries = lore.entries;
    const prompt = buildDesignPrompt(app.data, {
        task: ds.task, request: ds.request, size: { w: ds.w, h: ds.h }, allowNew: ds.allowNew,
        lore: lore.text, character: cfg.includeChar ? ST.characterBrief() : '',
        previous: revise && ds.json ? JSON.stringify(ds.json, null, 1) : '', feedback: revise ? ds.feedback : '',
    });
    prompt.note = `世界书：${books.join('、') || '无'}，${lore.entries.length} 个条目${lore.truncated ? '（超出字数上限，部分条目没有发送）' : ''}；共约 ${prompt.system.length + prompt.user.length} 字。`;
    return prompt;
}

// ---------------------------------------------------------------- 任务

function taskSection(app, ds) {
    const map = ds.task === 'battle' || ds.task === 'map';
    const request = textArea(ds.request, v => { ds.request = v; }, 4, PLACEHOLDER[ds.task]);
    request.addEventListener('input', e => { ds.request = e.target.value; });
    return h('div.tsrpg-design-box',
        h('div.tsrpg-section-title', h('i.fa-solid.fa-wand-magic-sparkles'), ' 设计什么'),
        h('div.tsrpg-grid3',
            field('内容', select(Object.entries(DESIGN_TASKS), ds.task, v => { ds.task = v; app.render(); })),
            map ? field('地图尺寸（宽×高）', h('div.tsrpg-row',
                numInput(ds.w, v => { ds.w = Math.max(3, Math.min(40, v)); }, { min: 3, max: 40 }), '×',
                numInput(ds.h, v => { ds.h = Math.max(3, Math.min(40, v)); }, { min: 3, max: 40 }))) : null,
            ds.task === 'map' ? h('div', checkbox('允许新建单位、地形和兵种', ds.allowNew, v => { ds.allowNew = v; })) : null),
        field('要求', request),
        h('div.tsrpg-row',
            ds.busy
                ? [h('span.tsrpg-busy', h('i.fa-solid.fa-spinner.fa-spin'), ` ${ds.busy}`), button('取消', () => { ds.token = null; ds.abort?.abort(); ds.busy = false; app.render(); }, { icon: 'fa-xmark' })]
                : button('开始设计', () => generate(app, false), { icon: 'fa-wand-magic-sparkles', cls: 'primary' })),
    );
}

async function generate(app, revise) {
    const ds = state(app);
    if (ds.busy) return;
    const token = {};
    Object.assign(ds, { token, busy: revise ? 'AI 正在按意见修改……' : 'AI 正在设计……', error: '', abort: new AbortController() });
    app.render();
    let text = '';
    try {
        const prompt = await buildPrompt(app, ds, revise);
        const res = await designerGenerate(app.settings.designer, prompt, { signal: ds.abort.signal });
        if (ds.token !== token) return;
        text = res.text;
        ds.reply = text;
        ds.json = parseDesignReply(text);
        ds.profileId = null;
        renormalize(app);
        if (res.truncated) ds.design.warnings.unshift('回复达到了最大输出长度，内容可能不完整。可以提高「最大输出长度」后重试。');
        toast('success', `设计完成：${designSummary(ds.design)}`);
    } catch (err) {
        if (ds.token !== token) return;
        if (text) ds.reply = text;
        ds.error = err?.name === 'AbortError' ? '已取消。' : err.message || String(err);
    } finally {
        if (ds.token === token) { ds.busy = false; ds.token = null; app.render(); }
    }
}

/** 按当前资料卡解析设计，默认全选 */
function renormalize(app) {
    const ds = state(app);
    ds.design = normalizeDesign(ds.json, app.data, { entries: ds.entries });
    ds.profileId = app.data.id;
    ds.chosen = new Set(['unitTypes', 'terrains', 'units', 'maps'].flatMap(k => ds.design[k].map(x => x.id)));
    ds.imported = new Set();
}

// ---------------------------------------------------------------- 结果

function resultSection(app, ds) {
    const d = ds.design;
    // 解析失败时显示模型的原始回复，方便查看和手动修正
    const raw = textArea(ds.json && !ds.error ? JSON.stringify(ds.json, null, 2) : ds.reply, () => {}, 10);
    const rawBox = h('details.tsrpg-design-box', { open: !!ds.error && !!ds.reply },
        h('summary', '原始回复 / JSON（可以手动修改后重新解析）'), raw,
        h('div.tsrpg-row', button('重新解析', () => {
            try { ds.json = parseDesignReply(raw.value); ds.reply = raw.value; ds.error = ''; renormalize(app); } catch (err) { ds.error = err.message; }
            app.render();
        }, { icon: 'fa-rotate' })));
    if (!d) return h('div', ds.error ? h('div.tsrpg-warn', h('i.fa-solid.fa-triangle-exclamation'), ` ${ds.error}`) : null, ds.reply ? rawBox : null);
    const types = { unitTypes: battleUnitTypes([...(app.data.unitTypes || []), ...d.unitTypes]) };
    const pending = [...ds.chosen].filter(id => !ds.imported.has(id));
    const feedback = textArea(ds.feedback, v => { ds.feedback = v; }, 2, '例如：敌人太强了，减少一个；地图再大一些，加一条河。');
    feedback.addEventListener('input', e => { ds.feedback = e.target.value; });
    return h('div.tsrpg-design-box',
        h('div.tsrpg-section-title', h('i.fa-solid.fa-clipboard-check'), ` 设计结果：${designSummary(d)}`),
        ds.error ? h('div.tsrpg-warn', ds.error) : null,
        d.warnings.length ? h('details.tsrpg-design-warnings', h('summary.tsrpg-warn', `${d.warnings.length} 处已自动修正或忽略`), h('ul', d.warnings.map(w => h('li', w)))) : null,
        ['maps', 'units', 'terrains', 'unitTypes'].map(k => d[k].length ? [
            h('div.tsrpg-list-group', DESIGN_LABELS[k]),
            d[k].map(item => itemRow(app, ds, k, item, d, types)),
        ] : null),
        h('small.tsrpg-muted', '取消勾选的内容不会导入；导入地图时会自动带上它用到的新单位、地形和兵种。导入后可以在对应页面继续修改。'),
        h('div.tsrpg-row',
            button(`导入选中的内容（${pending.length}）`, () => {
                const { added, auto, ids } = applyDesign(app.data, d, new Set(pending));
                ids.forEach(id => ds.imported.add(id));
                app.save();
                const n = Object.entries(added).filter(([, v]) => v).map(([k, v]) => `${DESIGN_LABELS[k]} ${v}`).join('、');
                toast('success', `已导入：${n}${auto.length ? `（自动带上：${auto.join('、')}）` : ''}`);
                app.render();
            }, { icon: 'fa-file-import', cls: 'primary', disabled: !pending.length || !!ds.busy })),
        h('div.tsrpg-section-title', '让 AI 修改'),
        feedback,
        h('div.tsrpg-row', button('按意见重新设计', () => generate(app, true), { icon: 'fa-pen-to-square', disabled: !!ds.busy || !ds.json })),
        rawBox,
    );
}

function itemRow(app, ds, key, item, d, types) {
    const imported = ds.imported.has(item.id);
    const check = h('input', { type: 'checkbox', checked: ds.chosen.has(item.id) || imported, disabled: imported,
        onchange: e => { if (e.target.checked) ds.chosen.add(item.id); else ds.chosen.delete(item.id); app.render(); } });
    return h(`div.tsrpg-design-item${imported ? '.imported' : ''}`, h('label', { title: '导入这一项' }, check), h('div.tsrpg-design-body', itemBody(app, key, item, d, types), imported ? h('small.tsrpg-muted', '已导入') : null));
}

function itemBody(app, key, item, d, types) {
    const allUnits = [...app.data.units, ...d.units];
    const typeName = id => types.unitTypes[id]?.name;
    if (key === 'unitTypes') {
        const color = item.color || '#78909c';
        const vs = Object.keys(item.vs).map(id => `→ ${typeName(id) || '?'}：${matchupLabel(matchup(types, { typeId: item.id }, { typeId: id }))}`);
        return [h('div.tsrpg-row', h('span.tsrpg-type-badge', { style: { background: color, color: contrast(color) } }, item.name), h('small.tsrpg-muted', item.desc)),
            vs.length ? h('small', vs.join('；')) : null];
    }
    if (key === 'terrains') {
        const bits = [`移动${item.moveCost}`, item.passable ? '' : item.flyable ? '仅飞行' : '不可通过', item.defBonus && `减伤${item.defBonus}%`, item.avoid && `闪避${item.avoid}%`,
            item.healPct && `回复${item.healPct}%`, (item.enterDamage || item.turnDamagePct) && '地形伤害', item.visionBonus && `视野${item.visionBonus > 0 ? '+' : ''}${item.visionBonus}`,
            item.conceal && `隐蔽${item.conceal}`, item.blockSight && '遮挡视线'].filter(Boolean);
        return [h('div.tsrpg-row', h('span.tsrpg-swatch', { style: { background: item.color, color: contrast(item.color) } }, item.symbol), h('b', item.name), h('small.tsrpg-muted', bits.join(' · '))),
            item.desc ? h('small.tsrpg-muted', item.desc) : null];
    }
    if (key === 'units') {
        const stats = item.kind === 'object' ? `HP ${item.hp} DEF ${item.def} MDEF ${item.mdef}`
            : `HP ${item.hp} ATK ${item.atk} MATK ${item.matk} DEF ${item.def} MDEF ${item.mdef} AGI ${item.agi} MOV ${item.mov} 射程 ${item.rangeMin}-${item.rangeMax} 韧性 ${item.tough} 视野 ${item.vision}`;
        return [
            h('div.tsrpg-row', renderToken({ ...item, maxHp: 0 }), h('b', item.name), h('span.tsrpg-tag', SIDE_NAMES[item.side]),
                item.kind === 'object' ? h('span.tsrpg-tag', '建筑') : null, item.keyTarget ? h('span.tsrpg-tag.key', '★ 关键目标') : null,
                typeName(item.typeId) ? h('span.tsrpg-tag', typeName(item.typeId)) : null,
                item.wb ? h('small.tsrpg-muted', h('i.fa-solid.fa-book'), ` ${item.wb.book} › ${item.wb.label}`) : null),
            h('small', stats),
            item.aliases ? h('small.tsrpg-muted', `又名：${item.aliases}`) : null,
            item.traits.map(t => h('small.tsrpg-muted', `特质【${t.name}】${t.desc || ''}`)),
            item.skills.map(sk => h('small.tsrpg-muted', `技能【${sk.name}】${skillSummary(sk)}${sk.desc ? `｜${sk.desc}` : ''}`)),
        ];
    }
    const terrains = new Map([...app.data.terrains, ...d.terrains].map(t => [t.id, t]));
    const unitById = new Map(allUnits.map(u => [u.id, u]));
    const board = renderBoard({
        w: item.w, h: item.h, tiles: item.tiles, cell: Math.min(26, app.cellFor(item.w, 340)),
        terrain: id => terrains.get(id) || { name: id, color: '#999' },
        units: item.placements.filter(p => unitById.has(p.unitId)).map(p => ({ ...unitById.get(p.unitId), x: p.x, y: p.y, maxHp: 0 })),
        marks: new Map(item.reinforcements.map(w => [`${w.x},${w.y}`, ['m-spawn']])),
    });
    const count = side => item.placements.filter(p => unitById.get(p.unitId)?.side === side && unitById.get(p.unitId)?.kind !== 'object').length;
    return [
        h('div.tsrpg-row', h('b', item.name), h('small.tsrpg-muted', `${item.w}×${item.h} · ${MISSION_NAMES[item.mission.type]}${item.mission.turns ? ` ${item.mission.turns} 回合` : ''}${item.fog.enabled ? ' · 战争迷雾' : ''} · 我方 ${count('player')} 友军 ${count('ally')} 敌方 ${count('enemy')}${item.reinforcements.length ? ` · 增援 ${item.reinforcements.length} 波` : ''}`)),
        item.desc ? h('small.tsrpg-muted', item.desc) : null,
        h('div.tsrpg-board-wrap', board),
    ];
}
