// 园区联营商户结算模块测试：
//  1) 入驻审核签约：申请→驳回/通过签约收保证金（幂等），状态流转
//  2) 销售分账：园区统一收银全额流入，按抽成拆分园方佣金/商户应分；会员折扣+积分同口径
//  3) 库存联动：绑定物资 FEFO 实时扣库存，库存不足整单失败
//  4) 投诉违约扣款：fine 挂待结算调整，随结算单扣商户分成
//  5) 退货退款：未结算红冲（回库存/回积分/红字流水）；已结算退货商户承担结转下期
//  6) 结算闭环：生成→确认（违约收入确认）→付款（现金流出）；区间幂等不重复
//  7) 解约清算：自动出账+结清+退保证金；有未付款结算单时拦截
// 运行：node --experimental-sqlite --test server/merchants.test.js（需 Node >= 22.5）
process.env.PARK_DB_PATH = ':memory:'

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const P = await import('./procurement.js')
const M = await import('./merchants.js')

const finLogs = []
P.initProcurementContext({ logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }) })
M.initMerchantContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: () => ({ id: 999, code: 'TS9999' })
})

const cash = () => Number(getSetting('cash'))
const matByName = n => P.listMaterials().find(m => m.name.includes(n))

test.beforeEach(() => {
  setSetting('day', 1); setSetting('hour', 10); setSetting('tick', 100)
  setSetting('cash', 500000)
})

function signedMerchant({ rate = 0.2, deposit = 4000, price = 20, materials = [] } = {}) {
  const a = M.applyMerchant({ name: '联营测试店' + Math.random().toString(36).slice(2, 7), category: '餐饮', commission_rate: rate, deposit, price })
  assert.equal(a.ok, true, a.msg)
  if (materials.length) assert.equal(M.saveMerchantMaterials(a.id, materials).ok, true)
  const s = M.approveMerchant(a.id, { requestId: 'sign-' + a.id })
  assert.equal(s.ok, true, s.msg)
  return a.id
}

test('入驻审核：重复申请校验、驳回不可签约、签约收保证金且幂等', () => {
  const a1 = M.applyMerchant({ name: '独家品牌店', commission_rate: 0.3, deposit: 6000 })
  assert.equal(a1.ok, true)
  assert.equal(M.applyMerchant({ name: '独家品牌店' }).ok, false, '同名在审/在营不可重复申请')
  assert.equal(M.approveMerchant(999999).ok, false, '不存在的商户')

  const a2 = M.applyMerchant({ name: '应被驳回店' })
  assert.equal(M.rejectMerchant(a2.id, { reason: '资质不全' }).ok, true)
  assert.equal(M.approveMerchant(a2.id).ok, false, '已驳回不能签约')
  assert.equal(M.listMerchants({ status: 'rejected' }).some(x => x.id === a2.id), true)

  const cash0 = cash()
  const s1 = M.approveMerchant(a1.id, {})
  assert.equal(s1.ok, true)
  assert.equal(s1.deposit, 6000)
  assert.equal(cash(), cash0 + 6000, '保证金现金流入')
  const s2 = M.approveMerchant(a1.id, {})
  assert.equal(s2.ok, false, '已签约不可重复签约')
  const m = M.merchantDetail(a1.id).merchant
  assert.equal(m.status, 'operating')
  assert.equal(m.contract_expired, false)
  assert.ok(finLogs.some(f => f.label === '联营保证金' && f.amount === 6000))
})

