import 'dotenv/config';
import { setDefaultResultOrder } from 'node:dns';
import * as yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as ccxt from 'ccxt';
import kleur from 'kleur';
import ora from 'ora';
import Table from 'cli-table3';
import WebSocket from 'ws';

type AnyExchange = ccxt.Exchange & {
  watchTicker?: (symbol: string, params?: any) => Promise<ccxt.Ticker>;
  watchTickers?: (symbols?: string[], params?: any) => Promise<Record<string, ccxt.Ticker>>;
};

const sleep = (ms:number)=> new Promise(r=>setTimeout(r, ms));

// 优先使用 IPv4，避免某些网络对 IPv6/双栈的兼容问题
try { setDefaultResultOrder('ipv4first'); } catch {}

const argv = yargs.default(hideBin(process.argv))
  .usage('用法: $0 <TokenName> [选项]')
  .positional('TokenName', { type: 'string', demandOption: true, describe: '代币名称（如 PEPE、BTC、ETH）' })
  .option('max', { type: 'number', default: 50, describe: '最多订阅多少个匹配到的合约' })
  .option('spot', { type: 'boolean', default: process.env.FUTURES_ONLY === 'true' ? false : true, describe: '包含现货' })
  .option('futures', { type: 'boolean', default: true, describe: '包含期货' })
  .help().argv as unknown as { _: (string|number)[], max:number, spot:boolean, futures:boolean };

const TOKEN = String(argv._[0] ?? '').trim();
if (!TOKEN) {
  console.error('请提供代币名称，如：PEPE');
  process.exit(1);
}

const FUTURES_TYPE = (process.env.FUTURES_TYPE ?? 'all').toLowerCase(); // all/usdm/coinm

// 环境开关（终端输出保持与开关一致）
const ENV_SPOT = process.env.SPOT_ENABLED;
const ENV_USDM = process.env.USDM_ENABLED;
const ENV_COINM = process.env.COINM_ENABLED;
let spotEnabled = typeof ENV_SPOT === 'string' ? ENV_SPOT !== 'false' : true;
let usdmEnabled = typeof ENV_USDM === 'string' ? ENV_USDM === 'true' : (FUTURES_TYPE === 'all' || FUTURES_TYPE === 'usdm');
let coinmEnabled = typeof ENV_COINM === 'string' ? ENV_COINM === 'true' : (FUTURES_TYPE === 'all' || FUTURES_TYPE === 'coinm');
// 允许命令行覆盖环境开关
spotEnabled = (typeof (argv.spot) === 'boolean') ? argv.spot : spotEnabled;
const argvFutures = (typeof (argv.futures) === 'boolean') ? argv.futures : (usdmEnabled || coinmEnabled);
if (!argvFutures) { usdmEnabled = false; coinmEnabled = false; }

// 过滤现货报价（如 TRY），逗号分隔，默认 TRY
const EXCLUDE_SPOT_QUOTES = new Set((process.env.EXCLUDE_SPOT_QUOTES || 'TRY').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean));
// 允许的现货主计价（只展示这些计价的现货），默认 USDT,USDC,FDUSD
const ALLOWED_SPOT_QUOTES = new Set((process.env.ALLOWED_SPOT_QUOTES || 'USDT,USDC,FDUSD').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean));
// 允许的期货报价（USDM 默认 USDT,USDC；COINM 默认 USD）
const ALLOWED_USDM_QUOTES = new Set((process.env.ALLOWED_USDM_QUOTES || 'USDT,USDC').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean));
const ALLOWED_COINM_QUOTES = new Set((process.env.ALLOWED_COINM_QUOTES || 'USD').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean));

// 颜色开关
const TYPE_COLOR = process.env.TYPE_COLOR === undefined ? true : process.env.TYPE_COLOR !== 'false';

// 订阅/刷新频率
const MAX_SUBS = Number(process.env.MAX_SYMBOLS || argv.max || 50);
const RENDER_MS = Number(process.env.RENDER_INTERVAL_MS || 2000);
const SHORT_MS = Number(process.env.SHORT_VOLUME_INTERVAL_MS || 10000);
const T24_MS = Number(process.env.T24_INTERVAL_MS || 30000);

