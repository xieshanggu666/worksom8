import db, { getSetting, setSetting, tx } from './db.js'
import {
  setMerchantMaterials, merchantStockState, merchantSaleableQty, deductMerchantStock,
  applyMerchantSales, returnMerchantStock, ProcError
} from './procurement.js'

// 园区联营商户结算模块：
//   商户申请入驻 → 运营审核签约（收保证金、约定抽成比例/合同周期）→ 营业
//   → 园区统一收银逐笔销售流水（FEFO 联动库存消耗、会员折扣与积分）
//   → 投诉违约扣款 / 退货退款冲账（未结算红冲、已结算结转下期）
//   → 周期结算单（销售分账 + 扣款调整 → 商户应分净额）→ 财务付款结清
//   → 合同到期/主动解约（结清全部账后退保证金）
// 资金口径（现金制）：销售款全额流入园区（财务「联营销售」），付款时才流出（「联营结算」）；
// 保证金收付走「联营保证金」，违约扣款在结算确认时确认「违约收入」。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null,
  createComplaint: null   // 由 index.js 注入
}
export function initMerchantContext(deps) { Object.assign(ctx, deps) }

export class MerchantError extends Error {
  constructor(code, msg) { super(msg); this.code = code }
}
const fail = (code, msg) => ({ ok: false, code, msg })

// 幂等重放：同一 scope+key 直接返回首次结果快照（销售/结算/付款/退款等写操作防重复提交）
function idempotent(scope, key, fn) {
  const k = String(key || '').slice(0, 80)
  if (!k) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, k)
  if (hit) { try { return JSON.parse(hit.response) } catch { /* 快照损坏则重新执行 */ } }
  const r = fn()
  if (r && r.ok) {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, k, JSON.stringify(r), ctx.tick(), ctx.day())
  }
  return r
}

const FIN_SALE = '联营销售'
const FIN_SETTLE = '联营结算'
const FIN_DEPOSIT = '联营保证金'
const FIN_FINE = '违约收入'
const FIN_MKT = '会员权益'

const STATUS_NAME = {
  applied: '待审核', rejected: '已驳回', signed: '已签约',
  operating: '营业中', suspended: '已暂停', terminated: '已解约'
}

// ---------------- 编码 / 流水 ----------------
function stampCode(table, id, prefix) {
  db.prepare(`UPDATE ${table} SET code=? WHERE id=?`).run(prefix + String(id).padStart(4, '0'), id)
}
function logMerchant(merchantId, action, note = '', staffId = null) {
  db.prepare('INSERT INTO merchant_logs(merchant_id,tick,day,hour,action,note,staff_id) VALUES(?,?,?,?,?,?,?)')
    .run(merchantId, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId)
}
function getMerchant(id) { return db.prepare('SELECT * FROM merchants WHERE id=?').get(id) }

function cfgCommission() { return Math.max(0.05, Math.min(0.8, num(getSetting('merchantDefaultCommission'), 0.2))) }
function cfgDeposit() { return Math.max(0, Math.round(num(getSetting('merchantDefaultDeposit'), 5000))) }
function cfgPeriods() { return Math.max(1, Math.round(num(getSetting('merchantContractPeriods'), 30))) }
export function merchantConfig() {
  return {
    enabled: String(getSetting('merchantEnabled', '1')) === '1' ? 1 : 0,
    defaultCommission: cfgCommission(),
    defaultDeposit: cfgDeposit(),
    contractPeriods: cfgPeriods(),
    autoSettle: num(getSetting('merchantAutoSettle'), 1) ? 1 : 0
  }
}