test('销售分账：全额收银流入，按抽成拆分佣金/商户应分；流水与商户累计一致', () => {
  const id = signedMerchant({ rate: 0.25, deposit: 0, price: 40 })
  const cash0 = cash()
  const r = M.recordMerchantSale(id, 3, { requestId: 'sale1' })
  assert.equal(r.ok, true, r.msg)
  assert.equal(r.amount, 120)
  assert.equal(r.commission, 30, '园方佣金 25%')
  assert.equal(r.share, 90, '商户应分 75%')
  assert.equal(cash(), cash0 + 120)
  // 幂等：同 requestId 重放不重复收银
  const replay = M.recordMerchantSale(id, 3, { requestId: 'sale1' })
  assert.equal(replay.saleId, r.saleId)
  assert.equal(cash(), cash0 + 120)
  const m = M.merchantDetail(id).merchant
  assert.equal(m.sales_qty, 3)
  assert.equal(m.sales_amount, 120)
  assert.equal(m.commission_amount, 30)
  assert.equal(m.merchant_amount, 90)
})

test('会员优惠：卡折扣计价、赚积分，按实付金额分账', () => {
  const id = signedMerchant({ rate: 0.2, price: 100 })
  const mBefore = db.prepare('SELECT points FROM members WHERE id=1').get().points // 金卡：商铺 95 折、1.5 倍积分
  const r = M.recordMerchantSale(id, 2, { memberId: 1, requestId: 'ms1' })
  assert.equal(r.ok, true, r.msg)
  assert.equal(r.amount, 190, '100×2×0.95=190')
  assert.equal(r.commission, 38)
  assert.equal(r.share, 152)
  assert.ok(r.points >= 28, `积分应按 190 实付计算，实得 ${r.points}`)
  const mAfter = db.prepare('SELECT points FROM members WHERE id=1').get().points
  assert.equal(mAfter - mBefore, r.points)
  const sale = db.prepare('SELECT * FROM merchant_sales WHERE id=?').get(r.saleId)
  assert.equal(sale.discount_amount, 10)
  assert.equal(sale.member_tier, 'gold')
  // 冻结会员不可消费
  db.prepare("UPDATE members SET status='frozen' WHERE id=2").run()
  assert.equal(M.recordMerchantSale(id, 1, { memberId: 2 }).ok, false)
  db.prepare("UPDATE members SET status='active' WHERE id=2").run()
})

