// 战斗引擎：纯逻辑，不依赖 SillyTavern / DOM，可在 node 中测试
// 坐标从 0 开始，对外描述时 +1

const IMPASSABLE = Infinity;

export const SIDE_NAMES = { player: '我方', enemy: '敌方', ally: '友军' };

export function team(u) {
    return u.side === 'enemy' ? 'E' : 'P';
}

export function isFoe(a, b) {
    return team(a) !== team(b);
}

export function dist(ax, ay, bx, by) {
    return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function inBounds(b, x, y) {
    return x >= 0 && y >= 0 && x < b.w && y < b.h;
}

export function terrainAt(b, x, y) {
    const id = b.tiles[y * b.w + x];
    return b.terrains[id] || { id, name: id || '未知', moveCost: 1, passable: true, flyable: true, defBonus: 0, healPct: 0, desc: '' };
}

export function alive(b) {
    return b.units.filter(u => u.hp > 0);
}

export function unitAt(b, x, y) {
    return b.units.find(u => u.hp > 0 && u.x === x && u.y === y) || null;
}

export function getUnit(b, uid) {
    return b.units.find(u => u.uid === uid) || null;
}

/** 单位进入某格的消耗，不可进入返回 Infinity */
export function enterCost(b, unit, x, y) {
    const t = terrainAt(b, x, y);
    if (unit.flying) return t.flyable === false ? IMPASSABLE : 1;
    if (t.passable === false) return IMPASSABLE;
    return Math.max(1, Number(t.moveCost) || 1);
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 最小堆（按 key 取最小） */
class Heap {
    constructor(key) { this.a = []; this.key = key; }
    get size() { return this.a.length; }
    push(v) {
        const a = this.a; a.push(v);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.key(a[p]) <= this.key(a[i])) break;
            [a[p], a[i]] = [a[i], a[p]]; i = p;
        }
    }
    pop() {
        const a = this.a, top = a[0], last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1, r = l + 1;
                let m = i;
                if (l < a.length && this.key(a[l]) < this.key(a[m])) m = l;
                if (r < a.length && this.key(a[r]) < this.key(a[m])) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]]; i = m;
            }
        }
        return top;
    }
}

/**
 * 计算可到达的格子（Dijkstra）。敌对单位阻挡通行，友方可穿过但不能停留。
 * @returns {Map<string,{x:number,y:number,cost:number,prev:string|null}>} 仅包含可停留的格子
 */
export function reachable(b, unit, maxMove = unit.mov) {
    const start = `${unit.x},${unit.y}`;
    const best = new Map([[start, { x: unit.x, y: unit.y, cost: 0, prev: null }]]);
    const queue = new Heap(n => n.cost);
    queue.push(best.get(start));
    while (queue.size) {
        const cur = queue.pop();
        if (cur.cost > (best.get(`${cur.x},${cur.y}`)?.cost ?? Infinity)) continue;
        for (const [dx, dy] of DIRS) {
            const nx = cur.x + dx, ny = cur.y + dy;
            if (!inBounds(b, nx, ny)) continue;
            const occ = unitAt(b, nx, ny);
            if (occ && occ !== unit && isFoe(occ, unit)) continue;
            const c = cur.cost + enterCost(b, unit, nx, ny);
            if (c > maxMove) continue;
            const key = `${nx},${ny}`;
            if (c < (best.get(key)?.cost ?? Infinity)) {
                const node = { x: nx, y: ny, cost: c, prev: `${cur.x},${cur.y}` };
                best.set(key, node);
                queue.push(node);
            }
        }
    }
    // 移除被其他单位占据的格子（可穿过但不可停留）
    for (const [key, node] of best) {
        const occ = unitAt(b, node.x, node.y);
        if (occ && occ !== unit) best.delete(key);
    }
    return best;
}

