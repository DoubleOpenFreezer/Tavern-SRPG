// 战场页：开始战斗、棋盘操作、整理并发送给 LLM
import { h, clear, toast, button, select, renderBoard, textArea } from './dom.js';
import * as E from '../engine.js';
import { composeMessage, formatEvent, shouldNarrate, missionText, upcomingWaves } from '../narrator.js';
import * as ST from '../st.js';

const PHASE = { player: '我方阶段', enemy: '敌方阶段', ally: '友军阶段' };
const AI_NAMES = { aggressive: '主动出击', defensive: '原地迎击', stationary: '固守不动' };
const KIND = { physical: '物理', magical: '魔法', heal: '治疗' };

/** 战场交互状态（不持久化） */
export function newBattleUi() {
    return { sel: null, mode: 'idle', skillId: null, hover: null, undo: [], note: '', setupMap: null, showLog: false };
}

export function renderBattleTab(app, root) {
    clear(root);
    if (!ST.hasChat()) {
        root.append(h('div.tsrpg-empty', '请先打开一个角色或群组聊天。战斗进度会保存在当前聊天中。'));
        return;
    }
    const b = ST.getBattle();
    if (!b?.active) renderSetup(app, root);
    else renderActive(app, root, b);
}

// ---------------------------------------------------------------- 开战准备

function renderSetup(app, root) {
    const s = app.settings;
    const ui = app.bs;
    if (!s.maps.length) {
        root.append(h('div.tsrpg-empty', '还没有地图。请先在「地图」页创建地图并放置单位。'));
        return;
    }
    if (!s.maps.some(m => m.id === ui.setupMap)) ui.setupMap = s.maps[0].id;
    const map = s.maps.find(m => m.id === ui.setupMap);
    const terr = id => s.terrains.find(t => t.id === id) || { name: id, color: '#999' };
    const unitDefs = new Map(s.units.map(u => [u.id, u]));
    const placed = map.placements.filter(p => unitDefs.has(p.unitId));
    const units = placed.map(p => ({ ...unitDefs.get(p.unitId), x: p.x, y: p.y }));
    const counts = side => units.filter(u => u.side === side && u.kind !== 'object').length;
    const problems = E.validateMission(map, s.units);
    // 用一个临时战场生成任务说明与增援预告
    const preview = E.createBattle(map, s.units, s.terrains);
    const marks = new Map();
    for (const w of map.reinforcements || []) marks.set(`${w.x},${w.y}`, ['m-spawn']);

    root.append(
        h('div.tsrpg-row',
            h('b', '选择地图：'),
            select(s.maps.map(m => [m.id, `${m.name}（${m.w}×${m.h}）· ${E.MISSION_NAMES[m.mission?.type || 'annihilate']}`]), map.id, v => { ui.setupMap = v; app.render(); }),
            button('开始战斗', () => startBattle(app, map), { icon: 'fa-flag', cls: 'primary', disabled: problems.length > 0 }),
        ),
        h('div.tsrpg-mission', h('i.fa-solid.fa-bullseye'), ' ', missionText(preview)),
        upcomingWaves(preview) ? h('div.tsrpg-muted', h('i.fa-solid.fa-people-group'), ` 增援：${upcomingWaves(preview)}`) : null,
        map.desc ? h('div.tsrpg-desc', map.desc) : null,
        h('div.tsrpg-row.tsrpg-muted', `我方 ${counts('player')} · 友军 ${counts('ally')} · 敌方 ${counts('enemy')}`),
        problems.map(p => h('div.tsrpg-warn', h('i.fa-solid.fa-triangle-exclamation'), ` ${p}`)),
        h('div.tsrpg-board-wrap', renderBoard({ w: map.w, h: map.h, tiles: map.tiles, terrain: terr, units, marks, cell: Math.min(s.ui.cell, 32) })),
    );
}

function startBattle(app, map) {
    const s = app.settings;
    const problems = E.validateMission(map, s.units);
    if (problems.length) return toast('warning', problems.join('；'));
    const b = E.createBattle(map, s.units, s.terrains);
    b.pending.push({ type: 'mission', turn: 1, text: missionText(b) });
    b.pending.push({ type: 'phase', turn: 1, phase: 'player' });
    app.bs = newBattleUi();
    ST.setBattle(b);
    app.updateInjection();
    toast('success', `战斗开始：${map.name}`);
    app.render();
}