// 构造我们要用到的 Binance 实例
function buildExchanges() {
  const key = process.env.BINANCE_KEY ?? '';
  const secret = process.env.BINANCE_SECRET ?? '';
  const common = { apiKey: key, secret, enableRateLimit: true, timeout: 15000 } as ccxt.Exchange["options"];
  const SPOT_HOST = process.env.BINANCE_SPOT_HOST || 'api-gcp.binance.com';
  const FAPI_HOST = process.env.BINANCE_FAPI_HOST || 'fapi.binance.com';
  const DAPI_HOST = process.env.BINANCE_DAPI_HOST || 'dapi.binance.com';
  const list: {id:string, inst: AnyExchange}[] = [];
  if (spotEnabled) {
    const spot = new (ccxt as any).binance(common) as AnyExchange & { has?: any, options?: any };
    // 避免命中 SAPI 的 currencies / margin 端点导致 loadMarkets 失败
    try { (spot as any).has = { ...((spot as any).has ?? {}), fetchCurrencies: false }; } catch {}
    try { (spot as any).options = { ...((spot as any).options ?? {}), defaultType: 'spot', adjustForTimeDifference: true }; } catch {}
    try {
      (spot as any).urls = {
        ...(((spot as any).urls) ?? {}),
        api: {
          ...(((spot as any).urls?.api) ?? {}),
          public: `https://${SPOT_HOST}/api`,
          private: `https://${SPOT_HOST}/api`,
          sapi: `https://${SPOT_HOST}/sapi`,
          wapi: `https://${SPOT_HOST}/wapi`,
        },
      };
    } catch {}
    list.push({ id: 'binance', inst: spot });
  }
  if (usdmEnabled || coinmEnabled) {
    if (usdmEnabled) {
      const usdm = new (ccxt as any).binanceusdm(common) as AnyExchange & { has?: any, options?: any };
      try { (usdm as any).has = { ...((usdm as any).has ?? {}), fetchCurrencies: false }; } catch {}
      try { (usdm as any).options = { ...((usdm as any).options ?? {}), defaultType: 'future', adjustForTimeDifference: true }; } catch {}
      try {
        (usdm as any).urls = {
          ...(((usdm as any).urls) ?? {}),
          api: {
            ...(((usdm as any).urls?.api) ?? {}),
            fapi: `https://${FAPI_HOST}/fapi`,
          },
        };
      } catch {}
      list.push({ id: 'binanceusdm', inst: usdm });
    }
    if (coinmEnabled) {
      const coinm = new (ccxt as any).binancecoinm(common) as AnyExchange & { has?: any, options?: any };
      try { (coinm as any).has = { ...((coinm as any).has ?? {}), fetchCurrencies: false }; } catch {}
      try { (coinm as any).options = { ...((coinm as any).options ?? {}), defaultType: 'delivery', adjustForTimeDifference: true }; } catch {}
      try {
        (coinm as any).urls = {
          ...(((coinm as any).urls) ?? {}),
          api: {
            ...(((coinm as any).urls?.api) ?? {}),
            dapi: `https://${DAPI_HOST}/dapi`,
          },
        };
      } catch {}
      list.push({ id: 'binancecoinm', inst: coinm });
    }
  }
  return list;
}

type Row = {
  market: string;
  symbol: string;
  last?: number;
  bid?: number;
  ask?: number;
  change24h?: number;
  baseVol24h?: number;
  quoteVol24h?: number;
  quoteVol5m?: number;
  quoteVol30m?: number;
  openInterest?: number;
  fundingRate?: number; // percent, e.g., 0.01 -> 0.01%
  fundingTs?: number;
  fundingNextTs?: number;
  ts: number;
};

