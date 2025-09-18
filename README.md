# CCXT WebSocket 监控（Binance 专用）
## Thanks CCXT 

一个基于 Node.js 的终端行情监控工具，支持 Binance 现货、USDM 永续、COINM 永续，使用原生 WebSocket 保证“实时”行情；REST 仅用于数据回补（24h 统计、OI、资金费率、分钟K线）。

## 功能特性
- 中文终端表格，固定网格、内容刷新
- 原生 WS 实时推送：现货/USDM/COINM 的 trade 与 bookTicker
- 24h 涨跌（百分比，严格正负着色）、5m/30m/24h 成交额（计价，M单位）
- 未平仓（OI，张数，M单位）
- 资金费率（正红负绿，接近 0 不着色），并显示下一次资金费率“倒计时”
- 市场类型区分与上色：现货=蓝，USDM=黄，COINM=紫
- 关键词智能匹配：只需输入代币本名即可匹配期货前缀型（如 1000PEPE），1INCH 为例外（视为完整代币名）
- 强化筛选：只展示永续（PERPETUAL），过滤 TRY 计价及非白名单计价
- 多域名回退与代理支持，弱网环境更稳

## 环境要求
- Node.js 18+
- 支持类 Unix 终端（macOS/Linux/WSL）

## 安装
```bash
# 克隆代码
git clone <your_repo_url>
cd ccxt-pro-binance-monitor

# 安装依赖
npm i

# 编译 TypeScript
npm run build
```

## 配置 .env（已内置模板）
项目根目录新建或编辑 `.env`：
```env
# 是否启用现货/USDM/COINM
SPOT_ENABLED=true
USDM_ENABLED=true
COINM_ENABLED=true

# 最大订阅数量与刷新间隔（毫秒）
MAX_SYMBOLS=50
RENDER_INTERVAL_MS=2000
SHORT_VOLUME_INTERVAL_MS=10000
T24_INTERVAL_MS=30000

# 颜色与阈值
TYPE_COLOR=true
FUNDING_RATE_EPS=0.00005

# 报价过滤
ALLOWED_SPOT_QUOTES=USDT,USDC,FDUSD
EXCLUDE_SPOT_QUOTES=TRY
ALLOWED_USDM_QUOTES=USDT,USDC
ALLOWED_COINM_QUOTES=USD

# Binance 域名（可选覆盖）
BINANCE_SPOT_HOST=api-gcp.binance.com
BINANCE_FAPI_HOST=fapi.binance.com
BINANCE_DAPI_HOST=dapi.binance.com
BINANCE_SPOT_WS_HOST=stream.binance.com:9443

# 代理（可选）
HTTPS_PROXY=
HTTP_PROXY=

# API Key（可选）
BINANCE_KEY=
BINANCE_SECRET=
```
说明：本项目已抛弃旧开关（如 FUTURES_ONLY、PCT_EPS 等）。

## 用法
```bash
# 监控某个代币（关键词输入代币本名即可）
node dist/index.js PEPE

# 仅现货或仅期货（可由 .env 控制，亦可命令行覆盖）
node dist/index.js ETH --spot --futures
node dist/index.js BTC --spot=false --futures=true

# 限制最大订阅条数
node dist/index.js BARD --max 6
```
- 只需输入代币本名：例如输入 `PEPE`，将自动匹配 `1000PEPE` 等前缀型期货；`1INCH` 为完整代币名，不剥前缀。
- 输出列：`交易所 | 类型 | 合约 | 最新 | 涨跌(24h) | 成交额(5m) | 成交额(30m) | 成交额(24h) | 未平仓(张) | 资金费率 | 倒计时 | 本地时间`

## 支持的交易对范围（很重要）
- 现货：仅展示白名单中的主计价交易对（由 `.env` 的 `ALLOWED_SPOT_QUOTES` 控制，默认：USDT、USDC、FDUSD）。
  - 示例：输入 `BARD`，可获取 `BARD/USDT`、`BARD/USDC`、`BARD/FDUSD`；不会展示 `BARD/TRY`（被 `EXCLUDE_SPOT_QUOTES=TRY` 排除）。
- USDM 永续：仅展示永续合约（PERPETUAL），保证金资产在白名单内（`ALLOWED_USDM_QUOTES`，默认：USDT、USDC）。
  - 关键词支持期货前缀自动识别（如 `1000PEPE`），你只需输入 `PEPE` 即可（`1INCH` 例外）。
- COINM 永续：仅展示永续（PERPETUAL），且计价在白名单内（`ALLOWED_COINM_QUOTES`，默认：USD）。
  - 交割合约（如 `ETH/USD:ETH-251226`）已过滤，不展示。

## 命令说明
- npm run build：TypeScript 编译，输出到 `dist/`
- npm run dev -- <Token>：开发模式（用 tsx 直接运行 `src/index.ts`），示例：`npm run dev -- BTC`
- npm run start：示例启动（默认带 `BTC` 参数），等价 `node dist/index.js BTC`
- node dist/index.js <Token> [--spot] [--futures] [--max N]
  - <Token>：代币关键词（如 PEPE/ETH/BTC）；自动匹配期货前缀型 1000/1M/1000000（1INCH 例外）
  - --spot：是否包含现货（布尔），可覆盖 `.env` 中的 `SPOT_ENABLED`
  - --futures：是否包含期货（布尔），当为 false 时 USDM/COINM 均禁用
  - --max：最大订阅数，覆盖 `.env` 中的 `MAX_SYMBOLS`

## 常见问题（FAQ）
- 为什么不是“所有交易对”都能看到？
  - 我们只展示“有用且可比”的交易对，而非全量。规则见“支持的交易对范围”。
  - 现货仅展示主计价白名单（默认 USDT/USDC/FDUSD），如 `BARD/USDT`、`BARD/USDC`、`BARD/FDUSD`；
    `BARD/TRY` 等会被排除。
  - 期货只展示永续；带日期的交割合约不展示。
  - COINM/USDM 若交易所侧没有该标的永续，就无法显示。
  - 网络/地域限制时，`loadMarkets` 会回退镜像域，但个别端点仍可能暂时不可用。
- 看不到 COINM？可能该代币在 COINM 未上市或无永续；本工具仅展示永续。
- WS 连接失败？可设置代理 `HTTPS_PROXY`/`HTTP_PROXY`，或替换 Binance 域名为镜像域。
- 现货只想看主流计价？用 `ALLOWED_SPOT_QUOTES` 控制（如 USDT,USDC,FDUSD）。

## 开发脚本
```bash
# 开发热启动
npm run dev -- BTC

# 编译
npm run build
```

## 许可证
MIT