// ---------------------------------------------------------------- 战斗中

function selUnit(b, ui) {
    return ui.sel ? E.getUnit(b, ui.sel) : null;
}

function canControl(b, u) {
    return u && u.hp > 0 && u.side === 'player' && !u.object && !u.acted && b.phase === 'player' && !b.result;
}

function computeMarks(b, ui) {
    const marks = new Map();
    const add = (x, y, cls) => {
        const k = `${x},${y}`;
        if (!marks.has(k)) marks.set(k, []);
        marks.get(k).push(cls);
    };
    // 增援出现点：本回合结束时就会出现的用更醒目的样式
    for (const w of b.reinforcements || []) {
        const t = E.nextWaveTurn(b, w);
        if (t != null) add(w.x, w.y, t === b.turn ? 'm-spawn-soon' : 'm-spawn');
    }
    const u = selUnit(b, ui);
    if (!u || u.hp <= 0) return marks;
    add(u.x, u.y, 'm-sel');

    if (ui.mode === 'move' || ui.mode === 'inspect') {
        const reach = E.reachable(b, u);
        const reachCls = ui.mode === 'move' ? 'm-reach' : 'm-reach-foe';
        const threat = new Set();
        for (const n of reach.values()) {
            add(n.x, n.y, reachCls);
            for (const [tx, ty] of E.tilesInRange(b, n.x, n.y, u.rangeMin, u.rangeMax)) threat.add(`${tx},${ty}`);
        }
        for (const k of threat) {
            if (reach.has(k)) continue;
            const [x, y] = k.split(',').map(Number);
            add(x, y, 'm-threat');
        }
    }
    if (ui.mode === 'action' || ui.mode === 'attack') {
        for (const t of E.attackTargets(b, u)) add(t.x, t.y, 'm-target');
        if (ui.mode === 'attack') {
            for (const [x, y] of E.tilesInRange(b, u.x, u.y, u.rangeMin, u.rangeMax)) add(x, y, 'm-threat');
        }
    }
    if (ui.mode === 'skill') {
        const sk = u.skills.find(s => s.id === ui.skillId);
        if (sk) {
            for (const [x, y] of E.skillTargetTiles(b, u, sk)) add(x, y, sk.kind === 'heal' ? 'm-heal' : 'm-skill');
        }
    }
    return marks;
}

function pushUndo(app, b) {
    app.bs.undo.push(structuredClone(b));
    if (app.bs.undo.length > 30) app.bs.undo.shift();
}

function undo(app) {
    const snap = app.bs.undo.pop();
    if (!snap) return;
    ST.setBattle(snap);
    app.bs.sel = null; app.bs.mode = 'idle';
    app.updateInjection();
    app.render();
}

function afterAction(app, b, events) {
    for (const ev of events) if (ev) b.pending.push(ev);
    b.pending.push(...E.commit(b, null));
    app.bs.sel = null; app.bs.mode = 'idle'; app.bs.skillId = null;
    ST.saveBattle();
    app.updateInjection();
    if (b.result) {
        toast(b.result === 'victory' ? 'success' : 'error', b.result === 'victory' ? '战斗胜利！' : '战斗失败……');
    } else if (!E.alive(b).some(u => u.side === 'player' && !u.acted)) {
        toast('info', '我方单位均已行动，可以结束回合。');
    }
    app.render();
}

function act(app, b, fn) {
    try {
        pushUndo(app, b);
        const ev = fn();
        afterAction(app, b, Array.isArray(ev) ? ev : [ev]);
    } catch (err) {
        app.bs.undo.pop();
        toast('warning', err.message || String(err));
    }
}