/** 以若干目标格为源，对某单位的移动方式计算距离场（忽略单位阻挡），用于 AI 接近目标 */
export function distanceField(b, unit, sources) {
    const field = new Array(b.w * b.h).fill(Infinity);
    const queue = new Heap(n => n[2]);
    for (const [x, y] of sources) {
        field[y * b.w + x] = 0;
        queue.push([x, y, 0]);
    }
    while (queue.size) {
        const [x, y, d] = queue.pop();
        if (d > field[y * b.w + x]) continue;
        // 反向扩展：从邻格 n 走到 (x,y) 的代价是进入 (x,y) 的代价；源格（目标所在格）只需相邻即可
        const step = d === 0 ? 1 : enterCost(b, unit, x, y);
        if (!isFinite(step)) continue;
        for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (!inBounds(b, nx, ny)) continue;
            if (!isFinite(enterCost(b, unit, nx, ny))) continue;
            const nd = d + step;
            if (nd < field[ny * b.w + nx]) {
                field[ny * b.w + nx] = nd;
                queue.push([nx, ny, nd]);
            }
        }
    }
    return field;
}

export function tilesInRange(b, x, y, min, max) {
    const out = [];
    for (let dy = -max; dy <= max; dy++) {
        for (let dx = -max; dx <= max; dx++) {
            const d = Math.abs(dx) + Math.abs(dy);
            if (d < min || d > max) continue;
            const nx = x + dx, ny = y + dy;
            if (inBounds(b, nx, ny)) out.push([nx, ny]);
        }
    }
    return out;
}

export function skillUsable(skill) {
    return !skill.uses || skill.usesLeft > 0;
}

// ---------------------------------------------------------------- 伤害计算

function roll(rules, rng) {
    const v = Math.max(0, Number(rules.variance) || 0);
    if (!v) return 1;
    return 1 + ((rng() * 2 - 1) * v) / 100;
}

/**
 * @param {'physical'|'magical'} kind
 * @param {number} power 百分比
 * @param {boolean} expected 为 true 时不计算随机浮动（用于预览和 AI）
 */
export function calcDamage(b, attacker, defender, kind, power, rules, rng = Math.random, expected = false) {
    const atk = (kind === 'magical' ? attacker.matk : attacker.atk) * (power / 100);
    const def = kind === 'magical' ? defender.mdef : defender.def;
    let dmg;
    if (rules.formula === 'ratio') {
        dmg = atk <= 0 ? 0 : (atk * atk) / (atk + Math.max(0, def));
    } else {
        dmg = atk - def;
    }
    const t = terrainAt(b, defender.x, defender.y);
    dmg *= 1 - (Number(t.defBonus) || 0) / 100;
    if (!expected) dmg *= roll(rules, rng);
    return Math.max(Number(rules.minDamage ?? 1), Math.round(dmg));
}

export function calcHeal(caster, target, power, rules, rng = Math.random, expected = false) {
    let v = caster.matk * (power / 100);
    if (!expected) v *= roll(rules, rng);
    v = Math.max(1, Math.round(v));
    return Math.min(v, target.maxHp - target.hp);
}

function applyDamage(u, dmg) {
    const before = u.hp;
    u.hp = Math.max(0, u.hp - dmg);
    return { hpBefore: before, hpAfter: u.hp, killed: before > 0 && u.hp === 0 };
}

function ref(u) {
    return { uid: u.uid, name: u.name, side: u.side, wbKey: u.wb?.keys?.[0] || '', object: !!u.object, keyTarget: !!u.keyTarget };
}

function canCounter(b, defender, attacker) {
    if (defender.hp <= 0 || defender.object || defender.noCounter) return false;
    const d = dist(defender.x, defender.y, attacker.x, attacker.y);
    return d >= defender.rangeMin && d <= defender.rangeMax;
}

// ---------------------------------------------------------------- 行动

export function doMove(b, unit, x, y) {
    const reach = reachable(b, unit);
    const node = reach.get(`${x},${y}`);
    if (!node) throw new Error('无法移动到该位置');
    const from = { x: unit.x, y: unit.y };
    unit.x = x; unit.y = y;
    unit.moved = true;
    if (from.x === x && from.y === y) return null;
    return {
        type: 'move', turn: b.turn, actor: ref(unit),
        from, to: { x, y },
        terrain: terrainAt(b, x, y).name,
        fromTerrain: terrainAt(b, from.x, from.y).name,
    };
}

export function attackTargets(b, unit, fromX = unit.x, fromY = unit.y) {
    return alive(b).filter(t => isFoe(t, unit) && (() => {
        const d = dist(fromX, fromY, t.x, t.y);
        return d >= unit.rangeMin && d <= unit.rangeMax;
    })());
}

