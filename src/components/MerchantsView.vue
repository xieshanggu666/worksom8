<script setup>
import { ref, computed } from 'vue'
import { useParkStore, newRequestId } from '@/store/park'

const store = useParkStore()
const tab = ref('merchants')
const tabs = [
  { k: 'merchants', icon: '🏪', label: '联营商户' },
  { k: 'applications', icon: '📝', label: '入驻审核' },
  { k: 'cashier', icon: '🧾', label: '联营收银' },
  { k: 'settlements', icon: '💰', label: '分账结算' },
  { k: 'config', icon: '⚙️', label: '招商配置' }
]

const STATUS = {
  applied: { t: '待审核', c: 'var(--accent2)' },
  rejected: { t: '已驳回', c: 'var(--red)' },
  signed: { t: '已签约', c: 'var(--blue)' },
  operating: { t: '营业中', c: 'var(--green)' },
  suspended: { t: '已暂停', c: 'var(--accent2)' },
  terminated: { t: '已解约', c: 'var(--muted)' }
}
const st = s => STATUS[s] || { t: s, c: 'var(--muted)' }
const BILL_STATUS = {
  pending: { t: '待确认', c: 'var(--accent2)' },
  confirmed: { t: '待付款', c: 'var(--blue)' },
  paid: { t: '已结清', c: 'var(--green)' }
}
const pct = v => Math.round((Number(v) || 0) * 100)
const money = v => '¥' + (Number(v) || 0).toLocaleString()

const stats = computed(() => store.merchantStats)
const cfg = computed(() => store.merchantConfig)
const zones = computed(() => store.zones)

// ---------------- 入驻审核 ----------------
const applications = computed(() => store.merchants.filter(m => m.status === 'applied'))
const applyModal = ref(false)
const applyForm = ref({})
function openApply() {
  applyForm.value = {
    name: '', contact: '', phone: '', category: '餐饮', zone_id: zones.value[0]?.id || 1,
    price: 25, commission_rate: cfg.value.defaultCommission, deposit: cfg.value.defaultDeposit,
    contract_periods: cfg.value.contractPeriods, apply_note: ''
  }
  applyModal.value = true
}
async function submitApply() {
  const r = await store.applyMerchant({ ...applyForm.value, request_id: newRequestId() })
  if (r.ok) applyModal.value = false
  else alert(r.msg || '申请失败')
}
async function approve(m) {
  const rate = prompt(`确认与「${m.name}」签约。核定园区抽成比例（0.05~0.8，当前申请 ${pct(m.commission_rate)}%）：`, m.commission_rate)
  if (rate === null) return
  const r = await store.approveMerchant(m.id, { commission_rate: Number(rate), request_id: newRequestId() })
  if (!r.ok) alert(r.msg || '签约失败')
}
async function reject(m) {
  const reason = prompt(`驳回「${m.name}」的入驻申请，请填写原因：`, '资质材料不全')
  if (!reason) return
  const r = await store.rejectMerchant(m.id, { reason })
  if (!r.ok) alert(r.msg || '操作失败')
}

// ---------------- 商户列表 ----------------
const listFilter = ref('all')
const merchants = computed(() => store.merchants.filter(m => listFilter.value === 'all' || m.status === listFilter.value))
const detailModal = ref(false)
const detail = ref(null)
const detailTab = ref('sales')
async function openDetail(m) {
  const r = await store.merchantDetail(m.id)
  if (!r.ok) return alert(r.msg || '加载失败')
  detail.value = r
  detailTab.value = 'sales'
  detailModal.value = true
}

// 经营物资绑定
const linkIds = ref([])
function startLink() {
  linkIds.value = (detail.value.merchant.materials || []).map(x => x.id)
}
async function saveLink() {
  const r = await store.setMerchantMaterials(detail.value.merchant.id, linkIds.value)
  if (r.ok) await refreshDetail()
  else alert(r.msg || '保存失败')
}
async function refreshDetail() {
  const r = await store.merchantDetail(detail.value.merchant.id)
  if (r.ok) detail.value = r
}

async function suspend(m) {
  const reason = prompt(`暂停「${m.name}」营业的原因：`, '运营管控整改')
  if (!reason) return
  const r = await store.suspendMerchant(m.id, { reason })
  if (!r.ok) alert(r.msg)
}
async function resume(m) {
  const r = await store.resumeMerchant(m.id)
  if (!r.ok) alert(r.msg)
}
async function terminate(m) {
  if (!confirm(`确认与「${m.name}」解约？系统将自动结清全部未付账期并退还保证金 ${money(m.deposit_paid - m.deposit_refunded)}。`)) return
  const r = await store.terminateMerchant(m.id, { reason: '运营办理解约' })
  if (!r.ok) alert(r.msg || '解约失败')
  else if (detailModal.value) await refreshDetail()
}