function onCell(app, b, x, y) {
    const ui = app.bs;
    const u = selUnit(b, ui);
    const at = E.unitAt(b, x, y);
    const key = `${x},${y}`;

    if (ui.mode === 'move' && u) {
        const reach = E.reachable(b, u);
        if (reach.has(key)) {
            pushUndo(app, b);
            const ev = E.doMove(b, u, x, y);
            if (ev) b.pending.push(ev);
            ui.mode = 'action';
            ST.saveBattle();
            app.updateInjection();
            app.render();
            return;
        }
    }
    if ((ui.mode === 'action' || ui.mode === 'attack') && u && at && E.isFoe(at, u)) {
        if (E.attackTargets(b, u).includes(at)) {
            act(app, b, () => E.doAttack(b, u, at, app.settings.rules));
            return;
        }
    }
    if (ui.mode === 'skill' && u) {
        const sk = u.skills.find(s => s.id === ui.skillId);
        if (sk && E.skillTargetTiles(b, u, sk).some(([tx, ty]) => tx === x && ty === y)) {
            act(app, b, () => E.doSkill(b, u, sk, x, y, app.settings.rules));
            return;
        }
        ui.mode = 'action'; ui.skillId = null;
        app.render();
        return;
    }
    if (ui.mode === 'action' || ui.mode === 'attack') {
        // 已移动的单位必须先选择行动（或撤销移动）
        if (ui.mode === 'attack') { ui.mode = 'action'; app.render(); }
        return;
    }
    if (at) {
        ui.sel = at.uid;
        ui.mode = canControl(b, at) ? (at.moved ? 'action' : 'move') : 'inspect';
    } else {
        ui.sel = null; ui.mode = 'idle';
    }
    app.render();
}

function onHover(app, b, x, y, refs) {
    const ui = app.bs;
    if (ui.hover && ui.hover[0] === x && ui.hover[1] === y) return;
    ui.hover = [x, y];
    const u = selUnit(b, ui);
    // 范围技能：高亮影响区域
    refs.board.querySelectorAll('.m-area').forEach(c => c.classList.remove('m-area'));
    let preview = '';
    if (u && ui.mode === 'skill') {
        const sk = u.skills.find(s => s.id === ui.skillId);
        if (sk && E.skillTargetTiles(b, u, sk).some(([tx, ty]) => tx === x && ty === y)) {
            for (const [ax, ay] of E.tilesInRange(b, x, y, 0, Number(sk.radius) || 0)) {
                refs.board.querySelector(`[data-x="${ax}"][data-y="${ay}"]`)?.classList.add('m-area');
            }
            const aff = E.skillAffected(b, u, sk, x, y);
            preview = aff.map(t => sk.kind === 'heal'
                ? `${t.name} +${E.calcHeal(u, t, sk.power, app.settings.rules, Math.random, true)}`
                : `${t.name} -${E.calcDamage(b, u, t, sk.kind, sk.power, app.settings.rules, Math.random, true)}`).join('，');
            if (preview) preview = `【${sk.name}】预计：${preview}`;
        }
    }
    const at = E.unitAt(b, x, y);
    if (u && at && E.isFoe(at, u) && (ui.mode === 'action' || ui.mode === 'attack') && E.attackTargets(b, u).includes(at)) {
        const p = E.previewAttack(b, u, at, app.settings.rules);
        preview = `攻击 ${at.name}：预计造成 ${p.damage} 伤害${p.damage >= at.hp ? '（击败）' : ''}${p.counter ? `，受到反击 ${p.counter}` : ''}`;
    }
    refs.preview.textContent = preview || '';
    clear(refs.hoverInfo);
    const show = at && at !== u ? at : null;
    if (show) refs.hoverInfo.append(unitCard(b, show, true));
    else {
        const t = E.terrainAt(b, x, y);
        refs.hoverInfo.append(h('div.tsrpg-muted', `(${x + 1},${y + 1}) ${t.name}${t.defBonus ? ` 减伤${t.defBonus}%` : ''}${t.healPct ? ` 回复${t.healPct}%` : ''}${t.passable === false ? ' 不可步行' : ''} ${t.desc || ''}`));
        for (const w of b.reinforcements || []) {
            const turn = E.nextWaveTurn(b, w);
            if (w.x !== x || w.y !== y || turn == null) continue;
            refs.hoverInfo.append(h('div.tsrpg-warn', `增援出现点：第 ${turn} 回合结束时 ${b.unitDefs?.[w.unitId]?.name || '?'}×${w.count || 1}${Number(w.every) ? `，之后每 ${w.every} 回合一次` : ''}`));
        }
    }
}