test('库存联动：绑定物资销售 FEFO 扣库存，库存不足整单失败不扣款', () => {
  const syr = matByName('柠檬糖浆')
  const id = signedMerchant({ rate: 0.2, price: 18, materials: [syr.id] })
  const stock0 = P.listMaterials().find(x => x.id === syr.id).qty_on_hand
  const r = M.recordMerchantSale(id, 4, { requestId: 'stock1' })
  assert.equal(r.ok, true)
  assert.equal(P.listMaterials().find(x => x.id === syr.id).qty_on_hand, stock0 - 4)
  const cash0 = cash()
  // 超量整单失败
  const bad = M.recordMerchantSale(id, 999999, { requestId: 'stock2' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'STOCKOUT')
  assert.equal(cash(), cash0, '库存不足不得收款')
  assert.equal(P.listMaterials().find(x => x.id === syr.id).qty_on_hand, stock0 - 4, '库存不被半扣')
  // 暂停营业不可收银
  assert.equal(M.setMerchantSuspended(id, true).ok, true)
  assert.equal(M.recordMerchantSale(id, 1).ok, false)
  assert.equal(M.setMerchantSuspended(id, false).ok, true)
})

test('结算闭环：生成→确认（违约收入）→付款（现金流出），区间幂等', () => {
  const id = signedMerchant({ rate: 0.2, deposit: 1000, price: 50 })
  M.recordMerchantSale(id, 10, { requestId: 'a' }) // 500：佣 100 / 商户 400
  // 违约扣款 50
  const f = M.fineMerchant(id, 50, { complaintId: 1, note: '卫生处罚' })
  assert.equal(f.ok, true)
  const g = M.generateSettlement(id, { dayTo: 1 })
  assert.equal(g.ok, true)
  assert.equal(g.net, 350, '400 分成 - 50 罚款')
  assert.equal(M.generateSettlement(id, { dayTo: 1 }).duplicated, true, '同区间幂等')
  const bill = db.prepare('SELECT * FROM merchant_settlements WHERE id=?').get(g.id)
  assert.equal(bill.sales_amount, 500)
  assert.equal(bill.commission_amount, 100)
  assert.equal(bill.fine_amount, 50)
  assert.equal(bill.merchant_net, 350)
  // 未确认不能付款
  assert.equal(M.paySettlement(g.id).ok, false)
  const cashBefore = cash()
  assert.equal(M.confirmSettlement(g.id).ok, true)
  assert.ok(finLogs.some(x => x.label === '违约收入' && x.amount === 50), '确认时确认违约收入（不流现金）')
  assert.equal(cash(), cashBefore, '确认不产生现金流动')
  const pay = M.paySettlement(g.id, { requestId: 'pay-a' })
  assert.equal(pay.ok, true)
  assert.equal(pay.paid, 350)
  assert.equal(cash(), cashBefore - 350, '付款现金流出')
  const payReplay = M.paySettlement(g.id, { requestId: 'pay-a' })
  assert.equal(payReplay.paid, 350, '付款幂等重放')
  assert.equal(cash(), cashBefore - 350, '重放不重复付款')
  assert.equal(db.prepare("SELECT status FROM merchant_settlements WHERE id=?").get(g.id).status, 'paid')
  // 已付款后不能重复确认
  assert.equal(M.confirmSettlement(g.id).ok, false)
})

test('未结算退货：红冲销售、库存回补、会员积分回退、现金退还', () => {
  const syr = matByName('热狗肠')
  const id = signedMerchant({ rate: 0.2, price: 30, materials: [syr.id] })
  const stock0 = P.listMaterials().find(x => x.id === syr.id).qty_on_hand
  const pts0 = db.prepare('SELECT points FROM members WHERE id=1').get().points
  const sale = M.recordMerchantSale(id, 4, { memberId: 1, requestId: 'r1' })
  assert.equal(sale.ok, true)
  const stockAfterSale = P.listMaterials().find(x => x.id === syr.id).qty_on_hand
  assert.equal(stockAfterSale, stock0 - 4)
  const cash0 = cash()
  const rr = M.refundMerchantSale(id, { saleId: sale.saleId, qty: 1, requestId: 'rf1' })
  assert.equal(rr.ok, true, rr.msg)
  assert.equal(rr.settled, false)
  assert.equal(rr.amount, Math.round(30 * 0.95), '会员折后单价退款')
  assert.equal(cash(), cash0 - rr.amount)
  assert.equal(P.listMaterials().find(x => x.id === syr.id).qty_on_hand, stockAfterSale + 1, '库存回补')
  const pts1 = db.prepare('SELECT points FROM members WHERE id=1').get().points
  assert.ok(pts1 < pts0 + sale.points, '积分按比例回退')
  const m = M.merchantDetail(id).merchant
  assert.equal(m.sales_qty, 3)
  // 超退拦截
  assert.equal(M.refundMerchantSale(id, { saleId: sale.saleId, qty: 99 }).ok, false)
  // 幂等
  const cash2 = cash()
  const replay = M.refundMerchantSale(id, { saleId: sale.saleId, qty: 1, requestId: 'rf1' })
  assert.equal(replay.refundId, rr.refundId)
  assert.equal(cash(), cash2)
})

test('已结算退货：商户承担部分结转下期，从下一结算单扣减', () => {
  const id = signedMerchant({ rate: 0.2, deposit: 0, price: 50 })
  const sale = M.recordMerchantSale(id, 2, { requestId: 's1' }) // 100：佣 20 / 商户 80
  const g1 = M.generateSettlement(id, { dayTo: 1 })
  M.confirmSettlement(g1.id)
  M.paySettlement(g1.id, { requestId: 'p1' })
  const cash0 = cash()
  // 已结算后退货 1 件：园区先垫付退款 50，商户承担 40 结转下期
  const rr = M.refundMerchantSale(id, { saleId: sale.saleId, qty: 1, requestId: 'rf-s' })
  assert.equal(rr.ok, true)
  assert.equal(rr.settled, true)
  assert.equal(rr.amount, 50)
  assert.equal(cash(), cash0 - 50)
  assert.ok(rr.adjustmentId > 0)
  // 次日新销售 100（商户应分 80），结算单净额 = 80 - 40 结转 = 40
  setSetting('day', 2)
  const sale2 = M.recordMerchantSale(id, 2, { requestId: 's2' })
  assert.equal(sale2.ok, true)
  const g2 = M.generateSettlement(id, { dayTo: 2 })
  const bill = db.prepare('SELECT * FROM merchant_settlements WHERE id=?').get(g2.id)
  assert.equal(bill.day_from, 2)
  assert.equal(bill.merchant_gross, 80)
  assert.equal(bill.adjust_amount, 40)
  assert.equal(bill.merchant_net, 40, '已结算退货商户承担 40 结转扣减')
  assert.equal(bill.commission_amount, 20, '次日新销售佣金正常计提')
})

test('解约清算：有未付款结算单时拦截；结清后自动出账并退保证金', () => {
  const id = signedMerchant({ rate: 0.2, deposit: 3000, price: 40 })
  M.recordMerchantSale(id, 5, { requestId: 't1' }) // 200：商户 160
  const g = M.generateSettlement(id, { dayTo: 1 })
  M.confirmSettlement(g.id)
  // 已确认未付款：解约拦截
  const blocked = M.terminateMerchant(id, {})
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'BILL_OPEN')
  M.paySettlement(g.id, { requestId: 'tp' })
  // 付款后解约：退保证金
  const cash0 = cash()
  const t = M.terminateMerchant(id, { reason: '合同到期不续' })
  assert.equal(t.ok, true, t.msg)
  assert.equal(t.depositRefund, 3000)
  assert.equal(cash(), cash0 - 3000)
  const m = M.merchantDetail(id).merchant
  assert.equal(m.status, 'terminated')
  assert.equal(m.deposit_refunded, 3000)
  assert.ok(finLogs.some(x => x.label === '联营保证金' && x.amount === -3000))
  // 解约后不可再收银/出账
  assert.equal(M.recordMerchantSale(id, 1).ok, false)
})