// ---------------- 收银 / 退货 / 罚款 ----------------
const cashierMerchantId = ref(null)
const cashier = ref({ qty: 1, member_id: null })
async function doSale() {
  const id = cashierMerchantId.value
  if (!id) return alert('请选择联营商户')
  const r = await store.merchantSale(id, {
    qty: Number(cashier.value.qty) || 1,
    member_id: cashier.value.member_id ? Number(cashier.value.member_id) : null,
    request_id: newRequestId()
  })
  if (r.ok) {
    alert(`收银成功 ${money(r.amount)}（园方佣金 ${money(r.commission)} / 商户应分 ${money(r.share)}${r.points ? `，会员获 ${r.points} 积分` : ''}）`)
    cashier.value = { qty: 1, member_id: null }
  } else alert(r.msg || '收银失败')
}

const refundSaleId = ref(null)
const refundQty = ref(1)
async function doRefund() {
  if (!detail.value) return
  // 接受数字 id 或「LS0001」流水号
  const raw = String(refundSaleId.value || '').trim()
  const saleId = raw ? Number(raw.replace(/^LS/i, '').replace(/^0+/, '') || raw.replace(/\D/g, '')) : null
  const r = await store.merchantRefund(detail.value.merchant.id, {
    sale_id: saleId || null,
    qty: Number(refundQty.value) || 1,
    reason: '前台办理游客退货',
    request_id: newRequestId()
  })
  if (r.ok) {
    alert(`退款 ${money(r.amount)} 已完成${r.settled ? '（原销售已结算，商户承担部分结转下期）' : '（未结算红冲）'}`)
    refundSaleId.value = null; refundQty.value = 1
    await refreshDetail()
  } else alert(r.msg || '退款失败')
}

const fineAmount = ref(0)
const fineNote = ref('')
async function doFine() {
  if (!detail.value) return
  if (!(Number(fineAmount.value) > 0)) return alert('请填写扣款金额')
  const r = await store.merchantFine(detail.value.merchant.id, {
    amount: Number(fineAmount.value), note: fineNote.value || '运营登记违约扣款'
  })
  if (r.ok) { fineAmount.value = 0; fineNote.value = ''; await refreshDetail() }
  else alert(r.msg || '登记失败')
}

// 会员选择（简单检索）
const memberKeyword = ref('')
const memberOptions = computed(() => {
  const kw = memberKeyword.value.trim()
  const list = store.members
  if (!kw) return list.slice(0, 8)
  return list.filter(m => m.code.includes(kw) || m.name.includes(kw) || (m.phone || '').includes(kw)).slice(0, 8)
})

// ---------------- 结算 ----------------
const billFilter = ref('all')
const bills = computed(() => store.merchantSettlements.filter(b => billFilter.value === 'all' || b.status === billFilter.value))
async function genBill(m) {
  const r = await store.createMerchantSettlement(m.id, { note: '运营手动生成结算单' })
  if (!r.ok) alert(r.msg || '生成失败')
}
async function confirmBill(b) {
  const r = await store.confirmMerchantSettlement(b.id)
  if (!r.ok) alert(r.msg || '确认失败')
}
async function payBill(b) {
  if (!confirm(`确认支付「${b.merchant_name}」结算款 ${money(b.merchant_net)}？`)) return
  const r = await store.payMerchantSettlement(b.id, newRequestId())
  if (!r.ok) alert(r.msg || '付款失败')
}

// ---------------- 配置 ----------------
const configForm = ref({})
function editConfig() {
  configForm.value = { ...cfg.value, default_commission: cfg.value.defaultCommission, default_deposit: cfg.value.defaultDeposit }
}
async function saveConfig() {
  const r = await store.saveMerchantConfig({
    enabled: configForm.value.enabled ? 1 : 0,
    default_commission: Number(configForm.value.default_commission),
    default_deposit: Number(configForm.value.default_deposit),
    contract_periods: Number(configForm.value.contract_periods),
    auto_settle: configForm.value.autoSettle ? 1 : 0
  })
  if (!r.ok) alert(r.msg || '保存失败')
}
editConfig()

