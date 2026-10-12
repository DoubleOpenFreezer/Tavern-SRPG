// 设置页：描写模式、发送方式、战斗规则、注入、导入导出
import { h, clear, toast, button, select, field, numInput, textArea, checkbox, textDialog } from './dom.js';
import { CONTEXT_SECTIONS } from '../context.js';
import { MACROS } from '../llm.js';
import { getBattle } from '../st.js';
import { DEFAULT_HEADER, defaultSettings } from '../defaults.js';
import { normalizeSkill } from '../engine.js';

const EXPORT_KEYS = ['terrains', 'units', 'maps', 'rules', 'narration', 'send', 'inject'];

export function renderSettingsTab(app, root) {
    clear(root);
    const s = app.settings;
    const on = (obj, k, after) => v => { obj[k] = v; app.save(); after?.(); };

    root.append(
        h('div.tsrpg-section-title', '描写模式'),
        h('div.tsrpg-muted', '控制哪些战场变化需要 LLM 描写。关闭的项目不会出现在“需要描写”的列表中。'),
        h('div.tsrpg-checks',
            checkbox('描写移动 / 待机', s.narration.move, on(s.narration, 'move')),
            checkbox('描写普通攻击', s.narration.attack, on(s.narration, 'attack')),
            checkbox('描写技能释放', s.narration.skill, on(s.narration, 'skill')),
            checkbox('描写敌人行动', s.narration.enemy, on(s.narration, 'enemy')),
            checkbox('描写友军行动', s.narration.ally, on(s.narration, 'ally')),
            checkbox('描写回合切换 / 地形回复', s.narration.turn, on(s.narration, 'turn')),
            checkbox('描写增援出现', s.narration.reinforce, on(s.narration, 'reinforce')),
            checkbox('描写状态变化（中毒 / 持续恢复 / 眩晕 / 效果结束）', s.narration.status, on(s.narration, 'status')),
            checkbox('不描写的行动作为背景简要告知', s.narration.brief, on(s.narration, 'brief'), '开启后，未勾选描写的行动仍会以一句话告诉 LLM，避免它不知道发生了什么'),
        ),

        h('div.tsrpg-section-title', '发送方式'),
        h('div.tsrpg-grid2',
            field('棋盘操作后', select([
                ['preview', '弹出预览，确认后发送'],
                ['send', '直接以用户身份发送'],
                ['fill', '只填入输入框，由我手动发送'],
            ], s.send.mode, on(s.send, 'mode'))),
            h('div',
                checkbox('结束回合时自动整理发送', s.send.autoOnEndTurn, on(s.send, 'autoOnEndTurn')),
                checkbox('附带主输入框中的文字作为补充要求', s.send.includeInput, on(s.send, 'includeInput')),
            ),
        ),
        field('消息开头（给 LLM 的指令）', h('div',
            textArea(s.send.header, on(s.send, 'header'), 3),
            button('恢复默认', () => { s.send.header = DEFAULT_HEADER; app.save(); app.render(); }, { icon: 'fa-rotate-left' }))),

        h('div.tsrpg-section-title', '战斗规则'),
        h('div.tsrpg-grid4',
            field('伤害公式', select([['subtract', '减法：攻 − 防'], ['ratio', '比例：攻² ÷ (攻 + 防)']], s.rules.formula, on(s.rules, 'formula'))),
            field('伤害浮动 ±%', numInput(s.rules.variance, on(s.rules, 'variance'), { min: 0, max: 50 })),
            field('最低伤害', numInput(s.rules.minDamage, on(s.rules, 'minDamage'), { min: 0 })),
            h('div', checkbox('普通攻击触发反击', s.rules.counter, on(s.rules, 'counter'))),
        ),
        h('div.tsrpg-muted', '技能伤害＝(ATK 或 MATK)×威力% 代入公式。目标所在地形的减伤会在最后乘算。'),
        h('div.tsrpg-grid4',
            h('div', checkbox('启用命中判定', s.rules.hitEnabled, on(s.rules, 'hitEnabled'))),
            field('基础命中率 %', numInput(s.rules.baseHit, on(s.rules, 'baseHit'), { min: 0, max: 200 })),
            field('每点敏捷差 %', numInput(s.rules.agiFactor, on(s.rules, 'agiFactor'), { min: 0, max: 20 })),
        ),
        h('div.tsrpg-muted', '命中率＝基础命中 ＋（攻方AGI − 守方AGI）× 系数 ＋ 技能命中修正 − 守方地形闪避，限制在 0–100%。普通攻击、反击、伤害技能和对敌方的辅助技能都会判定；对友方的技能、攻击建筑物、必中技能一定命中。'),

        h('div.tsrpg-section-title', 'LLM 读取战场', h('div.tsrpg-spacer'),
            button('查看 LLM 看到的内容', () => previewContext(app), { icon: 'fa-eye' })),
        h('div.tsrpg-muted', '让 LLM 随时知道每个单位的 HP、状态、位置和地图，避免描写与棋盘对不上。有三种方式，可以同时使用。'),

        h('div.tsrpg-label', '① 自动注入：每次生成时附上战场信息'),
        h('div.tsrpg-grid4',
            h('div', checkbox('启用自动注入', s.inject.enabled, on(s.inject, 'enabled', () => app.updateInjection()))),
            field('注入位置', select([['chat', '聊天记录中（按深度）'], ['before', '主提示词之前'], ['after', '主提示词之后']], s.inject.position, on(s.inject, 'position', () => { app.updateInjection(); app.render(); }))),
            s.inject.position === 'chat' ? field('深度', numInput(s.inject.depth, on(s.inject, 'depth', () => app.updateInjection()), { min: 0, max: 50 }), '0＝最新消息之后') : h('div'),
            field('身份', select([['system', 'System'], ['user', 'User'], ['assistant', 'Assistant']], s.inject.role, on(s.inject, 'role', () => app.updateInjection()))),
        ),
        h('div.tsrpg-checks',
            Object.entries(CONTEXT_SECTIONS).map(([k, label]) => checkbox(label, s.inject[k], on(s.inject, k, () => app.updateInjection()))),
            checkbox('附带绑定的世界书条目内容', s.inject.includeWb, on(s.inject, 'includeWb', () => app.updateInjection()), '条目内容较长时会占用较多上下文'),
        ),
        h('div.tsrpg-row',
            h('span.tsrpg-label', '附带最近战斗记录（条）'),
            h('div', { style: { width: '80px' } }, numInput(s.inject.logLines, on(s.inject, 'logLines', () => app.updateInjection()), { min: 0, max: 50 })),
            h('small.tsrpg-muted', '0＝不附带。战斗过程已经写在聊天记录里，一般不需要。'),
        ),

        h('div.tsrpg-label', '② 宏：在提示词、角色卡、世界书、作者注释里手动放置'),
        h('div.tsrpg-macros', Object.entries(MACROS).map(([name, [desc]]) =>
            h('div', h('code', `{{${name}}}`), h('span.tsrpg-muted', ` ${desc}`))),
        h('div', h('code', '{{srpg_turn}}'), h('span.tsrpg-muted', ' 当前回合数'))),
        h('small.tsrpg-muted', '没有战斗时宏为空。如果用宏放置了完整信息，可以关闭自动注入，避免重复。'),

        h('div.tsrpg-label', '③ 函数调用：LLM 需要时自己查询'),
        h('div.tsrpg-row',
            checkbox('注册查询工具 SRPG_GetBattleState', s.tool.enabled, on(s.tool, 'enabled')),
            h('small.tsrpg-muted', '仅在战斗进行中可用。需要使用支持函数调用的 Chat Completion 接口，并在 AI 响应配置中开启「启用函数调用」。'),
        ),

        h('div.tsrpg-section-title', '界面'),
        h('div.tsrpg-grid3',
            field('格子大小（像素）', numInput(s.ui.cell, on(s.ui, 'cell', () => app.render()), { min: 20, max: 80 })),
        ),

        h('div.tsrpg-section-title', '导入 / 导出'),
        h('div.tsrpg-row',
            button('导出全部定义', () => exportData(s), { icon: 'fa-file-export' }),
            button('导入', () => importData(app), { icon: 'fa-file-import' }),
            button('恢复默认设置', () => {
                if (!confirm('这会清除所有自定义的单位、地形、地图和设置，确定吗？')) return;
                const d = defaultSettings();
                for (const k of Object.keys(d)) s[k] = d[k];
                app.save(); app.render();
            }, { icon: 'fa-triangle-exclamation', cls: 'danger' }),
        ),
    );
}