export function previewAttack(b, unit, target, rules) {
    const dmg = calcDamage(b, unit, target, unit.atkType, 100, rules, Math.random, true);
    let counter = 0;
    if (rules.counter && target.hp - dmg > 0 && canCounter(b, target, unit)) {
        counter = calcDamage(b, target, unit, target.atkType, 100, rules, Math.random, true);
    }
    return { damage: dmg, counter };
}

export function doAttack(b, unit, target, rules, rng = Math.random) {
    const d = dist(unit.x, unit.y, target.x, target.y);
    if (!isFoe(unit, target) || target.hp <= 0 || d < unit.rangeMin || d > unit.rangeMax) {
        throw new Error('目标不在攻击范围内');
    }
    const dmg = calcDamage(b, unit, target, unit.atkType, 100, rules, rng);
    const hit = applyDamage(target, dmg);
    const ev = {
        type: 'attack', turn: b.turn, actor: ref(unit), target: ref(target),
        atkType: unit.atkType, damage: dmg, ...hit,
        terrain: terrainAt(b, target.x, target.y).name,
        counter: null,
    };
    if (rules.counter && canCounter(b, target, unit)) {
        const cdmg = calcDamage(b, target, unit, target.atkType, 100, rules, rng);
        ev.counter = { atkType: target.atkType, damage: cdmg, ...applyDamage(unit, cdmg) };
    }
    unit.acted = true; unit.moved = true;
    return ev;
}

/** 技能的目标格是否合法（会有至少一个受影响单位） */
export function skillAffected(b, unit, skill, tx, ty) {
    const r = Number(skill.radius) || 0;
    return alive(b).filter(t => {
        if (dist(tx, ty, t.x, t.y) > r) return false;
        return skill.kind === 'heal' ? !isFoe(t, unit) : isFoe(t, unit);
    });
}

export function skillTargetTiles(b, unit, skill, fromX = unit.x, fromY = unit.y) {
    return tilesInRange(b, fromX, fromY, Number(skill.rangeMin) || 0, Number(skill.rangeMax) || 0)
        .filter(([x, y]) => {
            if ((Number(skill.radius) || 0) > 0) return true;
            const aff = skillAffected(b, unit, skill, x, y);
            // 单体治疗只能对受伤的友方使用
            return skill.kind === 'heal' ? aff.some(t => t.hp < t.maxHp) : aff.length > 0;
        });
}

export function doSkill(b, unit, skill, tx, ty, rules, rng = Math.random) {
    if (!skillUsable(skill)) throw new Error('技能次数已用尽');
    const d = dist(unit.x, unit.y, tx, ty);
    if (d < (Number(skill.rangeMin) || 0) || d > (Number(skill.rangeMax) || 0)) throw new Error('目标不在技能范围内');
    const affected = skillAffected(b, unit, skill, tx, ty);
    if (!affected.length) throw new Error('该位置没有可作用的目标');
    const results = affected.map(t => {
        if (skill.kind === 'heal') {
            const amount = calcHeal(unit, t, skill.power, rules, rng);
            const before = t.hp;
            t.hp += amount;
            return { target: ref(t), heal: amount, hpBefore: before, hpAfter: t.hp, killed: false };
        }
        const dmg = calcDamage(b, unit, t, skill.kind, skill.power, rules, rng);
        return { target: ref(t), damage: dmg, terrain: terrainAt(b, t.x, t.y).name, ...applyDamage(t, dmg) };
    });
    if (skill.uses) skill.usesLeft = Math.max(0, (skill.usesLeft ?? skill.uses) - 1);
    unit.acted = true; unit.moved = true;
    return {
        type: 'skill', turn: b.turn, actor: ref(unit),
        skill: { name: skill.name, kind: skill.kind, desc: skill.desc || '' },
        at: { x: tx, y: ty }, results,
    };
}

export function doWait(b, unit) {
    unit.acted = true; unit.moved = true;
    return { type: 'wait', turn: b.turn, actor: ref(unit), terrain: terrainAt(b, unit.x, unit.y).name };
}

// ---------------------------------------------------------------- 任务与胜负

export const MISSION_NAMES = { annihilate: '歼灭战', defend: '守城战', assault: '进攻战' };

export function missionOf(b) {
    return b.mission || { type: 'annihilate', turns: 0 };
}

/** 守城战中需要保护的目标：我方 / 友军的关键目标 */
export function guardTargets(b) {
    return b.units.filter(u => u.keyTarget && team(u) === 'P');
}