function unitCard(b, u, compact = false) {
    const t = E.terrainAt(b, u.x, u.y);
    const pct = Math.round((u.hp / u.maxHp) * 100);
    return h(`div.tsrpg-card.side-${u.side}`,
        h('div.tsrpg-card-title', h('b', u.name), h('span.tsrpg-tag', E.SIDE_NAMES[u.side]),
            u.object ? h('span.tsrpg-tag', '建筑') : null,
            u.keyTarget ? h('span.tsrpg-tag.key', '★ 关键目标') : null,
            u.acted && !u.object ? h('span.tsrpg-tag', '已行动') : null,
            u.hp <= 0 ? h('span.tsrpg-tag.dead', u.object ? '已摧毁' : '已击败') : null),
        h('div.tsrpg-hp', h('div', { style: { width: `${pct}%` } }), h('span', `HP ${u.hp}/${u.maxHp}`)),
        statGrid(u),
        compact ? null : h('div.tsrpg-muted', u.object
            ? `不会行动 · 位于${t.name}(${u.x + 1},${u.y + 1})`
            : `${KIND[u.atkType]}攻击${u.flying ? ' · 飞行' : ''}${u.side !== 'player' ? ` · ${AI_NAMES[u.ai] || u.ai}` : ''} · 位于${t.name}(${u.x + 1},${u.y + 1})`),
        !compact && u.skills.length ? h('div.tsrpg-skills', u.skills.map(sk =>
            h('div.tsrpg-muted', `【${sk.name}】${KIND[sk.kind]} ${sk.power}% 射程${sk.rangeMin}-${sk.rangeMax}${sk.radius ? ` 范围${sk.radius}` : ''}${sk.uses ? ` 剩余${sk.usesLeft}/${sk.uses}` : ''}`))) : null,
        u.wb ? h('div.tsrpg-muted', h('i.fa-solid.fa-book'), ` ${u.wb.book} › ${u.wb.label}`) : null,
    );
}

function statGrid(u) {
    if (u.object) {
        return h('div.tsrpg-stats', [['DEF', u.def], ['MDEF', u.mdef]].map(([k, v]) => h('div', h('small', k), h('b', String(v)))));
    }
    return h('div.tsrpg-stats',
        [['ATK', u.atk], ['MATK', u.matk], ['DEF', u.def], ['MDEF', u.mdef], ['MOV', u.mov],
            ['射程', u.rangeMin === u.rangeMax ? u.rangeMax : `${u.rangeMin}-${u.rangeMax}`]]
            .map(([k, v]) => h('div', h('small', k), h('b', String(v)))));
}

function actionPanel(app, b, u) {
    const ui = app.bs;
    if (!u || u.side !== 'player' || u.object || b.phase !== 'player' || b.result) return null;
    if (ui.mode === 'move') {
        return h('div.tsrpg-actions',
            h('div.tsrpg-muted', '点击蓝色格子移动（点击自身＝原地行动）。'),
            button('原地行动', () => { pushUndo(app, b); ui.mode = 'action'; u.moved = true; app.render(); }, { icon: 'fa-hand' }),
        );
    }
    if (!['action', 'attack', 'skill'].includes(ui.mode)) return null;
    const targets = E.attackTargets(b, u);
    return h('div.tsrpg-actions',
        button(`攻击${targets.length ? `(${targets.length})` : ''}`, () => { ui.mode = 'attack'; app.render(); },
            { icon: 'fa-khanda', disabled: !targets.length, cls: ui.mode === 'attack' ? 'active' : '' }),
        u.skills.map(sk => {
            const tiles = E.skillTargetTiles(b, u, sk);
            const ok = E.skillUsable(sk) && tiles.length;
            return button(`${sk.name}${sk.uses ? ` ${sk.usesLeft}/${sk.uses}` : ''}`, () => { ui.mode = 'skill'; ui.skillId = sk.id; app.render(); },
                { icon: sk.kind === 'heal' ? 'fa-heart' : 'fa-wand-sparkles', disabled: !ok, cls: ui.mode === 'skill' && ui.skillId === sk.id ? 'active' : '', title: sk.desc });
        }),
        button('待机', () => act(app, b, () => E.doWait(b, u)), { icon: 'fa-hourglass' }),
        button('撤销移动', () => undo(app), { icon: 'fa-rotate-left', disabled: !ui.undo.length }),
    );
}