test('日结自动出账：合同到期自动暂停；日结生成 pending 结算单', () => {
  setSetting('merchantAutoSettle', 1)
  const id = signedMerchant({ rate: 0.2, deposit: 0, price: 40 })
  db.prepare('UPDATE merchants SET contract_periods=1, expire_day=? WHERE id=?').run(1, id)
  M.recordMerchantSale(id, 5, { requestId: 'd1' })
  const r = M.dayCloseMerchants(2) // 跨入第 2 天
  assert.ok(r.expired.includes(id), '合同到期应自动暂停')
  assert.ok(r.bills.length >= 1, '应自动生成结算单')
  const bills = M.listSettlements({ merchantId: id })
  assert.equal(bills[0].status, 'pending', '自动账单待运营确认')
  assert.equal(M.merchantDetail(id).merchant.status, 'suspended')
})

test('统计口径：累计流水/佣金/已付/保证金占用/待付账单一致', () => {
  const id = signedMerchant({ rate: 0.25, deposit: 2000, price: 40 })
  M.recordMerchantSale(id, 10, { requestId: 'st1' }) // 400：佣 100 / 商户 300
  const g = M.generateSettlement(id, { dayTo: 1 })
  M.confirmSettlement(g.id)
  M.paySettlement(g.id, { requestId: 'stp' })
  const s = M.merchantStats()
  // 共享内存库存在其他用例商户，用增量/包含口径断言
  assert.ok(s.totalSalesAmount >= 400)
  assert.ok(s.totalCommission >= 100)
  assert.ok(s.totalSettled >= 300)
  const heldRow = db.prepare("SELECT COALESCE(SUM(deposit_paid-deposit_refunded),0) a FROM merchants WHERE id=? AND status<>'terminated'").get(id)
  assert.equal(heldRow.a, 2000, '该未解约商户保证金仍占用')
  assert.ok(s.operating >= 1)
})
