// 设置页：描写模式、发送方式、战斗规则、注入、导入导出
import { h, clear, toast, button, select, field, numInput, textArea, checkbox } from './dom.js';
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
        h('div.tsrpg-muted', '技能伤害＝(ATK 或 MATK)×威力% 代入公式；治疗量＝MATK×威力%。目标所在地形的减伤会在最后乘算。'),

        h('div.tsrpg-section-title', '战场状态注入'),
        h('div.tsrpg-muted', '每次生成时把当前棋盘（HP、位置、地形）作为系统提示注入聊天，让 LLM 在你自由输入文字时也不会搞错战况。'),
        h('div.tsrpg-grid3',
            h('div', checkbox('启用注入', s.inject.enabled, on(s.inject, 'enabled', () => app.updateInjection()))),
            field('注入深度', numInput(s.inject.depth, on(s.inject, 'depth', () => app.updateInjection()), { min: 0, max: 20 })),
            h('div', checkbox('附带绑定的世界书条目内容', s.inject.includeWb, on(s.inject, 'includeWb', () => app.updateInjection()), '条目内容较长时会占用较多上下文')),
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