/** 进攻战中需要破坏的目标：敌方的关键目标 */
export function enemyKeyTargets(b) {
    return b.units.filter(u => u.keyTarget && u.side === 'enemy');
}

/** 某个增援波次下一次出现的回合（null 表示不再出现） */
export function nextWaveTurn(b, w) {
    const fired = b.reinfFired?.[w.id] || 0;
    const every = Math.max(0, Number(w.every) || 0);
    const times = Math.max(0, Number(w.times) || 0);
    const start = Math.max(1, Number(w.startTurn) || 1);
    if (every === 0 && fired > 0) return null;
    if (every > 0 && times > 0 && fired >= times) return null;
    return Math.max(b.turn, start + fired * every);
}

export function wavesRemaining(b, side = 'enemy') {
    return (b.reinforcements || []).some(w => w.side === side && nextWaveTurn(b, w) != null);
}

/** @returns {{result:'victory'|'defeat', reason:string}|null} */
export function checkResult(b) {
    const m = missionOf(b);
    const units = alive(b);
    if (!units.some(u => u.side === 'player' && !u.object)) return { result: 'defeat', reason: '我方全军覆没' };
    if (m.type === 'defend') {
        const lost = guardTargets(b).find(u => u.hp <= 0);
        if (lost) return { result: 'defeat', reason: `守卫目标「${lost.name}」被摧毁` };
    }
    if (m.type === 'assault') {
        const keys = enemyKeyTargets(b);
        if (keys.length && keys.every(u => u.hp <= 0)) {
            return { result: 'victory', reason: `敌方关键目标${keys.map(k => `「${k.name}」`).join('')}已全部被摧毁` };
        }
    } else if (!units.some(u => u.side === 'enemy' && !u.object) && !wavesRemaining(b)) {
        return { result: 'victory', reason: '所有敌人都被击败' };
    }
    return null;
}

/** 回合结束时的回合数判定 */
function checkTurnLimit(b) {
    const m = missionOf(b);
    const n = Number(m.turns) || 0;
    if (!n || b.turn < n) return null;
    if (m.type === 'defend') return { result: 'victory', reason: `成功坚守了 ${n} 回合` };
    return { result: 'defeat', reason: `未能在 ${n} 回合内${m.type === 'assault' ? '摧毁关键目标' : '歼灭敌人'}` };
}

function setResult(b, r, events) {
    if (!r || b.result) return;
    b.result = r.result;
    b.resultReason = r.reason;
    events.push({ type: 'result', turn: b.turn, result: r.result, reason: r.reason });
}

function finish(b, events) {
    setResult(b, checkResult(b), events);
    return b.result;
}

/** 包装玩家行动：执行后自动检测胜负 */
export function commit(b, ev) {
    const events = ev ? [ev] : [];
    finish(b, events);
    return events;
}

// ---------------------------------------------------------------- AI

/**
 * 在 (x,y) 位置能做出的最佳行动
 * @param {(t:object)=>boolean} filter 伤害类行动必须命中至少一个满足条件的目标
 * @param {boolean} heal 只考虑治疗技能
 */
function bestActionAt(b, unit, x, y, rules, filter, heal) {
    const ox = unit.x, oy = unit.y;
    unit.x = x; unit.y = y;
    let best = null;
    const consider = (cand) => { if (cand.score > 0 && (!best || cand.score > best.score)) best = cand; };
    if (!heal) {
        for (const t of attackTargets(b, unit).filter(filter)) {
            const dmg = calcDamage(b, unit, t, unit.atkType, 100, rules, Math.random, true);
            let score = 1 + Math.min(dmg, t.hp) + (dmg >= t.hp ? 100 : 0);
            if (rules.counter && dmg < t.hp && canCounter(b, t, unit)) {
                score -= calcDamage(b, t, unit, t.atkType, 100, rules, Math.random, true) * 0.3;
            }
            consider({ kind: 'attack', x, y, target: t, score: Math.max(0.5, score) });
        }
    }
    for (const sk of unit.skills || []) {
        if (!skillUsable(sk) || (sk.kind === 'heal') !== heal) continue;
        for (const [tx, ty] of skillTargetTiles(b, unit, sk)) {
            const aff = skillAffected(b, unit, sk, tx, ty);
            let score = 0;
            if (heal) {
                for (const t of aff) {
                    const missing = t.maxHp - t.hp;
                    if (missing / t.maxHp < 0.3) continue;
                    score += Math.min(missing, calcHeal(unit, t, sk.power, rules, Math.random, true));
                }
            } else {
                if (!aff.some(filter)) continue;
                for (const t of aff) {
                    const dmg = calcDamage(b, unit, t, sk.kind, sk.power, rules, Math.random, true);
                    score += 1 + Math.min(dmg, t.hp) + (dmg >= t.hp ? 100 : 0);
                }
            }
            // 有次数限制的技能，略微倾向于保留
            if (sk.uses) score *= 0.9;
            consider({ kind: 'skill', x, y, skill: sk, tx, ty, score });
        }
    }
    unit.x = ox; unit.y = oy;
    return best;
}

