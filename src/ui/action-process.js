import { getBattle } from '../st.js';

/** 结算事件的可视化回放；只修改显示副本，不重新掷骰或写回战斗。 */
export function* actionFrames(before, after, events) {
    const state = structuredClone(before);
    const unit = uid => state.units.find(u => u.uid === uid);
    const effect = (u, cls, text = '') => u ? { uid: u.uid, x: u.x, y: u.y, cls, text } : null;
    const frame = (label, effects = [], area = [], duration = 1) => ({ battle: structuredClone(state), label, effects: effects.filter(Boolean), area, duration });
    function* hit(actorId, targetId, result, label) {
        const actor = unit(actorId), target = unit(targetId);
        if (!target || !result) return;
        yield frame(label, [effect(actor, 'm-acting'), effect(target, 'm-impact')]);
        target.hp = result.hpAfter;
        yield frame(label, [effect(target, result.reaction === 'defend' ? 'm-guard' : 'm-impact', result.hit === false || result.missed ? 'MISS' : `${result.hpAfter > result.hpBefore ? '+' : '−'}${Math.abs(result.hpAfter - result.hpBefore)}`)]);
    }
    for (const e of events.filter(Boolean)) {
        const actor = unit(e.actor?.uid);
        switch (e.type) {
            case 'move': {
                if (!actor) break;
                const path = e.path?.length ? e.path.slice(1) : [e.to];
                for (const point of path) {
                    actor.x = point.x; actor.y = point.y;
                    yield frame(`${actor.name} 移动`, [effect(actor, 'm-acting')], [], 0.65);
                }
                actor.moved = true;
                if (e.terrainDamage) yield* hit(null, actor.uid, e.terrainDamage, `${actor.name} 受到${e.terrain}伤害`);
                break;
            }
            case 'attack':
                if (e.firstStrike) yield* hit(e.target.uid, e.actor.uid, e.firstStrike, `${e.target.name} 先攻`);
                if (!e.cancelled) yield* hit(e.actor.uid, e.target.uid, e, `${e.actor.name} 攻击 ${e.target.name}${e.reaction === 'defend' ? '（防御）' : ''}`);
                if (e.counter) yield* hit(e.target.uid, e.actor.uid, e.counter, `${e.target.name} 反击`);
                if (actor) { actor.moved = true; actor.acted = true; }
                break;
            case 'skill': {
                yield frame(`${e.actor.name} 使用 ${e.skill.name}`, [effect(actor, 'm-acting')], e.area || []);
                if (e.teleport && actor) {
                    actor.x = e.teleport.to.x; actor.y = e.teleport.to.y;
                    yield frame(`${e.actor.name} 传送`, [effect(actor, 'm-acting')]);
                }
                const effects = [];
                for (const r of e.results) {
                    const target = unit(r.target.uid);
                    if (!target) continue;
                    for (const ef of r.effects || []) {
                        if (ef.type === 'recall' && ef.to) { target.x = ef.to.x; target.y = ef.to.y; }
                        if (ef.type === 'refresh' && !ef.failed) { target.acted = false; target.moved = false; }
                    }
                    target.hp = r.hpAfter;
                    const delta = r.hpAfter - r.hpBefore;
                    effects.push(effect(target, r.reaction === 'defend' ? 'm-guard' : 'm-impact', r.missed ? 'MISS' : delta ? `${delta > 0 ? '+' : '−'}${Math.abs(delta)}` : '效果'));
                }
                if (actor && !e.skill.quick) { actor.moved = true; actor.acted = true; }
                yield frame(`${e.skill.name} 命中${e.results.length}个目标`, effects, e.area || []);
                for (const r of e.results) {
                    if (r.counter) yield* hit(r.target.uid, e.actor.uid, r.counter, `${r.target.name} 反击`);
                }
                break;
            }
            case 'phase':
                state.phase = e.phase; state.turn = e.turn;
                for (const u of state.units) {
                    if (e.phase === 'player' || u.side === e.phase) { u.moved = false; u.acted = false; }
                }
                yield frame(`第 ${e.turn} 回合 · ${{ player: '我方', enemy: '敌方', ally: '友军' }[e.phase]}阶段`);
                break;
            case 'terrainDamage': case 'terrainHeal': case 'dot':
                if (actor) yield* hit(null, actor.uid, e, `${actor.name} ${e.type === 'terrainDamage' ? '受到地形伤害' : e.type === 'terrainHeal' ? '地形回复' : e.label || '持续效果'}`);
                break;
            case 'wait': case 'stunned':
                if (actor) actor.acted = true;
                yield frame(`${e.actor.name} ${e.type === 'wait' ? '待机' : '眩晕，无法行动'}`, [effect(actor, 'm-acting')]);
                break;
            case 'reinforce':
                for (const ref of e.units) {
                    const added = after.units.find(u => u.uid === ref.uid);
                    if (added && !unit(ref.uid)) state.units.push(structuredClone(added));
                }
                yield frame('增援进入战场', e.units.map(ref => effect(unit(ref.uid), 'm-acting')));
                break;
            case 'result':
                state.result = e.result; state.resultReason = e.reason;
                yield frame(e.result === 'victory' ? '战斗胜利' : '战斗失败');
                break;
        }
    }
}

export async function playBattleEvents(app, battle, before, events) {
    const ui = app.bs;
    if (app.settings.ui.animate === false || !events.length) return;
    ui.skipPlayback = false;
    try {
        for (const frame of actionFrames(before, battle, events)) {
            if (getBattle() !== battle || app.bs !== ui || ui.skipPlayback || app.settings.ui.animate === false || app.isOpen === false) break;
            ui.busy = frame.label;
            ui.playback = { ...frame, source: battle };
            app.render();
            const delay = Math.max(80, Math.min(1000, Number(app.settings.ui.actionDelay) || 260));
            await new Promise(resolve => setTimeout(resolve, delay * frame.duration));
        }
    } finally {
        ui.busy = null; ui.playback = null;
        if (app.bs === ui && getBattle() === battle) app.render();
    }
}