function exportData(s) {
    const data = { format: 'tavern-srpg', version: 1 };
    for (const k of EXPORT_KEYS) data[k] = s[k];
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `tavern-srpg-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function importData(app) {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (data.format !== 'tavern-srpg') throw new Error('不是 Tavern-SRPG 导出文件');
            const mode = confirm('点击“确定”覆盖现有定义；点击“取消”合并（同 ID 的条目会被覆盖）。');
            const s = app.settings;
            for (const k of EXPORT_KEYS) {
                if (!(k in data)) continue;
                if (Array.isArray(data[k])) {
                    if (mode) s[k] = data[k];
                    else {
                        const byId = new Map(s[k].map(x => [x.id, x]));
                        data[k].forEach(x => byId.set(x.id, x));
                        s[k] = [...byId.values()];
                    }
                } else if (data[k] && typeof data[k] === 'object') {
                    s[k] = { ...s[k], ...data[k] };
                }
            }
            for (const u of s.units || []) (u.skills || []).forEach(normalizeSkill);
            app.save(); app.render();
            toast('success', '导入完成');
        } catch (err) {
            toast('error', `导入失败：${err.message || err}`);
        }
    });
    input.click();
}

function previewContext(app) {
    const b = getBattle();
    if (!b?.active) {
        toast('info', '当前聊天没有进行中的战斗。先在「战场」页开始一场战斗。');
        return;
    }
    const text = app.battleContext();
    textDialog(app.panel, 'LLM 看到的战场信息', text, {
        note: `约 ${text.length} 字。这就是自动注入和 {{srpg}} 宏的内容（{{user}} {{char}} 等宏会在发送时替换）。`,
    });
}