function bestAction(b, unit, nodes, rules, filter, heal = false) {
    let best = null;
    for (const node of nodes) {
        const cand = bestActionAt(b, unit, node.x, node.y, rules, filter, heal);
        if (!cand) continue;
        cand.score -= node.cost * 0.01; // 同分时少走路
        if (!best || cand.score > best.score) best = cand;
    }
    return best;
}

/** AI 想要攻击的目标：守城战的敌人盯着守卫目标，其余情况找角色（不含建筑物） */
export function goalTargets(b, unit) {
    const type = missionOf(b).type;
    const foes = alive(b).filter(t => isFoe(t, unit));
    const fighters = foes.filter(t => !t.object);
    if (team(unit) === 'E' && type === 'defend') {
        const guards = foes.filter(t => t.keyTarget);
        if (guards.length) return guards;
    }
    if (team(unit) === 'P' && type === 'assault') {
        return [...fighters, ...foes.filter(t => t.object && t.keyTarget)];
    }
    return fighters;
}

function fieldDist(b, field, t) {
    let d = field[t.y * b.w + t.x];
    for (const [dx, dy] of DIRS) {
        const nx = t.x + dx, ny = t.y + dy;
        if (inBounds(b, nx, ny)) d = Math.min(d, field[ny * b.w + nx] + 1);
    }
    return d;
}

function execute(b, unit, plan, rules, rng, events) {
    const mv = doMove(b, unit, plan.x, plan.y);
    if (mv) events.push(mv);
    if (plan.kind === 'attack') events.push(doAttack(b, unit, plan.target, rules, rng));
    else events.push(doSkill(b, unit, plan.skill, plan.tx, plan.ty, rules, rng));
}

/**
 * 让单个 AI 单位行动，返回事件列表
 * - 主动出击：按距离从近到远，攻击最近的能打到的目标；都打不到就朝最近的目标前进，途中顺手攻击射程内的敌人
 *   （守城战中敌人的目标是守卫目标，会无视我方角色直奔目标，只在被拦住时攻击挡路者）
 * - 原地迎击：只攻击移动后能打到的目标，不主动接近
 * - 固守不动：不移动，只攻击射程内的目标
 */
export function aiAct(b, unit, rules, rng = Math.random) {
    const events = [];
    if (unit.hp <= 0 || unit.object || b.result) return events;
    const nodes = [...(unit.ai === 'stationary'
        ? [{ x: unit.x, y: unit.y, cost: 0 }]
        : reachable(b, unit).values())];
    const anyFoe = t => isFoe(t, unit);

    let plan = bestAction(b, unit, nodes, rules, () => false, true);
    if (!plan && unit.ai === 'aggressive') {
        const goals = goalTargets(b, unit);
        const fromMe = distanceField(b, unit, [[unit.x, unit.y]]);
        const ordered = goals.map(g => [g, fieldDist(b, fromMe, g)]).sort((a, c) => a[1] - c[1]);
        for (const [g] of ordered) {
            plan = bestAction(b, unit, nodes, rules, t => t === g);
            if (plan) break;
        }
        if (!plan && goals.length) {
            // 朝最近的目标前进
            const field = distanceField(b, unit, goals.map(g => [g.x, g.y]));
            let dest = null;
            for (const n of nodes) {
                const v = field[n.y * b.w + n.x];
                if (!dest || v < dest.v || (v === dest.v && n.cost < dest.cost)) dest = { ...n, v };
            }
            if (dest && isFinite(dest.v) && (dest.x !== unit.x || dest.y !== unit.y)) {
                const mv = doMove(b, unit, dest.x, dest.y);
                if (mv) events.push(mv);
            }
            plan = bestAction(b, unit, [{ x: unit.x, y: unit.y, cost: 0 }], rules, anyFoe);
        }
    } else if (!plan) {
        plan = bestAction(b, unit, nodes, rules, anyFoe);
    }
    if (plan) execute(b, unit, plan, rules, rng, events);
    unit.acted = true;
    finish(b, events);
    return events;
}