function tierOf(memberId) {
  const m = db.prepare('SELECT * FROM members WHERE id=?').get(memberId)
  if (!m) return null
  if (m.status === 'frozen' || !m.card_tier || m.card_tier === 'none' || m.card_expire_day < ctx.day()) {
    return { member: m, tier: 'none', name: '普通会员', discount_vendor: 1, point_mul: 1 }
  }
  const card = db.prepare('SELECT * FROM card_products WHERE tier=?').get(m.card_tier)
  return { member: m, tier: m.card_tier, name: card?.name || '会员', discount_vendor: card?.discount_vendor ?? 1, point_mul: card?.point_mul ?? 1 }
}
function calcPoints(amount, mul = 1) {
  const rate = Math.max(0, num(getSetting('pointRate'), 1))
  return Math.max(0, Math.floor((num(amount) / 10) * rate * mul))
}
// 会员积分变动（事务内）：与票务/预约/商铺统一口径，回退最多扣到 0
function addPoints(memberId, delta, source, refType, refId, note) {
  const m = db.prepare('SELECT * FROM members WHERE id=?').get(memberId)
  if (!m) return 0
  const after = Math.max(0, m.points + delta)
  const real = after - m.points
  db.prepare('UPDATE members SET points=?, total_points=total_points+? WHERE id=?')
    .run(after, real > 0 ? real : 0, memberId)
  db.prepare(`INSERT INTO member_point_logs(member_id,change,balance_after,source,ref_type,ref_id,day,tick,note)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(memberId, real, after, source, refType, refId ?? null, ctx.day(), ctx.tick(), note)
  return real
}

// ---------------- 入驻申请 / 审核 / 签约 ----------------
export function applyMerchant(payload = {}) {
  if (String(getSetting('merchantEnabled', '1')) !== '1') return fail('DISABLED', '联营招商已暂停，暂不接受入驻申请')
  const name = String(payload.name || '').trim()
  if (!name) return fail('BAD_ARG', '商户/品牌名称必填')
  const exists = db.prepare("SELECT id FROM merchants WHERE name=? AND status NOT IN ('rejected','terminated')").get(name)
  if (exists) return fail('DUP_NAME', '已有同名商户在营或待审核')
  const rate = Math.max(0.05, Math.min(0.8, num(payload.commission_rate, cfgCommission())))
  const deposit = Math.max(0, Math.round(num(payload.deposit, cfgDeposit())))
  const periods = Math.max(1, Math.round(num(payload.contract_periods, cfgPeriods())))
  try {
    return tx(() => idempotent('merchant_apply', payload.requestId, () => {
      const r = db.prepare(`INSERT INTO merchants(name,contact,phone,category,zone_id,price,commission_rate,deposit,
                            status,apply_note,contract_periods,create_tick,create_day)
                            VALUES(?,?,?,?,?,?,?,?,'applied',?,?,?,?)`)
        .run(name, String(payload.contact || ''), String(payload.phone || ''),
             String(payload.category || '餐饮'), num(payload.zone_id, 1),
             Math.max(1, Math.round(num(payload.price, 25))), rate, deposit,
             String(payload.apply_note || ''), periods, ctx.tick(), ctx.day())
      const id = Number(r.lastInsertRowid)
      stampCode('merchants', id, 'LY')
      logMerchant(id, 'apply', `提交入驻申请：品类「${payload.category || '餐饮'}」、拟抽成 ${Math.round(rate * 100)}%、保证金 ¥${deposit}`)
      return { ok: true, id }
    }))
  } catch (e) { return fail(e.code || 'TX_FAILED', e.message) }
}

// 审核通过并签约：审核即签约，商户缴纳保证金（园区现金流入），合同生效
export function approveMerchant(id, { staffId = null, requestId = '', commissionRate = null, deposit = null, periods = null } = {}) {
  try {
    return tx(() => idempotent('merchant_sign', requestId, () => {
      const m = getMerchant(id)
      if (!m) throw new MerchantError('NOT_FOUND', '商户不存在')
      if (m.status !== 'applied') throw new MerchantError('BAD_STATUS', '仅待审核商户可审核签约')
      const rate = commissionRate != null ? Math.max(0.05, Math.min(0.8, num(commissionRate))) : m.commission_rate
      const dep = deposit != null ? Math.max(0, Math.round(num(deposit))) : m.deposit
      const per = periods != null ? Math.max(1, Math.round(num(periods))) : m.contract_periods
      const expireDay = ctx.day() + per - 1
      // 保证金：园区统一收取（现金流入，联营保证金科目）
      db.prepare('UPDATE merchants SET status=?, commission_rate=?, deposit=?, contract_periods=?, contract_day=?, expire_day=?, last_settle_day=?, deposit_paid=?, approver_id=?, sign_tick=? WHERE id=?')
        .run('operating', rate, dep, per, ctx.day(), expireDay, ctx.day() - 1, dep, staffId ?? null, ctx.tick(), id)
      const pid = insertPayment(id, 'deposit', dep, null, `商户「${m.name}」签约保证金（按合同核定）`)
      if (dep > 0) {
        setSetting('cash', Math.round(ctx.cash() + dep))
        ctx.logFinance?.(ctx.day(), FIN_DEPOSIT, dep, `${m.code} 联营保证金收入`)
      }
      logMerchant(id, 'sign', `审核通过并签约：抽成 ${Math.round(rate * 100)}%、保证金 ¥${dep}、周期 ${per} 天（至第 ${expireDay} 天）`, staffId)
      return { ok: true, paymentId: pid, deposit: dep, expireDay }
    }))
  } catch (e) { return fail(e.code || 'TX_FAILED', e.message) }
}

export function rejectMerchant(id, { reason = '', staffId = null } = {}) {
  const m = getMerchant(id)
  if (!m) return fail('NOT_FOUND', '商户不存在')
  if (m.status !== 'applied') return fail('BAD_STATUS', '仅待审核商户可驳回')
  db.prepare("UPDATE merchants SET status='rejected', reject_reason=? WHERE id=?").run(String(reason || '资质不符'), id)
  logMerchant(id, 'reject', `入驻审核驳回：${reason || '资质不符'}`, staffId)
  return { ok: true }
}

// 暂停营业 / 恢复营业
export function setMerchantSuspended(id, suspended, { reason = '', staffId = null } = {}) {
  const m = getMerchant(id)
  if (!m) return fail('NOT_FOUND', '商户不存在')
  if (suspended) {
    if (m.status !== 'operating') return fail('BAD_STATUS', '仅营业中商户可暂停')
    db.prepare("UPDATE merchants SET status='suspended' WHERE id=?").run(id)
    logMerchant(id, 'suspend', `暂停营业：${reason || '运营管控'}`, staffId)
  } else {
    if (m.status !== 'suspended') return fail('BAD_STATUS', '仅已暂停商户可恢复')
    db.prepare("UPDATE merchants SET status='operating' WHERE id=?").run(id)
    logMerchant(id, 'resume', '恢复营业', staffId)
  }
  return { ok: true }
}

// 配置经营物资（联动 FEFO 库存）
export function saveMerchantMaterials(id, materialIds) {
  const m = getMerchant(id)
  if (!m) return fail('NOT_FOUND', '商户不存在')
  try { return setMerchantMaterials(id, materialIds) }
  catch (e) { return fail(e.code || 'TX_FAILED', e.message) }
}

// ---------------- 销售流水（园区统一收银 + 分账） ----------------
function createSaleInternal({ merchant, qty, price, source, memberId, pointsAwarded = 0, discountAmount = 0, note = '' }) {
  const amount = Math.round(qty * price)
  const commission = Math.round(amount * merchant.commission_rate)
  const share = amount - commission
  const tier = memberId ? (tierOf(memberId)?.tier || '') : ''
  const r = db.prepare(`INSERT INTO merchant_sales(merchant_id,qty,price,amount,discount_amount,commission,merchant_share,
                        source,member_id,member_tier,points_awarded,day,tick,note)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(merchant.id, qty, Math.round(price * 100) / 100, amount, Math.round(discountAmount), commission, share,
         source, memberId ?? null, tier, pointsAwarded, ctx.day(), ctx.tick(), note)
  const sid = Number(r.lastInsertRowid)
  stampCode('merchant_sales', sid, 'LS')
  db.prepare(`UPDATE merchants SET sales_qty=sales_qty+?, sales_amount=sales_amount+?,
              commission_amount=commission_amount+?, merchant_amount=merchant_amount+? WHERE id=?`)
    .run(qty, amount, commission, share, merchant.id)
  setSetting('cash', Math.round(ctx.cash() + amount))
  ctx.logFinance?.(ctx.day(), FIN_SALE, amount,
    `${merchant.code}「${merchant.name}」联营销售 ${qty} 件${memberId ? '（会员）' : ''}`)
  return { sid, amount, commission, share }
}

// 散客销售（含模拟引擎）：整单 FEFO 扣库存，库存不足按可售量截断由调用方决定重试
export function recordMerchantSale(merchantId, qty, { source = 'guest', memberId = null, requestId = '', note = '' } = {}) {
  const q = Math.max(1, Math.round(num(qty)))
  try {
    return tx(() => idempotent('merchant_sale', requestId, () => {
      const m = getMerchant(merchantId)
      if (!m) throw new MerchantError('NOT_FOUND', '商户不存在')
      if (m.status !== 'operating') throw new MerchantError('BAD_STATUS', '商户未在营业，不能收银')
      // 库存联动：未挂物资=不受限；不足直接抛 STOCKOUT（整单不成交）
      deductMerchantStock(merchantId, q)
      let points = 0
      let memberRow = null
      let discountAmount = 0
      let price = m.price
      let payable = m.price * q
      if (memberId) {
        memberRow = tierOf(memberId)
        if (!memberRow) throw new MerchantError('MEMBER_NOT_FOUND', '会员不存在')
        if (memberRow.member.status === 'frozen') throw new MerchantError('MEMBER_FROZEN', '会员账户已冻结，暂不可消费')
        payable = Math.round(m.price * q * memberRow.discount_vendor)
        price = payable / q                       // 折后单价（金额 = 件数 × 单价恒等）
        discountAmount = m.price * q - payable
        points = calcPoints(payable, memberRow.point_mul)
        if (points) addPoints(memberId, points, 'vendor', 'merchant', merchantId, `联营商户「${m.name}」消费积分`)
        db.prepare('UPDATE members SET last_active_tick=? WHERE id=?').run(ctx.tick(), memberId)
      }
      const r = createSaleInternal({
        merchant: m, qty, price, source: memberId ? 'member' : source,
        memberId, pointsAwarded: points, discountAmount, note
      })
      logMerchant(merchantId, 'sale', `销售 ${qty} 件，实收 ¥${r.amount}（园方佣金 ¥${r.commission} / 商户应分 ¥${r.share}）${points ? `，会员获 ${points} 积分` : ''}`)
      return { ok: true, saleId: r.sid, amount: r.amount, commission: r.commission, share: r.share, points, price: Math.round(price) }
    }))
  } catch (e) { return fail(e.code || 'TX_FAILED', e.message) }
}

// 散客批量模拟销售：库存不足时按可售量截断成交，缺货部分记流失（引擎调用）
// 库存扣减与销售流水在同一事务原子提交（避免"扣了库存没流水/收了款没扣库存"）。
export function simulateMerchantSales(merchantId, wantQty) {
  const m = getMerchant(merchantId)
  if (!m || m.status !== 'operating') return { sold: 0, amount: 0, lost: 0 }
  const want = Math.max(0, Math.round(num(wantQty)))
  const cap = merchantSaleableQty(merchantId, want)
  const sold = Math.round(cap.sold || 0)
  if (sold <= 0) {
    // 断货流失仍要记录（applyMerchantSales 自带事务，仅在有挂物资且缺货时产生流失）
    if (cap.managed && cap.lost > 0) applyMerchantSales(merchantId, want)
    return { sold: 0, amount: 0, lost: cap.lost || 0 }
  }
  try {
    const out = tx(() => {
      deductMerchantStock(merchantId, sold)
      const r = createSaleInternal({ merchant: m, qty: sold, price: m.price, source: 'auto' })
      // 缺货流失（截断部分）
      if (cap.managed && cap.lost > 0) {
        const lostRev = Math.round(cap.lost * m.price)
        for (const mid of cap.mids) {
          db.prepare('INSERT INTO stock_lost_sales(vendor_id,merchant_id,material_id,qty_lost,lost_rev,day,tick) VALUES(0,?,?,?,?,?,?)')
            .run(merchantId, mid, cap.lost, lostRev, ctx.day(), ctx.tick())
        }
      }
      logMerchant(merchantId, 'sale', `散客联营销售 ${sold} 件，实收 ¥${r.amount}（佣金 ¥${r.commission} / 商户应分 ¥${r.share}）`)
      return r
    })
    return { sold, amount: out.amount, lost: cap.lost || 0 }
  } catch (e) {
    console.error('[merchants] 模拟联营销售失败（不影响主循环）:', e)
    return { sold: 0, amount: 0, lost: 0, error: String(e?.message || e) }
  }
}

// ---------------- 退货退款：未结算红冲 / 已结算结转下期 ----------------
export function refundMerchantSale(merchantId, { saleId = null, qty = 1, source = 'manual', reason = '', requestId = '' } = {}) {
  const q = Math.max(1, Math.round(num(qty)))
  try {
    return tx(() => idempotent('merchant_refund', requestId, () => {
      const m = getMerchant(merchantId)
      if (!m) throw new MerchantError('NOT_FOUND', '商户不存在')
      let sale = null
      if (saleId) {
        sale = db.prepare('SELECT * FROM merchant_sales WHERE id=? AND merchant_id=?').get(saleId, merchantId)
        if (!sale) throw new MerchantError('SALE_NOT_FOUND', '销售流水不存在或不属于该商户')
        const refunded = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM merchant_refunds WHERE sale_id=?').get(saleId).q
        if (refunded + q > sale.qty) throw new MerchantError('OVER_REFUND', `退货数量超过可退余量（${sale.qty - refunded} 件）`)
      }
      const unit = sale ? sale.price : m.price
      // 折后单价可能为小数（会员折扣）：整单退完取 sale.amount，部分退按比例四舍五入，末件兜底防超退
      const refundAmount = sale
        ? (q >= sale.qty ? sale.amount : Math.round(sale.amount * q / sale.qty))
        : Math.round(unit * q)
      const settled = sale ? !!sale.settle_id : false
      const commissionBack = sale
        ? Math.round(sale.commission * q / sale.qty)
        : Math.round(refundAmount * m.commission_rate)
      let merchantBack = refundAmount - commissionBack
      // 末件兜底：商户承担不超过原商户分成（防止多笔部分退累加后超过流水）
      if (sale) {
        const refunded = db.prepare('SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(commission_back),0) c, COALESCE(SUM(merchant_back),0) m FROM merchant_refunds WHERE sale_id=?').get(saleId)
        merchantBack = Math.min(merchantBack, sale.merchant_share - refunded.m)
      }
      if (ctx.cash() < refundAmount) throw new MerchantError('NO_CASH', `现金不足，退款需 ¥${refundAmount}`)

      // 库存回补（FEFO 批次回补；未挂物资无操作）
      returnMerchantStock(merchantId, q)

      // 会员积分按比例回退（回退最多扣到 0）
      let pointsClaw = 0, memberId = null
      if (sale?.member_id) {
        memberId = sale.member_id
        pointsClaw = Math.round(sale.points_awarded * q / sale.qty)
        if (pointsClaw) addPoints(memberId, -pointsClaw, 'refund', 'merchant', merchantId, `联营退货积分回退 ${sale.code || ''}`)
      }

      let adjustmentId = null
      if (settled) {
        // 已结算：商户承担部分结转下期（冲其下一应分），园方佣金不退（违约/责任在售后口径由商户担）
        const ar = db.prepare(`INSERT INTO merchant_adjustments(merchant_id,kind,amount,refund_id,note,day,tick)
                              VALUES(?, 'refund_carry', ?, NULL, ?, ?, ?)`)
          .run(merchantId, merchantBack, `已结算销售 ${sale.code} 退货 ${qty} 件，商户承担结转下期`, ctx.day(), ctx.tick())
        adjustmentId = Number(ar.lastInsertRowid)
      }

      const rr = db.prepare(`INSERT INTO merchant_refunds(merchant_id,sale_id,qty,amount,commission_back,merchant_back,settled,
                            adjustment_id,member_id,points_clawback,source,reason,day,tick)
                            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(merchantId, saleId ?? null, q, refundAmount, commissionBack, merchantBack, settled ? 1 : 0,
             adjustmentId, memberId, pointsClaw, source, reason || '游客退货', ctx.day(), ctx.tick())
      const rid = Number(rr.lastInsertRowid)
      stampCode('merchant_refunds', rid, 'LT')
      if (adjustmentId) db.prepare('UPDATE merchant_adjustments SET refund_id=? WHERE id=?').run(rid, adjustmentId)

      // 现金退款 + 红字销售流水
      setSetting('cash', Math.round(ctx.cash() - refundAmount))
      ctx.logFinance?.(ctx.day(), FIN_SALE, -refundAmount, `${m.code}「${m.name}」联营退货退款 ${qty} 件`)
      db.prepare(`UPDATE merchants SET sales_qty=CASE WHEN sales_qty>=? THEN sales_qty-? ELSE 0 END,
                  refund_amount=refund_amount+? WHERE id=?`).run(q, q, refundAmount, merchantId)
      if (!settled && sale) {
        // 未结算红冲：直接回减待分账口径字段
        db.prepare(`UPDATE merchants SET sales_amount=MAX(0,sales_amount-?),
                    commission_amount=MAX(0,commission_amount-?), merchant_amount=MAX(0,merchant_amount-?) WHERE id=?`)
          .run(refundAmount, commissionBack, merchantBack, merchantId)
      }
      logMerchant(merchantId, 'refund',
        `退货 ${qty} 件退款 ¥${refundAmount}${settled ? '（原销售已结算，商户承担 ¥' + merchantBack + ' 结转下期）' : '（未结算红冲）'}${pointsClaw ? `，回退 ${pointsClaw} 积分` : ''}`)
      return { ok: true, refundId: rid, amount: refundAmount, settled, adjustmentId, pointsClawback: pointsClaw }
    }))
  } catch (e) { return fail(e.code || 'TX_FAILED', e.message) }
}

// ---------------- 投诉违约扣款（投诉处理联动） ----------------
// 在联营商户结算周期内登记违约扣款（投诉处罚），随下一结算单扣减商户应分；结算确认时确认违约收入
export function fineMerchant(merchantId, amount, { complaintId = null, note = '', staffId = null } = {}) {
  const m = getMerchant(merchantId)
  if (!m) return fail('NOT_FOUND', '商户不存在')
  const a = Math.round(num(amount))
  if (a <= 0) return fail('BAD_ARG', '扣款金额须大于 0')
  try {
    return tx(() => {
      const r = db.prepare(`INSERT INTO merchant_adjustments(merchant_id,kind,amount,complaint_id,note,staff_id,day,tick)
                            VALUES(?, 'fine', ?, ?, ?, ?, ?, ?)`)
        .run(merchantId, a, complaintId ?? null, note || '投诉违约扣款', staffId ?? null, ctx.day(), ctx.tick())
      const id = Number(r.lastInsertRowid)
      db.prepare('UPDATE merchants SET fine_amount=fine_amount+? WHERE id=?').run(a, merchantId)
      logMerchant(merchantId, 'fine', `违约扣款 ¥${a}${complaintId ? '（关联投诉 #' + complaintId + '）' : ''}：${note || '投诉处罚'}`, staffId)
      return { ok: true, adjustmentId: id, amount: a }
    })
  } catch (e) { return fail(e.code || 'TX_FAILED', e.message) }
}

// ---------------- 周期结算单 ----------------
function pendingAdjustments(merchantId) {
  return db.prepare('SELECT * FROM merchant_adjustments WHERE merchant_id=? AND settle_id IS NULL ORDER BY id').all(merchantId)
}
function unpaidSales(merchantId, dayFrom, dayTo) {
  return db.prepare(`SELECT * FROM merchant_sales WHERE merchant_id=? AND settle_id IS NULL AND day BETWEEN ? AND ? ORDER BY id`).all(merchantId, dayFrom, dayTo)
}
// 未结算期间发生的退货：已在红冲时回减 merchant 字段，但结算单周期内仍需按净流水归集。
// 结算单金额直接以「区间内未结算净流水」口径汇总（销售 - 未结算退货），调整（罚款/已结算退货结转）单独列示。
function periodRefunds(merchantId, dayFrom, dayTo) {
  return db.prepare(`SELECT * FROM merchant_refunds WHERE merchant_id=? AND settled=0 AND day BETWEEN ? AND ? ORDER BY id`).all(merchantId, dayFrom, dayTo)
}

// 生成结算单（可指定截止日，默认结算到昨天/今天）；幂等：同一商户同区间唯一
export function generateSettlement(merchantId, { dayTo = null, creatorId = null, note = '', auto = false } = {}) {
  const m = getMerchant(merchantId)
  if (!m) return fail('NOT_FOUND', '商户不存在')
  if (!['operating', 'suspended', 'terminated'].includes(m.status)) return fail('BAD_STATUS', '当前状态不可结算')
  const dayFrom = m.last_settle_day + 1
  const to = dayTo != null ? num(dayTo) : (auto ? ctx.day() - 1 : ctx.day())
  // 截止日落在已结算账期内：幂等返回覆盖该截止日的账单（重复请求/解约重入场景）
  if (to < dayFrom) {
    const cover = db.prepare(`SELECT * FROM merchant_settlements WHERE merchant_id=? AND day_to>=? AND day_from<=?
                              ORDER BY id DESC LIMIT 1`).get(merchantId, to, to + 1)
    if (cover) return { ok: true, id: cover.id, duplicated: true }
    if (pendingAdjustments(merchantId).length === 0) return fail('NOTHING_DUE', '没有待结算的账期')
  }
  const pendingAdj = pendingAdjustments(merchantId)
  // 截止日早于下一账期起始（只有待归集调整）：以调整日为零长度账期落点
  const endDay = Math.max(to, dayFrom - 1)
  try {
    return tx(() => {
      // 幂等区间：同一商户同区间已有结算单（含待确认/已付款）直接返回
      const dup = db.prepare('SELECT * FROM merchant_settlements WHERE merchant_id=? AND day_from=? AND day_to=?').get(merchantId, dayFrom, endDay)
      if (dup) return { ok: true, id: dup.id, duplicated: true }
      const sales = unpaidSales(merchantId, dayFrom, endDay)
      const refunds = periodRefunds(merchantId, dayFrom, endDay)
      const adj = pendingAdj
      const salesQty = sales.reduce((s, x) => s + x.qty, 0) - refunds.reduce((s, x) => s + x.qty, 0)
      const salesAmount = sales.reduce((s, x) => s + x.amount, 0) - refunds.reduce((s, x) => s + x.amount, 0)
      const commission = sales.reduce((s, x) => s + x.commission, 0) - refunds.reduce((s, x) => s + x.commission_back, 0)
      const gross = sales.reduce((s, x) => s + x.merchant_share, 0) - refunds.reduce((s, x) => s + x.merchant_back, 0)
      const fine = adj.filter(x => x.kind === 'fine').reduce((s, x) => s + x.amount, 0)
      const adjust = adj.reduce((s, x) => s + x.amount, 0) // 正=扣商户（罚款/退货结转）
      const net = gross - adjust
      // 空账期：无销售净流水且无待归集调整（如日结对当日无销售商户）→ 仅推进账期游标，不生成空账单
      const isEmpty = sales.length === 0 && refunds.length === 0 && adj.length === 0
      if (isEmpty) {
        db.prepare('UPDATE merchants SET last_settle_day=? WHERE id=?').run(endDay, merchantId)
        return { ok: true, id: null, empty: true }
      }
      const r = db.prepare(`INSERT INTO merchant_settlements(merchant_id,day_from,day_to,status,sales_qty,sales_amount,
                            commission_amount,merchant_gross,fine_amount,adjust_amount,merchant_net,note,creator_id,create_tick,create_day)
                            VALUES(?,?,?, 'pending',?,?,?,?,?,?,?,?,?,?,?)`)
        .run(merchantId, dayFrom, endDay, Math.max(0, salesQty), Math.max(0, salesAmount),
             Math.max(0, commission), Math.max(0, gross), fine, adjust, Math.max(0, net),
             note || (auto ? '日结自动生成' : '运营生成结算单'), creatorId, ctx.tick(), ctx.day())
      const id = Number(r.lastInsertRowid)
      stampCode('merchant_settlements', id, 'LC')
      // 归集：销售/退货（未结算）/调整标记归属；商户 last_settle_day 推进
      const markSale = db.prepare('UPDATE merchant_sales SET settle_id=? WHERE id=?')
      sales.forEach(x => markSale.run(id, x.id))
      const markRefund = db.prepare('UPDATE merchant_refunds SET settlement_id=? WHERE id=?')
      refunds.forEach(x => { db.prepare('UPDATE merchant_refunds SET settled=1 WHERE id=?').run(x.id); markRefund.run(id, x.id) })
      const markAdj = db.prepare('UPDATE merchant_adjustments SET settle_id=? WHERE id=?')
      adj.forEach(x => markAdj.run(id, x.id))
      db.prepare('UPDATE merchants SET last_settle_day=? WHERE id=?').run(endDay, merchantId)
      logMerchant(merchantId, 'settle_create',
        `生成结算单（第 ${dayFrom}~${endDay} 天）：销售净流水 ¥${Math.max(0, salesAmount)}、佣金 ¥${Math.max(0, commission)}、商户分成 ¥${Math.max(0, gross)}、扣款 ¥${adjust}、应分净额 ¥${Math.max(0, net)}`, creatorId)
      return { ok: true, id, net: Math.max(0, net) }
    })
  } catch (e) { return fail(e.code || 'TX_FAILED', e.message) }
}

// 确认结算单：违约扣款在此刻确认「违约收入」（现金制，园区已留款，不产生现金流动）
export function confirmSettlement(id, { staffId = null } = {}) {
  const s = db.prepare('SELECT * FROM merchant_settlements WHERE id=?').get(id)
  if (!s) return fail('NOT_FOUND', '结算单不存在')
  if (s.status !== 'pending') return fail('BAD_STATUS', '仅待确认结算单可确认')
  try {
    return tx(() => {
      db.prepare("UPDATE merchant_settlements SET status='confirmed', confirm_tick=? WHERE id=?").run(ctx.tick(), id)
      if (s.fine_amount > 0) {
        ctx.logFinance?.(ctx.day(), FIN_FINE, s.fine_amount, `${s.code} 联营违约扣款（商户承担，结算留款）`)
      }
      logMerchant(s.merchant_id, 'settle_confirm', `结算单 ${s.code} 已确认，待财务付款 ¥${s.merchant_net}`, staffId)
      return { ok: true }
    })
  } catch (e) { return fail(e.code || 'TX_FAILED', e.message) }
}

function insertPayment(merchantId, kind, amount, settlementId, note) {
  const r = db.prepare('INSERT INTO merchant_payments(merchant_id,kind,amount,settlement_id,day,tick,note) VALUES(?,?,?,?,?,?,?)')
    .run(merchantId, kind, amount, settlementId ?? null, ctx.day(), ctx.tick(), note)
  const pid = Number(r.lastInsertRowid)
  stampCode('merchant_payments', pid, 'LP')
  return pid
}

// 财务付款：现金支付商户应分净额，结算单结清
export function paySettlement(id, { requestId = '', staffId = null } = {}) {
  try {
    return tx(() => idempotent('merchant_pay', requestId, () => {
      const s = db.prepare('SELECT * FROM merchant_settlements WHERE id=?').get(id)
      if (!s) throw new MerchantError('NOT_FOUND', '结算单不存在')
      if (s.status !== 'confirmed') throw new MerchantError('BAD_STATUS', '仅已确认结算单可付款')
      const pay = s.merchant_net
      if (pay > 0) {
        if (ctx.cash() < pay) throw new MerchantError('NO_CASH', `现金不足，需支付商户 ¥${pay}`)
        setSetting('cash', Math.round(ctx.cash() - pay))
      }
      const pid = insertPayment(s.merchant_id, 'settle', -pay, id, `结算单 ${s.code} 支付商户分成`)
      db.prepare("UPDATE merchant_settlements SET status='paid', paid_amount=?, payment_id=?, pay_tick=? WHERE id=?")
        .run(pay, pid, ctx.tick(), id)
      db.prepare('UPDATE merchants SET settled_amount=settled_amount+? WHERE id=?').run(pay, s.merchant_id)
      if (pay > 0) ctx.logFinance?.(ctx.day(), FIN_SETTLE, -pay, `${s.code} 联营商户分成付款`)
      logMerchant(s.merchant_id, 'settle_pay', `结算单 ${s.code} 付款 ¥${pay}，账期结清`, staffId)
      return { ok: true, paymentId: pid, paid: pay }
    }))
  } catch (e) { return fail(e.code || 'TX_FAILED', e.message) }
}

// ---------------- 解约：结清全部账后退保证金 ----------------
export function terminateMerchant(id, { staffId = null, reason = '' } = {}) {
  const m = getMerchant(id)
  if (!m) return fail('NOT_FOUND', '商户不存在')
  if (m.status === 'terminated') return fail('BAD_STATUS', '商户已解约')
  const openSettle = db.prepare("SELECT COUNT(*) n FROM merchant_settlements WHERE merchant_id=? AND status IN ('pending','confirmed')").get(id).n
  if (openSettle > 0) return fail('BILL_OPEN', `仍有 ${openSettle} 张未结清结算单，请先完成付款再解约`)
  try {
    return tx(() => {
      // 解约前把剩余账期（截至今天，含已逾期账期）自动出账；待归集违约/结转调整即使无新销售也会生成调整单
      const g = generateSettlement(id, { dayTo: ctx.day(), creatorId: staffId, note: '解约清算' })
      if (g.ok && !g.duplicated && g.id) {
        const c = confirmSettlement(g.id, { staffId })
        if (!c.ok) throw new MerchantError(c.code || 'TX_FAILED', c.msg || '清算单确认失败')
        const p = paySettlement(g.id, { staffId })
        if (!p.ok) throw new MerchantError(p.code || 'TX_FAILED', p.msg || '清算单付款失败')
      }
      // 已存在覆盖账期的账单：上面 openSettle 拦截已保证其为 paid；NOTHING_DUE 表示无剩余账期，直接继续退保证金
      const m2 = getMerchant(id)
      // 待结算调整（如解约清算单之后仍有）原则上已被吸收；若仍有挂起调整则拦截
      const pendingAdj = db.prepare('SELECT COUNT(*) n FROM merchant_adjustments WHERE merchant_id=? AND settle_id IS NULL').get(id).n
      if (pendingAdj > 0) throw new MerchantError('ADJ_OPEN', '仍有未归集的违约/调整款项，请先生成结算单')
      const refundDeposit = Math.max(0, m2.deposit_paid - m2.deposit_refunded)
      if (refundDeposit > 0) {
        if (ctx.cash() < refundDeposit) throw new MerchantError('NO_CASH', `现金不足，退还保证金需 ¥${refundDeposit}`)
        setSetting('cash', Math.round(ctx.cash() - refundDeposit))
        insertPayment(id, 'deposit_refund', -refundDeposit, null, '解约退还保证金')
        ctx.logFinance?.(ctx.day(), FIN_DEPOSIT, -refundDeposit, `${m2.code} 解约退还保证金`)
        db.prepare('UPDATE merchants SET deposit_refunded=deposit_refunded+? WHERE id=?').run(refundDeposit, id)
      }
      db.prepare("UPDATE merchants SET status='terminated', close_tick=? WHERE id=?").run(ctx.tick(), id)
      logMerchant(id, 'terminate', `解约清场${refundDeposit ? `，退还保证金 ¥${refundDeposit}` : '，保证金已结清'}：${reason || '合同终止'}`, staffId)
      return { ok: true, depositRefund: refundDeposit }
    })
  } catch (e) { return fail(e.code || 'TX_FAILED', e.message) }
}

// ---------------- 查询 ----------------
function enrichMerchant(m) {
  const zone = db.prepare('SELECT name FROM zones WHERE id=?').get(m.zone_id)
  const stock = merchantStockState(m.id)
  const materials = stock.managed ? stock.mats.map(x => ({ id: x.id, name: x.name, qty_on_hand: x.qty_on_hand, stock_status: x.stock_status, unit: x.unit })) : []
  const pendingSettle = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(merchant_net),0) s FROM merchant_settlements WHERE merchant_id=? AND status IN ('pending','confirmed')").get(m.id)
  const pendingAdj = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM merchant_adjustments WHERE merchant_id=? AND settle_id IS NULL').get(m.id).s
  // 实时待结算（尚未生成结算单部分）：区间 last_settle_day+1 ~ day 的净流水
  const ufSales = db.prepare(`SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(commission),0) c, COALESCE(SUM(merchant_share),0) s, COALESCE(SUM(qty),0) q
                              FROM merchant_sales WHERE merchant_id=? AND settle_id IS NULL`).get(m.id)
  const ufRefunds = db.prepare(`SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(commission_back),0) c, COALESCE(SUM(merchant_back),0) s, COALESCE(SUM(qty),0) q
                                FROM merchant_refunds WHERE merchant_id=? AND settlement_id IS NULL AND settled=0`).get(m.id)
  const unpaidShare = Math.max(0, ufSales.s - ufRefunds.s - pendingAdj)
  return {
    ...m,
    status_name: STATUS_NAME[m.status] || m.status,
    zone_name: zone?.name || '',
    stock_status: stock.status,
    saleable: stock.saleable === Infinity ? null : stock.saleable,
    materials,
    settlement_due: Math.max(0, pendingSettle.s) + unpaidShare,
    pending_bill_count: pendingSettle.n,
    pending_adjust: pendingAdj,
    unsettled_sales_amount: Math.max(0, ufSales.a - ufRefunds.a),
    unsettled_share: unpaidShare,
    contract_expired: ['operating', 'suspended'].includes(m.status) && m.expire_day > 0 && m.expire_day < ctx.day()
  }
}

export function listMerchants({ status = null } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM merchants WHERE status=? ORDER BY id DESC').all(status)
    : db.prepare('SELECT * FROM merchants ORDER BY id DESC').all()
  return rows.map(enrichMerchant)
}
export function merchantDetail(id) {
  const m = getMerchant(id)
  if (!m) return null
  const sales = db.prepare('SELECT * FROM merchant_sales WHERE merchant_id=? ORDER BY id DESC LIMIT 50').all(id)
  const refunds = db.prepare('SELECT * FROM merchant_refunds WHERE merchant_id=? ORDER BY id DESC LIMIT 50').all(id)
  const settlements = db.prepare('SELECT * FROM merchant_settlements WHERE merchant_id=? ORDER BY id DESC').all(id)
  const adjustments = db.prepare('SELECT * FROM merchant_adjustments WHERE merchant_id=? ORDER BY id DESC LIMIT 100').all(id)
  const payments = db.prepare('SELECT * FROM merchant_payments WHERE merchant_id=? ORDER BY id DESC').all(id)
  const logs = db.prepare('SELECT * FROM merchant_logs WHERE merchant_id=? ORDER BY id DESC LIMIT 100').all(id)
  return { merchant: enrichMerchant(m), sales, refunds, settlements, adjustments, payments, logs }
}

export function listSales({ merchantId = null, status: statusFilter = null, limit = 200 } = {}) {
  let rows
  if (merchantId) rows = db.prepare('SELECT * FROM merchant_sales WHERE merchant_id=? ORDER BY id DESC LIMIT ?').all(merchantId, limit)
  else rows = db.prepare('SELECT * FROM merchant_sales ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map(x => ({ ...x, merchant_name: getMerchant(x.merchant_id)?.name || '' }))
    .filter(x => !statusFilter || (statusFilter === 'settled' ? x.settle_id : !x.settle_id))
}
export function listSettlements({ status = null, merchantId = null, limit = 200 } = {}) {
  let rows
  if (merchantId) rows = db.prepare('SELECT * FROM merchant_settlements WHERE merchant_id=? ORDER BY id DESC LIMIT ?').all(merchantId, limit)
  else if (status) rows = db.prepare('SELECT * FROM merchant_settlements WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
  else rows = db.prepare('SELECT * FROM merchant_settlements ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map(s => ({ ...s, merchant_name: getMerchant(s.merchant_id)?.name || '', merchant_code: getMerchant(s.merchant_id)?.code || '' }))
}

// ---------------- 引擎推进 ----------------
// 日结：合同到期自动暂停（停止营业待续约/解约）；自动为在营商户生成截至昨日的结算单（pending 待运营确认付款）
export function dayCloseMerchants(newDay) {
  const expired = []
  for (const m of db.prepare("SELECT * FROM merchants WHERE status='operating' AND expire_day>0 AND expire_day<?").all(newDay)) {
    db.prepare("UPDATE merchants SET status='suspended' WHERE id=?").run(m.id)
    logMerchant(m.id, 'contract_expire', `合同于第 ${m.expire_day} 天到期，自动暂停营业，请运营办理续约或解约`)
    expired.push(m.id)
  }
  const bills = []
  if (num(getSetting('merchantAutoSettle'), 1)) {
    for (const m of db.prepare("SELECT * FROM merchants WHERE status IN ('operating','suspended')").all()) {
      const r = generateSettlement(m.id, { dayTo: newDay - 1, auto: true })
      if (r.ok && r.id && !r.duplicated) bills.push(r.id)
    }
  }
  return { expired, bills }
}

// 每小时模拟：营业中联营商户产生销售（联动库存 FEFO 扣减）；低频退货/投诉
export function merchantTick({ entering = 0, satisfaction = 70 } = {}) {
  const result = { sales: 0, amount: 0, refunds: 0, refundAmount: 0, complaints: 0 }
  if (String(getSetting('merchantEnabled', '1')) !== '1') return result
  const list = db.prepare("SELECT * FROM merchants WHERE status='operating'").all()
  for (const m of list) {
    // 需求：客流 + 满意度驱动，品类系数
    const catFactor = m.category === '餐饮' ? 1 : m.category === '饮品' ? 0.9 : 0.55
    const demand = Math.max(0, Math.round((entering / 8) * catFactor * (0.6 + satisfaction / 200) * (0.7 + Math.random() * 0.6)))
    if (demand <= 0) continue
    const r = simulateMerchantSales(m.id, demand)
    result.sales += r.sold
    result.amount += r.amount
    // 低频售后退货（已产生销售时）
    if (r.sold > 0 && Math.random() < 0.015) {
      const rr = refundMerchantSale(m.id, { qty: 1, source: 'auto', reason: '模拟游客售后退货' })
      if (rr.ok) { result.refunds += 1; result.refundAmount += rr.amount }
    }
    // 低频服务/餐饮投诉（与投诉中心联动）
    if (Math.random() < 0.01) {
      try {
        ctx.createComplaint?.({
          category: ['food', 'service', 'pricing'][Math.floor(Math.random() * 3)],
          severity: Math.random() < 0.12 ? 2 : 1,
          title: `联营商户投诉 · ${m.name}`,
          content: '联营商户经营过程中游客反馈问题，请运营核查并按联营合同处置。',
          target: { type: 'merchant', id: m.id, name: m.name },
          source: 'guest'
        })
        result.complaints += 1
      } catch { /* 投诉联动失败不阻塞引擎 */ }
    }
  }
  return result
}

// ---------------- 统计 ----------------
export function merchantStats() {
  const one = sql => db.prepare(sql).get()
  const day = ctx.day()
  const todaySales = db.prepare("SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(qty),0) q, COALESCE(SUM(commission),0) c FROM merchant_sales WHERE day=?").get(day)
  const todayRefund = db.prepare("SELECT COALESCE(SUM(amount),0) a FROM merchant_refunds WHERE day=?").get(day).a
  return {
    applied: one("SELECT COUNT(*) n FROM merchants WHERE status='applied'").n,
    operating: one("SELECT COUNT(*) n FROM merchants WHERE status='operating'").n,
    suspended: one("SELECT COUNT(*) n FROM merchants WHERE status='suspended'").n,
    terminated: one("SELECT COUNT(*) n FROM merchants WHERE status='terminated'").n,
    totalSalesAmount: one("SELECT COALESCE(SUM(sales_amount),0) a FROM merchants").a,
    totalCommission: one("SELECT COALESCE(SUM(commission_amount),0) a FROM merchants").a,
    totalSettled: one("SELECT COALESCE(SUM(settled_amount),0) a FROM merchants").a,
    totalFine: one("SELECT COALESCE(SUM(fine_amount),0) a FROM merchants").a,
    depositHeld: one("SELECT COALESCE(SUM(deposit_paid-deposit_refunded),0) a FROM merchants WHERE status<>'terminated'").a,
    payableBills: db.prepare("SELECT COALESCE(SUM(merchant_net),0) a, COUNT(*) n FROM merchant_settlements WHERE status IN ('pending','confirmed')").get(),
    todaySalesAmount: todaySales.a,
    todaySalesQty: todaySales.q,
    todayCommission: todaySales.c,
    todayRefund
  }
}
