# NDX 五因子量化定投助手

一个跑在 iPhone 上的极简 PWA（渐进式网页应用），每天给出纳斯达克 100 指数的量化定投建议。

## 功能

- **行情**: 自动拉取 `^NDX` 实时收盘 + 历史 2 年数据（Yahoo Finance）
- **PE 估值**: 抓取 QQQ TTM PE，与历史平均（默认 24，可在设置里改）做对比，给出独立的 PE 建议
- **5 因子打分**（每个 0–100，分高 = 适合多投）：
  1. 估值因子（PE 偏离 60% + 价格 vs MA200 40%）
  2. RSI(14) 超卖
  3. 距 52 周高点回撤
  4. 20 日年化波动率
  5. 趋势确认（MA50 vs MA200）
- **综合分 → 当日建议倍数**（基于基准定投金额）：
  - `0–20`: **0.5×** （市场偏热，减仓/暂停）
  - `20–40`: **0.75×**
  - `40–60`: **1.0×** （按计划）
  - `60–80`: **1.5×**
  - `80–100`: **2.0×** （极度低估，重仓加码）
- **离线缓存**: 安装为 PWA 后断网也能查看上一次结果
- **币种**: 支持 USD / CNY 显示切换

## 在 iPhone 上使用

### 方式一: GitHub Pages（推荐，零成本一键部署）

1. 把这个仓库 Push 到 GitHub
2. 仓库设置 → **Pages** → Source 选 **GitHub Actions**
3. `.github/workflows/pages.yml` 会自动构建并部署
4. 拿到 `https://<你的用户名>.github.io/ndx/` 链接
5. iPhone Safari 打开 → 点底部分享按钮 → **添加到主屏幕**
6. 主屏图标点开就是全屏 App 体验，无浏览器边框

### 方式二: 直接打开本地文件

把整个文件夹通过 AirDrop 或 iCloud 传到 iPhone，用 Safari/Files 打开 `index.html` 即可（但 PWA 安装能力会受限）。

### 方式三: 自己的服务器

任何 HTTPS 静态托管都能跑：Vercel / Netlify / Cloudflare Pages 等，把仓库连过去即可。

## 文件结构

```
.
├── index.html      # 主界面
├── styles.css      # iOS 暗色样式
├── app.js          # 数据抓取 + 5 因子计算 + 渲染
├── sw.js           # Service Worker（离线壳）
├── manifest.json   # PWA 元数据
├── icons/          # PWA 图标
└── .github/workflows/pages.yml  # 自动部署
```

## 自定义

在 `app.js` 顶部可以改：

- `RANGE`: 默认 `2y`，影响 MA200 / 52 周高点的样本
- 因子权重在 `computeFactors` 内是等权（除估值因子内部 6:4），想调整就改加权方式
- `scoreToMultiplier`: 改分数到投入倍数的映射
- 估值因子里 PE 与 MA200 的 60/40 权重

设置面板里可调：

- 基准定投金额
- 币种显示（CNY 用固定汇率 7.2，需要更精确请改 `fmtMoney`）
- 当前 PE 手动覆盖（若 Yahoo 抓不到 QQQ PE 时使用）
- 历史平均 PE（默认 24，可根据自己的数据源更新）

## 数据源说明

- **行情**: Yahoo Finance Chart API (`query1.finance.yahoo.com/v8/finance/chart/^NDX`)
- **PE**: Yahoo Finance Quote API (`query1.finance.yahoo.com/v7/finance/quote?symbols=QQQ`) 的 `trailingPE` 字段
- 浏览器 CORS 拦截时自动走 `corsproxy.io` / `allorigins.win` 公共代理
- 全部失败时回退到 localStorage 上一次成功的快照

## 免责声明

本工具仅供个人量化策略研究与定投纪律辅助，不构成任何投资建议。回测与历史规律不代表未来收益。