function startTurnEffects(b, side) {
    const events = [];
    for (const u of alive(b).filter(x => x.side === side)) {
        const t = terrainAt(b, u.x, u.y);
        const pct = Number(t.healPct) || 0;
        if (pct > 0 && u.hp < u.maxHp && !u.object) {
            const amount = Math.min(u.maxHp - u.hp, Math.max(1, Math.round(u.maxHp * pct / 100)));
            const before = u.hp;
            u.hp += amount;
            events.push({ type: 'terrainHeal', turn: b.turn, actor: ref(u), terrain: t.name, heal: amount, hpBefore: before, hpAfter: u.hp });
        }
    }
    return events;
}

// ---------------------------------------------------------------- 增援

/** 在 (x,y) 附近找一个能站的空格 */
function freeTileNear(b, def, x, y, radius = 3) {
    const probe = { flying: !!def.flying };
    for (let r = 0; r <= radius; r++) {
        for (const [tx, ty] of tilesInRange(b, x, y, r, r)) {
            if (!unitAt(b, tx, ty) && isFinite(enterCost(b, probe, tx, ty))) return [tx, ty];
        }
    }
    return null;
}

/** 处理本回合到期的增援，返回事件 */
export function processReinforcements(b) {
    const events = [];
    b.reinfFired ||= {};
    b.spawnCount ||= {};
    for (const w of b.reinforcements || []) {
        const next = nextWaveTurn(b, w);
        if (next == null || next > b.turn) continue;
        b.reinfFired[w.id] = (b.reinfFired[w.id] || 0) + 1;
        const def = b.unitDefs?.[w.unitId];
        if (!def) continue;
        const spawned = [];
        for (let i = 0; i < Math.max(1, Number(w.count) || 1); i++) {
            const pos = freeTileNear(b, def, w.x, w.y);
            if (!pos) break;
            b.spawnCount[def.id] = (b.spawnCount[def.id] || 0) + 1;
            const u = makeBattleUnit(def, `r${b.nextUid++}`, `${def.name}·增援${b.spawnCount[def.id]}`, pos[0], pos[1]);
            u.acted = true; // 增援出现的回合不行动
            b.units.push(u);
            spawned.push(ref(u));
        }
        events.push({
            type: 'reinforce', turn: b.turn, side: w.side, at: { x: w.x, y: w.y },
            terrain: terrainAt(b, w.x, w.y).name, units: spawned, wanted: Math.max(1, Number(w.count) || 1),
            actor: { side: w.side, name: def.name },
        });
    }
    return events;
}

/** 结束我方阶段：敌方行动 → 友军行动 → 增援 → 新回合 */
export function endPlayerPhase(b, rules, rng = Math.random) {
    const events = [];
    if (b.result) return events;
    for (const side of ['enemy', 'ally']) {
        const group = alive(b).filter(u => u.side === side && !u.object);
        if (!group.length) continue;
        b.phase = side;
        events.push({ type: 'phase', turn: b.turn, phase: side });
        events.push(...startTurnEffects(b, side));
        for (const u of group) {
            u.moved = false; u.acted = false;
            events.push(...aiAct(b, u, rules, rng));
            if (b.result) return events;
        }
    }
    events.push(...processReinforcements(b));
    setResult(b, checkTurnLimit(b), events);
    if (b.result) return events;
    b.turn += 1;
    b.phase = 'player';
    for (const u of b.units) { u.moved = false; u.acted = false; }
    events.push({ type: 'phase', turn: b.turn, phase: 'player' });
    events.push(...startTurnEffects(b, 'player'));
    finish(b, events);
    return events;
}