/** 战斗中允许修改世界书绑定：把单位定义里的绑定同步到战场单位 */
function syncBindings(s, b) {
    const defs = new Map(s.units.map(u => [u.id, u]));
    let changed = false;
    for (const u of b.units) {
        const d = defs.get(u.defId);
        if (!d) continue;
        if (JSON.stringify(d.wb || null) !== JSON.stringify(u.wb || null)) {
            u.wb = d.wb ? structuredClone(d.wb) : null;
            changed = true;
        }
    }
    if (changed) { ST.saveBattle(); }
    return changed;
}

function renderActive(app, root, b) {
    const s = app.settings;
    const ui = app.bs;
    if (syncBindings(s, b)) app.updateInjection();
    const u = selUnit(b, ui);
    if (u && u.hp <= 0) { ui.sel = null; ui.mode = 'idle'; }

    const status = b.result
        ? h(`span.tsrpg-result.${b.result}`, b.result === 'victory' ? '胜利' : '战败')
        : h('span.tsrpg-tag', PHASE[b.phase] || b.phase);
    const left = E.alive(b).filter(x => x.side === 'player' && !x.object && !x.acted).length;

    const refs = {};
    refs.preview = h('div.tsrpg-preview');
    refs.hoverInfo = h('div.tsrpg-hoverinfo');
    refs.board = renderBoard({
        w: b.w, h: b.h, tiles: b.tiles, cell: s.ui.cell,
        terrain: id => b.terrains[id] || { name: id, color: '#999' },
        units: E.alive(b),
        marks: computeMarks(b, ui),
        selected: ui.sel,
        onCell: (x, y) => onCell(app, b, x, y),
        onHover: (x, y) => onHover(app, b, x, y, refs),
        onContext: () => { ui.sel = null; ui.mode = 'idle'; app.render(); },
    });

    const pending = b.pending.filter(e => e.type !== 'phase' || b.pending.length > 1);
    const pendingList = h('div.tsrpg-events', pending.length
        ? pending.map(e => h(`div.tsrpg-event${shouldNarrate(e, s.narration) ? '' : '.muted'}`, formatEvent(e)))
        : h('div.tsrpg-muted', '暂无待发送的行动。'));

    const noteBox = textArea(ui.note, v => { ui.note = v; }, 2, '补充要求（可选）：例如“着重描写骑士的心理”。会和战斗结果一起发送。');
    noteBox.addEventListener('input', e => { ui.note = e.target.value; });

    const sendLabel = { send: '发送给 LLM', fill: '填入输入框', preview: '预览并发送' }[s.send.mode];

    root.append(
        h('div.tsrpg-row.tsrpg-topbar',
            h('b', b.mapName), h('span', `第 ${b.turn} 回合`), status,
            b.phase === 'player' && !b.result ? h('span.tsrpg-muted', `待行动 ${left}`) : null,
            h('div.tsrpg-spacer'),
            button('撤销', () => undo(app), { icon: 'fa-rotate-left', disabled: !ui.undo.length, title: '撤销上一步操作' }),
            button('结束回合', () => endTurn(app, b), { icon: 'fa-forward', cls: 'primary', disabled: !!b.result || b.phase !== 'player' }),
            button('', () => endBattle(app), { icon: 'fa-flag-checkered', title: '结束 / 放弃战斗' }),
        ),
        h('div.tsrpg-mission',
            h('i.fa-solid.fa-bullseye'), ' ', b.result ? `${b.result === 'victory' ? '胜利' : '战败'}：${b.resultReason || ''}` : missionText(b),
            !b.result && upcomingWaves(b) ? h('div.tsrpg-muted', h('i.fa-solid.fa-people-group'), ` 增援：${upcomingWaves(b)}`) : null),
        h('div.tsrpg-battle',
            h('div.tsrpg-board-wrap', refs.board),
            h('div.tsrpg-side',
                u ? unitCard(b, u) : h('div.tsrpg-muted', '点击我方单位选择，右键取消。红色区域为可攻击范围。'),
                actionPanel(app, b, u),
                refs.preview,
                refs.hoverInfo,
                h('div.tsrpg-section-title', '待发送的行动', h('small.tsrpg-muted', '（灰色＝按设置不描写）')),
                pendingList,
                noteBox,
                h('div.tsrpg-row',
                    button(sendLabel, () => dispatch(app, b), { icon: 'fa-paper-plane', cls: 'primary' }),
                    button('清空', () => { b.pending = []; ST.saveBattle(); app.render(); }, { icon: 'fa-eraser', disabled: !b.pending.length, title: '丢弃待发送的行动（棋盘不变）' }),
                ),
                h('details.tsrpg-log', { open: ui.showLog, ontoggle: e => { ui.showLog = e.target.open; } },
                    h('summary', `战斗记录（${b.log.length}）`),
                    h('div.tsrpg-events', b.log.slice(-80).map(l => h('div.tsrpg-event', l)))),
            ),
        ),
    );
}