(async () => {
  // 可选代理：若设置了 HTTPS_PROXY/HTTP_PROXY，则通过 undici 代理所有 fetch
  try {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxyUrl) {
      const undici = await import('undici' as any).catch(()=>null) as any;
      if (undici && undici.setGlobalDispatcher && undici.ProxyAgent) {
        undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl));
      }
    }
  } catch {}
  const spinner = ora(`加载交易所与市场元数据中...`).start();
  const exchanges = buildExchanges();

  // 带备用域名的加载市场（优先使用当前 urls/环境域名）
  async function loadMarketsWithFallback(id:string, inst: AnyExchange): Promise<boolean> {
    const tryList: (()=>Promise<void>)[] = [];
    // 1) 先用当前配置（已在 buildExchanges 中按环境域名设置）
    tryList.push(async ()=>{ await inst.loadMarkets(); });
    if (id === 'binance') {
      // spot 备用域名
      const hosts = ['api','api1','api2','api3'];
      for (const host of hosts) {
        const base = `https://${host}.binance.com`;
        tryList.push(async () => {
          try {
            (inst as any).urls = {
              ...((inst as any).urls ?? {}),
              api: {
                ...(((inst as any).urls?.api) ?? {}),
                public: `${base}/api`,
                private: `${base}/api`,
                sapi: `${base}/sapi`,
                wapi: `${base}/wapi`,
              }
            };
          } catch {}
          await inst.loadMarkets();
        });
      }
    } else if (id === 'binanceusdm') {
      const hosts = ['fapi','fapi1','fapi2','fapi3'];
      for (const host of hosts) {
        const base = `https://${host}.binance.com`;
        tryList.push(async () => {
          try {
            (inst as any).urls = {
              ...((inst as any).urls ?? {}),
              api: {
                ...(((inst as any).urls?.api) ?? {}),
                fapi: `${base}/fapi`,
              }
            };
          } catch {}
          await inst.loadMarkets();
        });
      }
    } else if (id === 'binancecoinm') {
      const hosts = ['dapi','dapi1','dapi2','dapi3'];
      for (const host of hosts) {
        const base = `https://${host}.binance.com`;
        tryList.push(async () => {
          try {
            (inst as any).urls = {
              ...((inst as any).urls ?? {}),
              api: {
                ...(((inst as any).urls?.api) ?? {}),
                dapi: `${base}/dapi`,
              }
            };
          } catch {}
          await inst.loadMarkets();
        });
      }
    }

    for (const job of tryList) {
      try { await job(); return true; } catch {}
    }
    return false;
  }

  const ready: {id:string, inst: AnyExchange}[] = [];
  for (const ex of exchanges) {
    const ok = await loadMarketsWithFallback(ex.id, ex.inst);
    if (ok) ready.push(ex);
  }
  spinner.succeed('市场加载完成');

  // 按代币名筛选
  const matcher = (s:string)=> s.toUpperCase().includes(TOKEN.toUpperCase());
  const candidates: {market:string, symbol:string, marketId?:string}[] = [];

  for (const {id, inst} of ready) {
    const markets = Object.values(inst.markets ?? {});
    for (const m of markets) {
      const symbol = m.symbol;
      // 只挑和代币名明显相关的：基础货币或报价货币包含
      const base = (m.base ?? '').toUpperCase();
      const quote = (m.quote ?? '').toUpperCase();
      // 过滤掉现货 TRY 计价
      if (id === 'binance' && (quote === 'TRY' || (ALLOWED_SPOT_QUOTES.size>0 && !ALLOWED_SPOT_QUOTES.has(quote)))) continue;
      // 强化关键词：允许期货前缀 1000/1000000/1M（如 1000PEPE），但 1INCH 是完整代币名不剥前缀
      const tokenUp = TOKEN.toUpperCase();
      const tokenIsOneInch = tokenUp === '1INCH';
      const stripPrefix = (s:string)=> tokenIsOneInch ? s : s.replace(/^(1000|1000000|1M)/, '');
      const baseStripped = stripPrefix(base);
      const symUpper = symbol.toUpperCase();
      const symBasePart = symUpper.split(/[/:]/)[0];
      const symBaseStripped = stripPrefix(symBasePart);
      // 只允许基币等于 TOKEN，或 symbol 以 TOKEN 开头，或去前缀后等于 TOKEN（匹配期货前缀型）
      const strongMatch = (base === tokenUp) || symUpper.startsWith(`${tokenUp}/`) || symUpper.startsWith(`${tokenUp}:`) || (baseStripped === tokenUp) || (symBaseStripped === tokenUp);
      if (strongMatch) {
        // 仅保留永续（PERPETUAL / swap=true）
        if (id === 'binanceusdm' || id === 'binancecoinm') {
          const contractType = String((m as any).info?.contractType || '').toUpperCase();
          const isPerp = ((m as any).swap === true) || contractType === 'PERPETUAL';
          if (!isPerp) continue;
        }
        if (id === 'binanceusdm') {
          const quoteAll = (m.quote || '').toUpperCase();
          const margin = (m.settle || m.info?.marginAsset || 'USDT').toUpperCase();
          const settle = quoteAll.includes(':') ? quoteAll.split(':')[1] : margin;
          if (ALLOWED_USDM_QUOTES.size>0 && !ALLOWED_USDM_QUOTES.has(settle)) continue;
        }
        if (id === 'binancecoinm') {
          const quote = (m.quote || '').toUpperCase();
          if (ALLOWED_COINM_QUOTES.size>0 && !ALLOWED_COINM_QUOTES.has(quote)) continue;
        }
        candidates.push({ market: id, symbol });
      }
    }
  }

  // 若现货未成功加载，但用户启用了现货，则用 REST exchangeInfo 兜底构建现货候选
  const enabledSpot = spotEnabled === true;
  const spotReady = ready.some(r=>r.id==='binance');
  if (enabledSpot && !spotReady) {
    try {
      const host = process.env.BINANCE_SPOT_HOST || 'api-gcp.binance.com';
      const url = `https://${host}/api/v3/exchangeInfo`;
      const info = await fetch(url).then(r=>r.ok?r.json():null).catch(()=>null) as any;
      const arr = Array.isArray(info?.symbols) ? info.symbols : [];
      for (const s of arr) {
        if (s?.status !== 'TRADING') continue;
        const base = String(s.baseAsset||'').toUpperCase();
        const quote = String(s.quoteAsset||'').toUpperCase();
        if (quote === 'TRY') continue; // 过滤 TRY 计价
        const ccxtSymbol = `${base}/${quote}`;
        const tokenUp = TOKEN.toUpperCase();
        const strongMatch = base === tokenUp || ccxtSymbol.toUpperCase().startsWith(`${tokenUp}/`);
        if (strongMatch && (ALLOWED_SPOT_QUOTES.size===0 || ALLOWED_SPOT_QUOTES.has(quote))) {
          candidates.push({ market: 'binance', symbol: ccxtSymbol });
        }
      }
    } catch {}
  }

  // 若 COINM 未成功加载，但用户启用了期货且类型包含 coinm，则用 dapi exchangeInfo 兜底
  const enabledFutures = (usdmEnabled || coinmEnabled) === true;
  const futuresIncludeCoinm = FUTURES_TYPE === 'all' || FUTURES_TYPE === 'coinm';
  const coinmReady = ready.some(r=>r.id==='binancecoinm');
  if (enabledFutures && futuresIncludeCoinm && !coinmReady) {
    try {
      const host = process.env.BINANCE_DAPI_HOST || 'dapi.binance.com';
      const url = `https://${host}/dapi/v1/exchangeInfo`;
      const info = await fetch(url).then(r=>r.ok?r.json():null).catch(()=>null) as any;
      const arr = Array.isArray(info?.symbols) ? info.symbols : [];
      for (const s of arr) {
        if (s?.status !== 'TRADING') continue;
        const base = String(s.baseAsset||'').toUpperCase();
        const quote = String(s.quoteAsset||'').toUpperCase();
        const margin = String(s.marginAsset||'').toUpperCase();
        const id = String(s.symbol||'').toUpperCase();
        const ccxtSymbol = `${base}/${quote}:${margin}`;
        const tokenUp = TOKEN.toUpperCase();
        const tokenIsOneInch = tokenUp === '1INCH';
        const stripPrefix = (s:string)=> tokenIsOneInch ? s : s.replace(/^(1000|1000000|1M)/, '');
        const baseStripped = stripPrefix(base);
        if (base === tokenUp || baseStripped === tokenUp) {
          candidates.push({ market: 'binancecoinm', symbol: ccxtSymbol, marketId: id });
        }
      }
    } catch {}
  }

  // 去重并按交易所轮询挑选，确保现货/USDM/COINM 都能出现
  const uniq = new Map<string, {market:string, symbol:string, marketId?:string}>();
  for (const c of candidates) uniq.set(`${c.market}|${c.symbol}`, c);
  const groups: Record<string, {market:string, symbol:string, marketId?:string}[]> = {};
  for (const v of uniq.values()) {
    if (!groups[v.market]) groups[v.market] = [];
    groups[v.market].push(v);
  }
  const marketOrder = [spotEnabled ? 'binance' : '', usdmEnabled ? 'binanceusdm' : '', coinmEnabled ? 'binancecoinm' : ''].filter(Boolean) as string[];
  const targets: {market:string, symbol:string, marketId?:string}[] = [];
  let added = true;
  while (targets.length < MAX_SUBS && added) {
    added = false;
    for (const m of marketOrder) {
      const arr = groups[m];
      if (arr && arr.length > 0 && targets.length < MAX_SUBS) {
        targets.push(arr.shift()!);
        added = true;
      }
    }
    // 还有未列入的其他交易所（未来扩展）
    if (targets.length < MAX_SUBS) {
      for (const m of Object.keys(groups)) {
        if (marketOrder.includes(m)) continue;
        const arr = groups[m];
        if (arr && arr.length > 0 && targets.length < MAX_SUBS) {
          targets.push(arr.shift()!);
          added = true;
        }
      }
    }
  }

  if (targets.length === 0) {
    console.log(kleur.yellow(`没有找到与 “${TOKEN}” 相关的合约。`));
    process.exit(0);
  }

  // 启动前只打印一行摘要，避免首次出现“列表网格”不协调
  console.log(kleur.gray(`将订阅 ${targets.length} 个合约（现货:${(targets.filter(t=>t.market==='binance').length)} / USDM:${(targets.filter(t=>t.market==='binanceusdm').length)} / COINM:${(targets.filter(t=>t.market==='binancecoinm').length)}）`));

  // 行情行缓存
  const rows = new Map<string, Row>();

  // 汇总表刷新器
  async function renderLoop() {
    // 每 2 秒刷新一次
    while (true) {
      const table = new Table({
        head: ['交易所','类型','合约','最新','涨跌(24h)','成交额(5m)','成交额(30m)','成交额(24h)','未平仓(张)','资金费率','倒计时','本地时间'],
        style: { head: ['cyan'] }, colAligns: ['left','left','left','right','right','right','right','right','right','right','right','right']
      });
      const fmtM = (v?: number) => {
        if (typeof v !== 'number' || !isFinite(v)) return '';
        const m = v / 1e6;
        const s = m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2);
        return `${s}M`;
      };
      const FR_EPS = Number(process.env.FUNDING_RATE_EPS || '0.00005');
      const fmtPct = (v?: number) => {
        if (typeof v !== 'number' || !isFinite(v)) return '';
        const txt = `${v.toFixed(2)}%`;
        if (v === 0) return txt; // 严格：=0 不着色
        return v > 0 ? kleur.red(txt) : kleur.green(txt);
      };
      const fmtFunding = (rate?: number, market?: string) => {
        if (typeof rate !== 'number' || !isFinite(rate)) return '';
        if (!(market === 'binanceusdm' || market === 'binancecoinm')) return '';
        const txt = `${(rate * 100).toFixed(4)}%`;
        if (Math.abs(rate) < FR_EPS) return txt;
        return rate > 0 ? kleur.red(txt) : kleur.green(txt);
      };
      const fmtCountdown = (nextTs?: number) => {
        if (typeof nextTs !== 'number' || !isFinite(nextTs) || nextTs <= 0) return '';
        const now = Date.now();
        let diff = Math.max(0, nextTs - now);
        const totalSec = Math.floor(diff / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = (n:number)=> n.toString().padStart(2, '0');
        return `${pad(h)}:${pad(m)}:${pad(s)}`;
      };
      const typeRank = (m:string)=> m==='binanceusdm' ? 0 : (m==='binancecoinm' ? 1 : (m==='binance' ? 2 : 3));
      const sorted = Array.from(rows.values())
        .filter(r=> (r.market==='binance' && spotEnabled) || (r.market==='binanceusdm' && usdmEnabled) || (r.market==='binancecoinm' && coinmEnabled))
        .sort((a,b)=>{
          const ra = typeRank(a.market); const rb = typeRank(b.market);
          if (ra !== rb) return ra - rb; // 先按类型分组：USDM -> COINM -> 现货
          const v = (b.quoteVol5m??0)-(a.quoteVol5m??0);
          if (v !== 0) return v; // 组内按5m成交额降序
          return a.symbol.localeCompare(b.symbol);
        });
      for (const r of sorted) {
        const exchangeLabel = r.market.startsWith('binance') ? 'Binance' : r.market;
        const typeLabelRaw = r.market === 'binance' ? '现货' : (r.market === 'binanceusdm' ? 'USDM' : (r.market === 'binancecoinm' ? 'COINM' : ''));
        const typeLabel = typeLabelRaw === '现货'
          ? kleur.blue(typeLabelRaw)
          : (typeLabelRaw === 'USDM' ? kleur.yellow(typeLabelRaw) : (typeLabelRaw === 'COINM' ? kleur.magenta(typeLabelRaw) : typeLabelRaw));
        table.push([
          exchangeLabel,
          typeLabel,
          r.symbol,
          r.last ?? '',
          fmtPct(r.change24h),
          fmtM(r.quoteVol5m),
          fmtM(r.quoteVol30m),
          fmtM(r.quoteVol24h),
          r.openInterest !== undefined ? fmtM(r.openInterest) : '',
          fmtFunding(r.fundingRate, r.market),
          fmtCountdown(r.fundingNextTs),
          new Date(r.ts).toLocaleString('zh-CN', { hour12: false })
        ]);
      }
      console.clear();
      const enabledTags = [spotEnabled? '现货': null, usdmEnabled? 'USDM': null, coinmEnabled? 'COINM': null].filter(Boolean).join('/');
      console.log(kleur.bold(`CCXT WebSocket 监控（关键词：${TOKEN} | 启用：${enabledTags||'无'}）  — ${new Date().toLocaleString('zh-CN')}`));
      console.log(table.toString());
      await sleep(2000);
    }
  }

  renderLoop(); // 不 await，后台刷新

  // REST 定时补充 24h 数据与 OI
  async function restBackfill(exId:string, ex: AnyExchange, symbol:string, intervalMs:number = T24_MS) {
    while (true) {
      try {
        const t = await ex.fetchTicker(symbol);
        const key = `${exId}|${symbol}`;
        const row = rows.get(key) ?? { market: exId, symbol, ts: Date.now() };
        row.baseVol24h = t.baseVolume as any;
        row.quoteVol24h = t.quoteVolume as any;
        row.change24h = typeof t.percentage === 'number' ? t.percentage : undefined;
        row.ts = Date.now();
        rows.set(key, row);
      } catch (e:any) {
        // 静默
      }

      // 若 24h 字段缺失，直接调用交易所原生 24hr 接口补齐
      try {
        const marketsMap = (ex as any).markets || {};
        const marketDef = marketsMap[symbol];
        const marketId0 = String(marketDef?.id || '').toUpperCase();
        const [baseSym, quoteAll] = symbol.split('/');
        const quoteSym = (quoteAll || '').split(':')[0];
        const derivedId = `${(baseSym||'').toUpperCase()}${(quoteSym||'').toUpperCase()}`;
        const marketId = marketId0 || derivedId;
        let url = '';
        if (exId === 'binance') {
          const host = process.env.BINANCE_SPOT_HOST || 'api-gcp.binance.com';
          url = `https://${host}/api/v3/ticker/24hr?symbol=${marketId}`;
        } else if (exId === 'binanceusdm') {
          const host = process.env.BINANCE_FAPI_HOST || 'fapi.binance.com';
          url = `https://${host}/fapi/v1/ticker/24hr?symbol=${marketId}`;
        } else if (exId === 'binancecoinm') {
          const host = process.env.BINANCE_DAPI_HOST || 'dapi.binance.com';
          url = `https://${host}/dapi/v1/ticker/24hr?symbol=${marketId}`;
        }
        if (url) {
          const j = await fetch(url).then(r=>r.ok?r.json():null).catch(()=>null) as any;
          if (j) {
            const key = `${exId}|${symbol}`;
            const row = rows.get(key) ?? { market: exId, symbol, ts: Date.now() } as Row;
            const qv = parseFloat(j.quoteVolume ?? j.quoteAssetVolume);
            const pct = parseFloat(j.priceChangePercent);
            if (!isNaN(qv)) row.quoteVol24h = qv;
            if (!isNaN(pct)) row.change24h = pct;
            row.ts = Date.now();
            rows.set(key, row);
          }
        }
      } catch {}

      // open interest：优先使用 Binance 期货原生 REST，其次 ccxt fetchOpenInterest
      try {
        const marketsMap = (ex as any).markets || {};
        const marketDef = marketsMap[symbol];
        const marketId = String(marketDef?.id || '').toUpperCase();
        // 资金费率：仅永续（USDM）支持；COINM 某些合约也有 funding，但 API 不同。
        if (exId === 'binanceusdm' && marketId) {
          const host = process.env.BINANCE_FAPI_HOST || 'fapi.binance.com';
          const url = `https://${host}/fapi/v1/premiumIndex?symbol=${marketId}`;
          const j = await fetch(url).then(r=>r.ok?r.json():null).catch(()=>null) as any;
          const fr = j ? parseFloat(j.lastFundingRate ?? j.fundingRate) : NaN;
          if (!isNaN(fr)) {
            const key = `${exId}|${symbol}`;
            const row = rows.get(key) ?? { market: exId, symbol, ts: Date.now() };
            row.fundingRate = fr; // 原值即为百分数的小数表示
            const fundingTime = j?.time ?? j?.E ?? Date.now();
            if (typeof fundingTime === 'number' && isFinite(fundingTime)) row.fundingTs = fundingTime;
            const nextTs = j?.nextFundingTime ?? j?.N;
            if (typeof nextTs === 'number' && isFinite(nextTs)) row.fundingNextTs = nextTs;
            row.ts = Date.now();
            rows.set(key, row);
          }
        } else if (exId === 'binancecoinm' && marketId) {
          const host = process.env.BINANCE_DAPI_HOST || 'dapi.binance.com';
          const url = `https://${host}/dapi/v1/premiumIndex?symbol=${marketId}`;
          const j = await fetch(url).then(r=>r.ok?r.json():null).catch(()=>null) as any;
          const fr = j ? parseFloat(j.lastFundingRate ?? j.fundingRate) : NaN;
          if (!isNaN(fr)) {
            const key = `${exId}|${symbol}`;
            const row = rows.get(key) ?? { market: exId, symbol, ts: Date.now() };
            row.fundingRate = fr;
            const fundingTime = j?.time ?? j?.E ?? Date.now();
            if (typeof fundingTime === 'number' && isFinite(fundingTime)) row.fundingTs = fundingTime;
            const nextTs = j?.nextFundingTime ?? j?.N;
            if (typeof nextTs === 'number' && isFinite(nextTs)) row.fundingNextTs = nextTs;
            row.ts = Date.now();
            rows.set(key, row);
          }
        }
        if (exId === 'binanceusdm' && marketId) {
          const host = process.env.BINANCE_FAPI_HOST || 'fapi.binance.com';
          const url = `https://${host}/fapi/v1/openInterest?symbol=${marketId}`;
          const res = await fetch(url).then(r=>r.ok?r.json():null).catch(()=>null) as any;
          const v = res ? parseFloat(res.openInterest) : NaN;
          if (!isNaN(v)) {
            const key = `${exId}|${symbol}`;
            const row = rows.get(key) ?? { market: exId, symbol, ts: Date.now() };
            row.openInterest = v;
            row.ts = Date.now();
            rows.set(key, row);
          }
        } else if (exId === 'binancecoinm' && marketId) {
          const host = process.env.BINANCE_DAPI_HOST || 'dapi.binance.com';
          const url = `https://${host}/dapi/v1/openInterest?symbol=${marketId}`;
          const res = await fetch(url).then(r=>r.ok?r.json():null).catch(()=>null) as any;
          const v = res ? parseFloat(res.openInterest) : NaN;
          if (!isNaN(v)) {
            const key = `${exId}|${symbol}`;
            const row = rows.get(key) ?? { market: exId, symbol, ts: Date.now() };
            row.openInterest = v;
            row.ts = Date.now();
            rows.set(key, row);
          }
        } else {
          // 非 Binance 期货或无 id，尝试 ccxt 的 fetchOpenInterest
          // @ts-ignore
          if (typeof (ex as any).fetchOpenInterest === 'function') {
            // @ts-ignore
            const oi = await (ex as any).fetchOpenInterest(symbol).catch(()=>null);
            if (oi && typeof oi.openInterest === 'number') {
              const key = `${exId}|${symbol}`;
              const row = rows.get(key) ?? { market: exId, symbol, ts: Date.now() };
              row.openInterest = oi.openInterest;
              row.ts = Date.now();
              rows.set(key, row);
            }
          }
        }
      } catch {}

      await sleep(intervalMs);
    }
  }

  // 定时补充短周期成交额（5m/30m，计价）
  async function backfillShortTermVolumes(exId:string, ex: AnyExchange, symbol:string, intervalMs:number = SHORT_MS) {
    while (true) {
      try {
        const marketsMap = (ex as any).markets || {};
        const marketDef = marketsMap[symbol];
        const marketId0 = String(marketDef?.id || '').toUpperCase();
        const [baseSym, quoteAll] = symbol.split('/');
        const quoteSym = (quoteAll || '').split(':')[0];
        const derivedId = `${(baseSym||'').toUpperCase()}${(quoteSym||'').toUpperCase()}`;
        const marketId = marketId0 || derivedId;
        let url = '';
        if (exId === 'binanceusdm') {
          const host = process.env.BINANCE_FAPI_HOST || 'fapi.binance.com';
          url = `https://${host}/fapi/v1/klines?symbol=${marketId}&interval=1m&limit=30`;
        } else if (exId === 'binancecoinm') {
          const host = process.env.BINANCE_DAPI_HOST || 'dapi.binance.com';
          url = `https://${host}/dapi/v1/klines?symbol=${marketId}&interval=1m&limit=30`;
        } else if (exId === 'binance') {
          const host = process.env.BINANCE_SPOT_HOST || 'api-gcp.binance.com';
          url = `https://${host}/api/v3/klines?symbol=${marketId}&interval=1m&limit=30`;
        }
        if (url) {
          const arr = await fetch(url).then(r=>r.ok?r.json():null).catch(()=>null) as any[] | null;
          if (Array.isArray(arr)) {
            let vol5 = 0; let vol30 = 0;
            const len = arr.length;
            for (let i = 0; i < len; i++) {
              const k = arr[i];
              // kline: [ openTime, open, high, low, close, volume(base), closeTime, quoteAssetVolume, trades, ... ]
              const q = parseFloat(k?.[7]);
              if (!isNaN(q)) {
                vol30 += q;
                if (i >= len - 5) vol5 += q;
              }
            }
            const key = `${exId}|${symbol}`;
            const row = rows.get(key) ?? { market: exId, symbol, ts: Date.now() } as Row;
            row.quoteVol5m = vol5;
            row.quoteVol30m = vol30;
            row.ts = Date.now();
            rows.set(key, row);
          }
        }
      } catch {}
      await sleep(intervalMs);
    }
  }

  // 为每个目标开 WebSocket 订阅
  for (const {market, symbol, marketId} of targets) {
    const ex = exchanges.find(e=>e.id===market)!.inst;

    // 启动 REST 补充（基础 30s）
    restBackfill(market, ex, symbol, 30000);
    // 启动短周期成交额补充（10s）
    backfillShortTermVolumes(market, ex, symbol, 10000);

    (async () => {
      // WebSocket 订阅 watchdog
      const supportsTicker = typeof (ex as any).watchTicker === 'function' && market === 'binance';
      const supportsTrades = typeof (ex as any).watchTrades === 'function';
      const supportsOrderBook = typeof (ex as any).watchOrderBook === 'function';

      async function loopTicker() {
        while (true) {
          try {
            const t = await (ex as any).watchTicker(symbol);
            const key = `${market}|${symbol}`;
            const row = rows.get(key) ?? { market, symbol, ts: Date.now() };
            row.last = t.last ?? row.last;
            row.bid = t.bid ?? row.bid;
            row.ask = t.ask ?? row.ask;
            row.ts = Date.now();
            rows.set(key, row);
            console.log(kleur.gray(`[WS][Ticker][${market}] ${symbol} last=${row.last} bid=${row.bid} ask=${row.ask}`));
          } catch (e:any) {
            const msg = String(e?.message || e);
            console.error(kleur.red(`[WS错误][Ticker][${market}] ${symbol}: ${msg}, 3s 后重连`));
            await sleep(3000);
          }
        }
      }

      async function loopTrades() {
        while (true) {
          try {
            const trades = await (ex as any).watchTrades(symbol);
            const trade = Array.isArray(trades) ? trades[trades.length - 1] : trades;
            const key = `${market}|${symbol}`;
            const row = rows.get(key) ?? { market, symbol, ts: Date.now() };
            if (trade && typeof trade.price === 'number') row.last = trade.price;
            row.ts = Date.now();
            rows.set(key, row);
          } catch (e:any) {
            const msg = String(e?.message || e);
            console.error(kleur.red(`[WS错误][Trades][${market}] ${symbol}: ${msg}, 3s 后重连`));
            await sleep(3000);
          }
        }
      }

      async function loopOrderBook() {
        while (true) {
          try {
            const ob = await (ex as any).watchOrderBook(symbol, 5);
            const key = `${market}|${symbol}`;
            const row = rows.get(key) ?? { market, symbol, ts: Date.now() };
            row.bid = ob.bids?.[0]?.[0] ?? row.bid;
            row.ask = ob.asks?.[0]?.[0] ?? row.ask;
            row.ts = Date.now();
            rows.set(key, row);
          } catch (e:any) {
            const msg = String(e?.message || e);
            console.error(kleur.red(`[WS错误][OB][${market}] ${symbol}: ${msg}, 3s 后重连`));
            await sleep(3000);
          }
        }
      }

      // 现货：改为原生 Binance WS（trade + bookTicker），与期货一致
      if (market === 'binance') {
        const mdef = ((ex as any).markets || {})[symbol];
        const marketId = String(mdef?.id || '').toLowerCase();
        const baseSym = symbol.split('/')[0].toLowerCase();
        const streamName = marketId || `${baseSym}${(mdef?.quote || 'USDT').toString().toLowerCase()}`;
        const spotWsHost = (process.env.BINANCE_SPOT_WS_HOST || 'stream.binance.com:9443').replace(/^wss:\/\//,'');

        function openWs(url:string, onMessage:(data:any)=>void) {
          let ws: WebSocket | null = null;
          const connect = () => {
            ws = new WebSocket(url);
            ws.on('message', (buf:any) => { try { onMessage(JSON.parse(buf.toString())); } catch {} });
            ws.on('close', () => setTimeout(connect, 1000));
            ws.on('error', () => { try { ws?.close(); } catch {}; });
          };
          connect();
        }

        openWs(`wss://${spotWsHost}/ws/${streamName}@trade`, (data:any) => {
          const price = parseFloat(data.p);
          if (!isNaN(price)) {
            const key = `${market}|${symbol}`;
            const row = rows.get(key) ?? { market, symbol, ts: Date.now() } as Row;
            row.last = price;
            row.ts = Date.now();
            rows.set(key, row);
          }
        });

        openWs(`wss://${spotWsHost}/ws/${streamName}@bookTicker`, (data:any) => {
          const bid = parseFloat(data.b);
          const ask = parseFloat(data.a);
          const key = `${market}|${symbol}`;
          const row = rows.get(key) ?? { market, symbol, ts: Date.now() } as Row;
          if (!isNaN(bid)) row.bid = bid;
          if (!isNaN(ask)) row.ask = ask;
          row.ts = Date.now();
          rows.set(key, row);
        });
      }

      // Binance 期货：直连原生 WS（trade + bookTicker）确保实时
      if (market === 'binanceusdm' || market === 'binancecoinm') {
        const mdef = ((ex as any).markets || {})[symbol];
        const idLower = String((marketId ?? mdef?.id ?? '').toString() || '').toLowerCase();
        const streamName = idLower || symbol.toLowerCase().replace(/\W/g,'');
        const wsHost = market === 'binanceusdm' ? 'fstream.binance.com' : 'dstream.binance.com';

        function openWs(url:string, onMessage:(data:any)=>void) {
          let ws: WebSocket | null = null;
          const connect = () => {
            ws = new WebSocket(url);
            ws.on('message', (buf:any) => {
              try { onMessage(JSON.parse(buf.toString())); } catch {}
            });
            ws.on('close', () => setTimeout(connect, 1000));
            ws.on('error', () => { try { ws?.close(); } catch {}; });
          };
          connect();
        }

        openWs(`wss://${wsHost}/ws/${streamName}@trade`, (data:any) => {
          try {
            const price = parseFloat(data.p);
            if (!isNaN(price)) {
              const key = `${market}|${symbol}`;
              const row = rows.get(key) ?? { market, symbol, ts: Date.now() } as Row;
              row.last = price;
              row.ts = Date.now();
              rows.set(key, row);
            }
          } catch {}
        });

        openWs(`wss://${wsHost}/ws/${streamName}@bookTicker`, (data:any) => {
          try {
            const bid = parseFloat(data.b);
            const ask = parseFloat(data.a);
            const key = `${market}|${symbol}`;
            const row = rows.get(key) ?? { market, symbol, ts: Date.now() } as Row;
            if (!isNaN(bid)) row.bid = bid;
            if (!isNaN(ask)) row.ask = ask;
            row.ts = Date.now();
            rows.set(key, row);
          } catch {}
        });
      }

      // 如果三者都不支持，则快速 REST 兜底
      if (!supportsTicker && !supportsTrades && !supportsOrderBook) {
        console.error(kleur.yellow(`[WS降级][${market}] ${symbol}: 该市场无 WS 数据源，使用 3s REST 轮询`));
        restBackfill(market, ex, symbol, 3000);
      }
    })();
  }
})().catch(e=>{
  console.error(e);
  process.exit(1);
});