// ---------------------------------------------------------------- 创建战斗

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function makeBattleUnit(d, uidStr, name, x, y) {
    const hp = Math.max(1, Number(d.hp) || 1);
    const object = d.kind === 'object';
    return {
        uid: uidStr,
        defId: d.id,
        name,
        side: d.side,
        icon: d.icon || d.name.slice(0, 1),
        color: d.color || '',
        x, y,
        hp, maxHp: hp,
        atk: object ? 0 : +d.atk || 0,
        matk: object ? 0 : +d.matk || 0,
        def: +d.def || 0, mdef: +d.mdef || 0,
        mov: object ? 0 : +d.mov || 0,
        rangeMin: object ? 0 : Math.max(1, +d.rangeMin || 1),
        rangeMax: object ? 0 : Math.max(+d.rangeMin || 1, +d.rangeMax || 1),
        atkType: d.atkType === 'magical' ? 'magical' : 'physical',
        flying: !object && !!d.flying,
        ai: object ? 'stationary' : d.ai || 'aggressive',
        object,
        keyTarget: !!d.keyTarget,
        skills: object ? [] : (d.skills || []).map(s => ({ ...structuredClone(s), usesLeft: Number(s.uses) || 0 })),
        wb: d.wb ? structuredClone(d.wb) : null,
        notes: d.notes || '',
        moved: false, acted: false,
    };
}

export function createBattle(map, unitDefs, terrainDefs) {
    const defs = new Map(unitDefs.map(u => [u.id, u]));
    const terrains = {};
    for (const t of terrainDefs) terrains[t.id] = structuredClone(t);
    const placements = (map.placements || []).filter(p => defs.has(p.unitId));
    const count = {};
    placements.forEach(p => { count[p.unitId] = (count[p.unitId] || 0) + 1; });
    const seen = {};
    const units = placements.map((p, i) => {
        const d = defs.get(p.unitId);
        seen[d.id] = (seen[d.id] || 0) + 1;
        const suffix = count[d.id] > 1 ? (LETTERS[seen[d.id] - 1] || seen[d.id]) : '';
        return makeBattleUnit(d, `u${i}`, d.name + suffix, p.x, p.y);
    });
    const reinforcements = (map.reinforcements || [])
        .filter(w => defs.has(w.unitId))
        .map(w => ({ ...structuredClone(w), side: defs.get(w.unitId).side }));
    const unitDefs2 = {};
    reinforcements.forEach(w => { unitDefs2[w.unitId] = structuredClone(defs.get(w.unitId)); });
    return {
        active: true,
        mapId: map.id,
        mapName: map.name,
        mapDesc: map.desc || '',
        w: map.w, h: map.h,
        tiles: [...map.tiles],
        terrains,
        units,
        mission: { type: 'annihilate', turns: 0, ...(map.mission || {}) },
        reinforcements,
        unitDefs: unitDefs2,
        reinfFired: {},
        spawnCount: {},
        nextUid: 1,
        turn: 1,
        phase: 'player',
        result: null,
        resultReason: '',
        pending: [],
        log: [],
    };
}

/** 开战前检查任务设置是否完整，返回问题列表 */
export function validateMission(map, unitDefs) {
    const defs = new Map(unitDefs.map(u => [u.id, u]));
    const placed = (map.placements || []).map(p => defs.get(p.unitId)).filter(Boolean);
    const type = map.mission?.type || 'annihilate';
    const problems = [];
    if (!placed.some(d => d.side === 'player' && d.kind !== 'object')) problems.push('至少需要一个我方角色');
    const enemyWaves = (map.reinforcements || []).filter(w => defs.get(w.unitId)?.side === 'enemy');
    if (!placed.some(d => d.side === 'enemy') && !enemyWaves.length) problems.push('至少需要一个敌方单位或敌方增援');
    if (type === 'defend' && !placed.some(d => d.side !== 'enemy' && d.keyTarget)) problems.push('守城战需要放置一个我方/友军的「关键目标」（如城门）');
    if (type === 'assault' && !placed.some(d => d.side === 'enemy' && d.keyTarget)) problems.push('进攻战需要放置至少一个敌方「关键目标」');
    if (type === 'annihilate' && enemyWaves.some(w => (Number(w.every) || 0) > 0 && !(Number(w.times) || 0)) && !(Number(map.mission?.turns) || 0)) {
        problems.push('歼灭战中有无限次的敌方增援，敌人永远杀不完，请限制增援次数');
    }
    return problems;
}