const stockCls = s => ({ out: 'st-out', low: 'st-low', ok: 'st-ok', none: '' }[s] || '')
const stockText = s => ({ out: '断货', low: '偏低', ok: '库存充足', none: '未管库存' }[s] || '-')
const catIcon = c => ({ '餐饮': '🍔', '饮品': '🥤', '文创': '🎁', '零售': '🛍️', '游乐服务': '🎠' }[c] || '🏪')
</script>

<template>
  <div class="merchants">
    <!-- 统计条 -->
    <div class="stat-row">
      <div class="stat card"><em>待审核</em><b class="warn">{{ stats.applied }}</b></div>
      <div class="stat card"><em>营业中</em><b class="ok">{{ stats.operating }}</b></div>
      <div class="stat card"><em>已暂停</em><b>{{ stats.suspended }}</b></div>
      <div class="stat card"><em>累计联营流水</em><b class="money">{{ stats.totalSalesAmount.toLocaleString() }}</b></div>
      <div class="stat card"><em>累计园方佣金</em><b class="money">{{ stats.totalCommission.toLocaleString() }}</b></div>
      <div class="stat card"><em>已付商户分成</em><b>{{ stats.totalSettled.toLocaleString() }}</b></div>
      <div class="stat card"><em>违约扣款累计</em><b class="warn">{{ stats.totalFine.toLocaleString() }}</b></div>
      <div class="stat card"><em>保证金占用</em><b>{{ stats.depositHeld.toLocaleString() }}</b></div>
    </div>

    <div class="tabs">
      <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">
        {{ t.icon }} {{ t.label }}
        <span v-if="t.k === 'applications' && stats.applied" class="dot">{{ stats.applied }}</span>
        <span v-if="t.k === 'settlements' && stats.payableBills.n" class="dot red">{{ stats.payableBills.n }}</span>
      </button>
    </div>

    <!-- 入驻审核 -->
    <div v-if="tab === 'applications'">
      <div class="bar">
        <span class="muted">商户申请入驻 → 运营资质审核 → 核定抽成/保证金 → 签约收款开张</span>
        <button class="primary" @click="openApply">＋ 录入入驻申请</button>
      </div>
      <div class="card" v-if="!applications.length"><p class="muted">暂无待审核申请。</p></div>
      <div class="cards">
        <div class="mcard card" v-for="m in applications" :key="m.id">
          <div class="mhead">
            <span class="ic">{{ catIcon(m.category) }}</span>
            <div><b>{{ m.name }}</b><em class="muted">{{ m.code }} · {{ m.category }} · {{ m.zone_name }}</em></div>
            <span class="tag" :style="{ color: st(m.status).c, borderColor: st(m.status).c + '66' }">{{ st(m.status).t }}</span>
          </div>
          <div class="mgrid">
            <div><em>联系人</em><b>{{ m.contact || '-' }} {{ m.phone }}</b></div>
            <div><em>拟抽成</em><b class="warn">{{ pct(m.commission_rate) }}%</b></div>
            <div><em>保证金</em><b>{{ money(m.deposit) }}</b></div>
            <div><em>客单价</em><b>{{ money(m.price) }}</b></div>
            <div><em>签约周期</em><b>{{ m.contract_periods }} 天</b></div>
          </div>
          <p class="note muted" v-if="m.apply_note">申请说明：{{ m.apply_note }}</p>
          <div class="acts">
            <button class="succ" @click="approve(m)">审核通过并签约</button>
            <button class="danger" @click="reject(m)">驳回</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 商户列表 -->
    <div v-if="tab === 'merchants'">
      <div class="bar">
        <div class="filters">
          <button :class="{ on: listFilter === 'all' }" @click="listFilter = 'all'">全部</button>
          <button :class="{ on: listFilter === 'operating' }" @click="listFilter = 'operating'">营业中</button>
          <button :class="{ on: listFilter === 'suspended' }" @click="listFilter = 'suspended'">已暂停</button>
          <button :class="{ on: listFilter === 'terminated' }" @click="listFilter = 'terminated'">已解约</button>
        </div>
        <button class="primary" @click="openApply">＋ 入驻申请</button>
      </div>
      <div class="table card">
        <table>
          <thead><tr>
            <th>商户</th><th>品类/区域</th><th>状态</th><th>库存</th><th>抽成</th><th>累计流水</th><th>佣金</th>
            <th>待结算/待付</th><th>合同</th><th>操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="m in merchants" :key="m.id">
              <td><b>{{ m.name }}</b><div class="muted">{{ m.code }} · {{ m.contact }}</div></td>
              <td>{{ catIcon(m.category) }} {{ m.category }}<div class="muted">{{ m.zone_name }}</div></td>
              <td><span class="tag" :style="{ color: st(m.status).c, borderColor: st(m.status).c + '66' }">{{ st(m.status).t }}</span>
                <div v-if="m.contract_expired" class="warn tiny">合同已到期</div></td>
              <td><span :class="['stk', stockCls(m.stock_status)]">{{ stockText(m.stock_status) }}</span></td>
              <td>{{ pct(m.commission_rate) }}%</td>
              <td class="money">{{ m.sales_amount.toLocaleString() }}</td>
              <td>{{ m.commission_amount.toLocaleString() }}</td>
              <td>
                <div class="money">{{ m.settlement_due.toLocaleString() }}</div>
                <div v-if="m.pending_bill_count" class="tiny warn">{{ m.pending_bill_count }} 张待处理账单</div>
                <div v-if="m.pending_adjust" class="tiny warn">待扣调整 {{ money(m.pending_adjust) }}</div>
              </td>
              <td class="muted">第{{ m.contract_day }}~{{ m.expire_day }}天</td>
              <td class="ops">
                <button @click="openDetail(m)">详情/账单</button>
                <button v-if="m.status === 'operating'" class="ghost" @click="suspend(m)">暂停</button>
                <button v-if="m.status === 'suspended'" class="succ" @click="resume(m)">恢复</button>
                <button v-if="['operating','suspended'].includes(m.status)" class="danger" @click="terminate(m)">解约</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 联营收银 -->
    <div v-if="tab === 'cashier'" class="grid2">
      <div class="card">
        <h3>🧾 联营商户收银（园区统一收款 · 自动分账）</h3>
        <label class="fld">联营商户
          <select v-model="cashierMerchantId">
            <option :value="null" disabled>请选择营业中商户</option>
            <option v-for="m in store.merchants.filter(x => x.status === 'operating')" :key="m.id" :value="m.id">
              {{ m.code }} {{ m.name }}（{{ pct(m.commission_rate) }}% 抽成 · 单价 {{ money(m.price) }}）
            </option>
          </select>
        </label>
        <label class="fld">数量 <input type="number" min="1" v-model.number="cashier.qty" /></label>
        <label class="fld">会员（可选，享卡折扣/积分）
          <input v-model="memberKeyword" placeholder="输入会员号/姓名/手机号检索" />
          <select v-model="cashier.member_id">
            <option :value="null">散客（不打折）</option>
            <option v-for="m in memberOptions" :key="m.id" :value="m.id">{{ m.code }} {{ m.name }}（{{ m.card_tier }}）</option>
          </select>
        </label>
        <button class="primary" @click="doSale">确认收银并分账</button>
        <p class="muted tiny">销售款全额进入园区现金账户，系统按合同抽成即时拆分「园方佣金 / 商户应分」，绑定物资同步 FEFO 扣库存。</p>
      </div>
      <div class="card">
        <h3>📈 今日联营销售</h3>
        <div class="mgrid">
          <div><em>销售件数</em><b>{{ stats.todaySalesQty }}</b></div>
          <div><em>销售流水</em><b class="money">{{ money(stats.todaySalesAmount) }}</b></div>
          <div><em>园方佣金</em><b class="money">{{ money(stats.todayCommission) }}</b></div>
          <div><em>退货退款</em><b class="warn">{{ money(stats.todayRefund) }}</b></div>
        </div>
        <h3 style="margin-top:14px">最近销售流水</h3>
        <div class="mini-list">
          <div v-for="s in store.merchantSales.slice(0, 12)" :key="s.id" class="mini-row">
            <span>{{ s.code }} · {{ s.merchant_name }}</span>
            <span class="muted">{{ s.source === 'member' ? '会员' + (s.member_tier || '') : s.source === 'auto' ? '散客(模拟)' : '散客' }} ×{{ s.qty }}</span>
            <b class="money">{{ money(s.amount) }}</b>
            <span class="tiny muted">佣 {{ money(s.commission) }}</span>
            <span class="tag" v-if="s.settle_id">已结算</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 分账结算 -->
    <div v-if="tab === 'settlements'">
      <div class="bar">
        <div class="filters">
          <button :class="{ on: billFilter === 'all' }" @click="billFilter = 'all'">全部</button>
          <button :class="{ on: billFilter === 'pending' }" @click="billFilter = 'pending'">待确认</button>
          <button :class="{ on: billFilter === 'confirmed' }" @click="billFilter = 'confirmed'">待付款</button>
          <button :class="{ on: billFilter === 'paid' }" @click="billFilter = 'paid'">已结清</button>
        </div>
        <span class="muted">日结可自动生成待确认账单；确认时确认违约收入，付款后现金支付商户分成。</span>
      </div>
      <div class="table card">
        <table>
          <thead><tr><th>结算单</th><th>商户</th><th>账期</th><th>净流水</th><th>园方佣金</th><th>商户分成</th><th>违约扣款</th><th>实付商户</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="b in bills" :key="b.id">
              <td>{{ b.code }}</td>
              <td>{{ b.merchant_code }} {{ b.merchant_name }}</td>
              <td class="muted">第{{ b.day_from }}~{{ b.day_to }}天</td>
              <td class="money">{{ b.sales_amount.toLocaleString() }}</td>
              <td>{{ b.commission_amount.toLocaleString() }}</td>
              <td>{{ b.merchant_gross.toLocaleString() }}</td>
              <td class="warn">{{ b.fine_amount ? money(b.fine_amount) : '-' }}</td>
              <td><b class="money">{{ money(b.merchant_net) }}</b></td>
              <td><span class="tag" :style="{ color: BILL_STATUS[b.status].c, borderColor: BILL_STATUS[b.status].c + '66' }">{{ BILL_STATUS[b.status].t }}</span></td>
              <td class="ops">
                <button v-if="b.status === 'pending'" class="succ" @click="confirmBill(b)">确认账单</button>
                <button v-if="b.status === 'confirmed'" class="primary" @click="payBill(b)">付款结清</button>
                <span v-else class="muted tiny">{{ b.paid_amount ? money(b.paid_amount) : '' }}</span>
              </td>
            </tr>
            <tr v-if="!bills.length"><td colspan="10" class="muted">暂无结算单。营业商户产生销售后，可在商户详情手动出账；开启日结自动出账后系统每日生成。</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 招商配置 -->
    <div v-if="tab === 'config'" class="grid2">
      <div class="card">
        <h3>⚙️ 联营招商政策</h3>
        <label class="fld">模块开关
          <select v-model="configForm.enabled"><option :value="1">开放招商与联营经营</option><option :value="0">暂停（停止模拟联营销售）</option></select>
        </label>
        <label class="fld">默认抽成比例（5%~80%）
          <input type="number" step="0.01" min="0.05" max="0.8" v-model.number="configForm.default_commission" />
          <em class="muted tiny">{{ pct(configForm.default_commission) }}%（签约时可逐户核定）</em>
        </label>
        <label class="fld">默认保证金（元）<input type="number" min="0" v-model.number="configForm.default_deposit" /></label>
        <label class="fld">默认签约周期（游戏日）<input type="number" min="1" v-model.number="configForm.contract_periods" /></label>
        <label class="fld">日结自动出账
          <select v-model="configForm.autoSettle"><option :value="1">每日闭园自动生成截至昨日的结算单（待确认）</option><option :value="0">关闭，仅手动出账</option></select>
        </label>
        <button class="primary" @click="saveConfig">保存配置</button>
      </div>
      <div class="card">
        <h3>📖 分账与结算口径</h3>
        <ul class="rules">
          <li>园区统一收银：销售款（含会员折扣后实付）全额流入园区，财务科目「联营销售」。</li>
          <li>逐笔拆分：园方佣金 = 流水 × 抽成比例；其余为商户应分，付款前一直挂在园区。</li>
          <li>会员优惠：会员享卡等级商铺折扣并按实付赚积分；退货按比例回退积分。</li>
          <li>库存联动：商户绑定的物资销售按 FEFO 先到期先出消耗，缺货整单不成交（散客流量记缺货流失）。</li>
          <li>投诉违约：联营商户投诉可登记违约扣款，随下一结算单从商户分成扣减，确认账单时记「违约收入」。</li>
          <li>退货：未结算直接红冲；已结算的退货商户承担部分结转下期，从下一账单扣减。</li>
          <li>结算付款：账单确认后现金支付商户净额（「联营结算」）；合同到期自动暂停，解约时自动清算并退保证金。</li>
        </ul>
      </div>
    </div>

    <!-- 入驻申请弹窗 -->
    <div class="modal" v-if="applyModal">
      <div class="modal-box card">
        <h3>📝 联营商户入驻申请</h3>
        <div class="form">
          <label>商户/品牌名称 <input v-model="applyForm.name" placeholder="如：星岛咖啡联营店" /></label>
          <div class="row2">
            <label>联系人 <input v-model="applyForm.contact" /></label>
            <label>电话 <input v-model="applyForm.phone" /></label>
          </div>
          <div class="row2">
            <label>经营品类
              <select v-model="applyForm.category">
                <option>餐饮</option><option>饮品</option><option>文创</option><option>零售</option><option>游乐服务</option>
              </select>
            </label>
            <label>经营区域
              <select v-model.number="applyForm.zone_id"><option v-for="z in zones.filter(z=>z.unlocked)" :key="z.id" :value="z.id">{{ z.name }}</option></select>
            </label>
          </div>
          <div class="row3">
            <label>客单价(元) <input type="number" min="1" v-model.number="applyForm.price" /></label>
            <label>抽成比例 <input type="number" step="0.01" min="0.05" max="0.8" v-model.number="applyForm.commission_rate" /></label>
            <label>保证金(元) <input type="number" min="0" v-model.number="applyForm.deposit" /></label>
          </div>
          <label>签约周期（游戏日） <input type="number" min="1" v-model.number="applyForm.contract_periods" /></label>
          <label>申请说明 <textarea rows="2" v-model="applyForm.apply_note" placeholder="品牌资质、经营方案、用工情况等"></textarea></label>
        </div>
        <div class="acts">
          <button class="primary" @click="submitApply">提交申请</button>
          <button class="ghost" @click="applyModal = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 商户详情抽屉 -->
    <div class="modal wide" v-if="detailModal">
      <div class="modal-box card">
        <div class="dhead">
          <h3>{{ catIcon(detail.merchant.category) }} {{ detail.merchant.name }}
            <span class="tag" :style="{ color: st(detail.merchant.status).c, borderColor: st(detail.merchant.status).c + '66' }">{{ st(detail.merchant.status).t }}</span>
          </h3>
          <button class="ghost" @click="detailModal = false">✕</button>
        </div>
        <div class="mgrid">
          <div><em>抽成比例</em><b>{{ pct(detail.merchant.commission_rate) }}%</b></div>
          <div><em>保证金(已收/已退)</em><b>{{ money(detail.merchant.deposit_paid) }} / {{ money(detail.merchant.deposit_refunded) }}</b></div>
          <div><em>合同</em><b>第{{ detail.merchant.contract_day }}~{{ detail.merchant.expire_day }}天</b></div>
          <div><em>累计流水</em><b class="money">{{ money(detail.merchant.sales_amount) }}</b></div>
          <div><em>累计佣金</em><b>{{ money(detail.merchant.commission_amount) }}</b></div>
          <div><em>已付分成</em><b>{{ money(detail.merchant.settled_amount) }}</b></div>
          <div><em>违约扣款</em><b class="warn">{{ money(detail.merchant.fine_amount) }}</b></div>
          <div><em>退货退款</em><b>{{ money(detail.merchant.refund_amount) }}</b></div>
        </div>

        <div class="dtabs">
          <button :class="{ on: detailTab === 'sales' }" @click="detailTab = 'sales'">销售流水</button>
          <button :class="{ on: detailTab === 'refunds' }" @click="detailTab = 'refunds'">退货退款</button>
          <button :class="{ on: detailTab === 'bills' }" @click="detailTab = 'bills'">结算单/调整</button>
          <button :class="{ on: detailTab === 'stock' }" @click="detailTab = 'stock'; startLink()">经营物资(库存)</button>
          <button :class="{ on: detailTab === 'logs' }" @click="detailTab = 'logs'">时间线</button>
        </div>

        <div class="dbody">
          <template v-if="detailTab === 'sales'">
            <div class="quick">
              <span class="muted tiny">退货：输入流水号（留空=无单退货）</span>
              <input style="width:120px" v-model="refundSaleId" placeholder="LS 流水号 id" />
              <input style="width:80px" type="number" min="1" v-model.number="refundQty" placeholder="数量" />
              <button class="danger" @click="doRefund">办理退货退款</button>
            </div>
            <table class="inner"><thead><tr><th>流水号</th><th>时间(天)</th><th>来源</th><th>数量</th><th>单价</th><th>实收</th><th>佣金</th><th>商户应分</th><th>结算</th></tr></thead>
              <tbody><tr v-for="s in detail.sales" :key="s.id">
                <td>{{ s.code }}</td><td>{{ s.day }}</td>
                <td>{{ s.source === 'member' ? '会员' + s.member_tier : s.source === 'auto' ? '散客' : '散客' }}</td>
                <td>{{ s.qty }}</td><td>{{ s.price }}</td>
                <td class="money">{{ money(s.amount) }}</td><td>{{ money(s.commission) }}</td><td>{{ money(s.merchant_share) }}</td>
                <td><span class="tag" v-if="s.settle_id">LC{{ String(s.settle_id).padStart(4,'0') }}</span><span v-else class="tiny warn">待结算</span></td>
              </tr></tbody>
            </table>
          </template>

          <template v-else-if="detailTab === 'refunds'">
            <table class="inner"><thead><tr><th>退货号</th><th>天</th><th>原流水</th><th>数量</th><th>退款</th><th>商户承担</th><th>积分回退</th><th>处理</th><th>原因</th></tr></thead>
              <tbody><tr v-for="r in detail.refunds" :key="r.id">
                <td>{{ r.code }}</td><td>{{ r.day }}</td><td>{{ r.sale_id ? 'LS' + String(r.sale_id).padStart(4,'0') : '无单' }}</td>
                <td>{{ r.qty }}</td><td class="warn">{{ money(r.amount) }}</td><td>{{ money(r.merchant_back) }}</td>
                <td>{{ r.points_clawback || '-' }}</td>
                <td><span class="tag" v-if="r.settled">已结算·结转</span><span v-else class="tag">红冲</span></td>
                <td class="muted tiny">{{ r.reason }}</td>
              </tr></tbody>
            </table>
          </template>

          <template v-else-if="detailTab === 'bills'">
            <div class="quick">
              <button class="primary" @click="genBill(detail.merchant)">生成结算单（截至今日）</button>
              <span class="muted tiny">待归集违约/调整：{{ money(detail.merchant.pending_adjust) }}</span>
            </div>
            <table class="inner"><thead><tr><th>结算单</th><th>账期</th><th>净流水</th><th>佣金</th><th>分成</th><th>罚款</th><th>调整</th><th>实付</th><th>状态</th></tr></thead>
              <tbody><tr v-for="b in detail.settlements" :key="b.id">
                <td>{{ b.code }}</td><td>{{ b.day_from }}~{{ b.day_to }}</td>
                <td class="money">{{ b.sales_amount }}</td><td>{{ b.commission_amount }}</td><td>{{ b.merchant_gross }}</td>
                <td class="warn">{{ b.fine_amount || '-' }}</td><td>{{ b.adjust_amount || '-' }}</td><td><b>{{ money(b.merchant_net) }}</b></td>
                <td><span class="tag" :style="{ color: BILL_STATUS[b.status].c, borderColor: BILL_STATUS[b.status].c + '66' }">{{ BILL_STATUS[b.status].t }}</span></td>
              </tr></tbody>
            </table>
            <h4 style="margin:12px 0 6px">周期调整（违约扣款 / 已结算退货结转）</h4>
            <table class="inner"><thead><tr><th>类型</th><th>金额</th><th>说明</th><th>归属结算单</th><th>天</th></tr></thead>
              <tbody><tr v-for="a in detail.adjustments" :key="a.id">
                <td>{{ a.kind === 'fine' ? '违约扣款' : a.kind === 'refund_carry' ? '退货结转' : '人工调整' }}</td>
                <td class="warn">{{ money(a.amount) }}</td><td class="muted tiny">{{ a.note }}</td>
                <td>{{ a.settle_id ? 'LC' + String(a.settle_id).padStart(4,'0') : '待结算' }}</td><td>{{ a.day }}</td>
              </tr></tbody>
            </table>
          </template>

          <template v-else-if="detailTab === 'stock'">
            <p class="muted tiny">勾选联营销售受库存联动的物资（复用采购批次/FEFO/盘点体系）；不勾选则该商户销售不受库存约束。</p>
            <div class="matpick">
              <label v-for="m in store.materials" :key="m.id">
                <input type="checkbox" :value="m.id" v-model="linkIds" />
                {{ m.name }}
                <span :class="['stk', stockCls(m.stock_status)]">{{ m.qty_on_hand }}{{ m.unit }}</span>
              </label>
            </div>
            <button class="succ" @click="saveLink">保存物资绑定</button>
          </template>

          <template v-else>
            <div class="logs">
              <div v-for="l in detail.logs" :key="l.id" class="logrow">
                <span class="ltime">第{{ l.day }}天 {{ l.hour }}:00</span>
                <span class="laction">{{ l.action }}</span>
                <span class="muted tiny">{{ l.note }}</span>
              </div>
            </div>
          </template>
        </div>

        <div class="dfine card-panel" v-if="['operating','suspended'].includes(detail.merchant.status)">
          <b>投诉违约扣款（随下一结算单扣商户分成）</b>
          <input type="number" min="1" v-model.number="fineAmount" placeholder="扣款金额（元）" />
          <input v-model="fineNote" placeholder="扣款事由（如卫生不达标/售卖变质食品）" />
          <button class="danger" @click="doFine">登记违约扣款</button>
        </div>

        <div class="acts">
          <button v-if="detail.merchant.status === 'operating'" class="ghost" @click="suspend(detail.merchant); detailModal = false">暂停营业</button>
          <button v-if="detail.merchant.status === 'suspended'" class="succ" @click="resume(detail.merchant); refreshDetail()">恢复营业</button>
          <button v-if="['operating','suspended'].includes(detail.merchant.status)" class="danger" @click="terminate(detail.merchant)">解约清算退保证金</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.merchants { display: flex; flex-direction: column; gap: 14px; }
.stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.stat { padding: 12px; text-align: center; }
.stat em { display: block; font-style: normal; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.stat b { font-size: 18px; }
.ok { color: var(--green); } .warn { color: var(--accent2); }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.tabs button { position: relative; }
.tabs button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.dot { margin-left: 6px; background: var(--accent2); color: #332; border-radius: 20px; padding: 0 7px; font-size: 11px; }
.dot.red { background: var(--red); color: #fff; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.filters { display: flex; gap: 6px; }
.filters button.on { background: var(--panel2); border-color: var(--accent); color: var(--accent); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.mcard { display: flex; flex-direction: column; gap: 10px; }
.mhead { display: flex; align-items: center; gap: 10px; }
.mhead .ic { font-size: 30px; }
.mhead b { display: block; } .mhead em { font-style: normal; font-size: 12px; }
.mgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
.mgrid div { background: var(--panel2); border-radius: 8px; padding: 8px; text-align: center; }
.mgrid em { display: block; font-style: normal; font-size: 11px; color: var(--muted); }
.mgrid b { font-size: 14px; }
.note { font-size: 12px; }
.acts { display: flex; gap: 8px; flex-wrap: wrap; }
.table { overflow-x: auto; padding: 6px 10px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 9px 8px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
.ops { display: flex; gap: 6px; }
.ops button { padding: 4px 10px; font-size: 12px; }
.tiny { font-size: 11px; }
.stk { font-size: 11px; padding: 1px 7px; border-radius: 12px; border: 1px solid var(--border); color: var(--muted); }
.st-ok { color: var(--green); border-color: rgba(109,213,160,.4); background: rgba(109,213,160,.1); }
.st-low { color: var(--accent2); border-color: rgba(255,209,102,.4); background: rgba(255,209,102,.1); }
.st-out { color: var(--red); border-color: rgba(255,107,107,.45); background: rgba(255,107,107,.13); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.fld { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); margin-bottom: 12px; }
.fld input, .fld select { color: var(--text); }
.rules { padding-left: 18px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--muted); }
.mini-list { display: flex; flex-direction: column; gap: 6px; max-height: 280px; overflow: auto; }
.mini-row { display: flex; align-items: center; gap: 10px; font-size: 12px; background: var(--panel2); padding: 6px 8px; border-radius: 8px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-box { width: min(520px, 94vw); max-height: 92vh; overflow: auto; }
.modal.wide .modal-box { width: min(1000px, 96vw); }
.form { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
.dhead { display: flex; justify-content: space-between; align-items: center; }
.dtabs { display: flex; gap: 6px; margin: 12px 0; flex-wrap: wrap; }
.dtabs button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.dbody { max-height: 46vh; overflow: auto; margin-bottom: 10px; }
.inner { font-size: 12px; }
.quick { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.matpick { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px; margin-bottom: 10px; }
.matpick label { display: flex; align-items: center; gap: 6px; font-size: 13px; background: var(--panel2); padding: 6px 8px; border-radius: 8px; }
.logs { display: flex; flex-direction: column; gap: 6px; }
.logrow { display: flex; gap: 10px; align-items: baseline; font-size: 12px; background: var(--panel2); padding: 6px 8px; border-radius: 8px; }
.ltime { color: var(--muted); } .laction { color: var(--blue); min-width: 90px; }
.card-panel { background: var(--panel2); margin: 10px 0; padding: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.card-panel input { flex: 1; min-width: 140px; }
@media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
</style>