function endTurn(app, b) {
    const left = E.alive(b).filter(x => x.side === 'player' && !x.object && !x.acted).length;
    if (left && !confirm(`还有 ${left} 个我方单位未行动，确定结束回合吗？`)) return;
    const events = E.endPlayerPhase(b, app.settings.rules);
    b.pending.push(...events);
    app.bs.undo = [];
    app.bs.sel = null; app.bs.mode = 'idle';
    ST.saveBattle();
    app.updateInjection();
    if (b.result) toast(b.result === 'victory' ? 'success' : 'error', b.result === 'victory' ? '战斗胜利！' : '战斗失败……');
    app.render();
    if (app.settings.send.autoOnEndTurn) dispatch(app, b);
}

function endBattle(app) {
    if (!confirm('结束当前战斗？棋盘状态将被清除（聊天记录不受影响）。')) return;
    ST.setBattle(null);
    app.bs = newBattleUi();
    app.updateInjection();
    app.render();
}

// ---------------------------------------------------------------- 发送

export function dispatch(app, b, forceMode) {
    const s = app.settings;
    if (!b.pending.length && !app.bs.note.trim()) {
        toast('info', '没有需要发送的内容。');
        return;
    }
    let note = app.bs.note;
    if (s.send.includeInput) {
        const main = ST.readMainInput().trim();
        if (main) note = [note.trim(), main].filter(Boolean).join('\n');
    }
    const text = composeMessage(b, b.pending, s, note);
    const mode = forceMode || s.send.mode;
    if (mode === 'preview') return showPreview(app, b, text);
    deliver(app, b, text, mode);
}

function deliver(app, b, text, mode) {
    if (mode === 'send' && ST.isGenerating()) {
        toast('warning', 'LLM 正在生成中，请稍后再发送。');
        return false;
    }
    if (mode === 'send') ST.sendAsUser(text);
    else ST.writeMainInput(text);
    b.log.push(...b.pending.map(formatEvent).filter(Boolean));
    if (b.log.length > 300) b.log.splice(0, b.log.length - 300);
    b.pending = [];
    app.bs.note = '';
    ST.saveBattle();
    app.render();
    return true;
}

function showPreview(app, b, text) {
    const ta = h('textarea.text_pole.tsrpg-preview-text', { rows: 14, value: text });
    const overlay = h('div.tsrpg-overlay',
        h('div.tsrpg-dialog',
            h('div.tsrpg-section-title', '发送预览（可编辑）'),
            ta,
            h('div.tsrpg-row',
                button('发送', () => { if (deliver(app, b, ta.value, 'send')) overlay.remove(); }, { icon: 'fa-paper-plane', cls: 'primary' }),
                button('填入输入框', () => { deliver(app, b, ta.value, 'fill'); overlay.remove(); }, { icon: 'fa-keyboard' }),
                button('取消', () => overlay.remove(), { icon: 'fa-xmark' }),
            ),
        ));
    app.panel.append(overlay);
    ta.focus();
}
