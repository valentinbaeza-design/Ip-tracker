import { ethers } from "ethers";
import fs from "fs";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const WALLET = process.env.WALLET_ADDRESS;

const config = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url)));
const POSITIONS = config.positions;
const RESERVES = config.reserves || [];

const HISTORY_FILE = new URL("./history.json", import.meta.url);
const MAX_HISTORY_PER_POSITION = 200; // ~33 días a razón de 6 lecturas/día

const PM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)"
];
const FACTORY_ABI = ["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"];
const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"];
const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"];

const MAX_UINT128 = (2n ** 128n) - 1n;

export function tickToPrice(tick, dec0, dec1) {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}
export function tickToSqrtPrice(tick) {
  return Math.sqrt(Math.pow(1.0001, tick));
}
export function getAmountsForLiquidity(liquidity, sqrtP, sqrtA, sqrtB) {
  let amount0 = 0, amount1 = 0;
  if (sqrtP <= sqrtA) {
    amount0 = liquidity * (1 / sqrtA - 1 / sqrtB);
  } else if (sqrtP >= sqrtB) {
    amount1 = liquidity * (sqrtB - sqrtA);
  } else {
    amount0 = liquidity * (1 / sqrtP - 1 / sqrtB);
    amount1 = liquidity * (sqrtP - sqrtA);
  }
  return { amount0, amount1 };
}

// ---------- Fase 2: vs Hold / IL real (no aproximación 50/50) ----------
export function reconstructEntryAmounts(entryPrice, rangeMin, rangeMax, initialUSD, price0EntryUsd) {
  if (!(entryPrice > 0) || !(rangeMin > 0) || !(rangeMax > rangeMin) || !(initialUSD > 0) || !(price0EntryUsd > 0)) {
    return null;
  }
  const price1EntryUsd = price0EntryUsd / entryPrice;
  const sqrtP0 = Math.sqrt(entryPrice);
  const sqrtA = Math.sqrt(rangeMin);
  const sqrtB = Math.sqrt(rangeMax);
  const { amount0: u0, amount1: u1 } = getAmountsForLiquidity(1, sqrtP0, sqrtA, sqrtB);
  const unscaledValueUsd = u0 * price0EntryUsd + u1 * price1EntryUsd;
  if (!(unscaledValueUsd > 0)) return null;
  const scale = initialUSD / unscaledValueUsd;
  return { amount0Entry: u0 * scale, amount1Entry: u1 * scale, price1EntryUsd };
}
export function computeRealHoldValueUsd(amount0Entry, amount1Entry, price0NowUsd, price1NowUsd) {
  return amount0Entry * price0NowUsd + amount1Entry * price1NowUsd;
}
export function approxHoldValueUsd50_50(priceNow, entryApprox, initialUSD) {
  const ratio = priceNow / entryApprox;
  return initialUSD * (0.5 + 0.5 * ratio);
}
// ---------- Fin Fase 2 ----------

// Mapa símbolo -> id de CoinGecko. ÚNICA fuente para precio actual e histórico, y también
// para las reservas fuera de LP (mismo criterio de precios en todo el script).
const CG_ID_BY_SYMBOL = {
  WETH: "ethereum", ETH: "ethereum",
  USDC: "usd-coin",
  ARB: "arbitrum",
  WBTC: "wrapped-bitcoin", BTC: "bitcoin"
};
const STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USD₮0"]);

export async function fetchHistoricalUsdPrice(symbol, dateIso) {
  if (STABLECOIN_SYMBOLS.has(symbol)) return 1;
  const id = CG_ID_BY_SYMBOL[symbol];
  if (!id) return null;
  const d = new Date(dateIso);
  if (isNaN(d.getTime())) return null;
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/history?date=${dd}-${mm}-${yyyy}`);
    if (!res.ok) return null;
    const data = await res.json();
    const usd = data?.market_data?.current_price?.usd;
    return typeof usd === "number" ? usd : null;
  } catch (e) {
    console.error(`fetchHistoricalUsdPrice falló para ${symbol} (${dateIso}):`, e.message);
    return null;
  }
}

async function getUsdPrices(symbols) {
  const ids = [...new Set(symbols.map(s => CG_ID_BY_SYMBOL[s]).filter(Boolean))];
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`);
    const data = await res.json();
    const out = {};
    for (const s of symbols) out[s] = CG_ID_BY_SYMBOL[s] && data[CG_ID_BY_SYMBOL[s]] ? data[CG_ID_BY_SYMBOL[s]].usd : null;
    return out;
  } catch (e) {
    console.error("Error obteniendo precios USD:", e.message);
    return {};
  }
}

// ---------- Simulación Montecarlo ----------
const MC_DAYS = 30;
const MC_SIMULATIONS = 5000;
const MC_BLOCK_SIZE = 5;
const MC_HISTORY_DAYS = 500;
const MC_EWMA_HALFLIFE_DAYS = 60;

async function fetchBinanceDailyCloses(symbol, limit) {
  const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`);
  if (!res.ok) throw new Error(`Binance klines ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  return data.map(k => parseFloat(k[4]));
}
function binanceSymbolToCoinGeckoId(symbol) {
  const base = symbol.replace(/USDT$|USDC$|BUSD$/, "");
  return CG_ID_BY_SYMBOL[base] || null;
}
async function fetchCoinGeckoDailyCloses(symbol, days) {
  const id = binanceSymbolToCoinGeckoId(symbol);
  if (!id) throw new Error(`Sin id de CoinGecko para ${symbol}`);
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
  if (!res.ok) throw new Error(`CoinGecko market_chart ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.prices || []).map(p => p[1]);
}
async function fetchDailyClosesWithFallback(symbol, limit) {
  try {
    return await fetchBinanceDailyCloses(symbol, limit);
  } catch (e) {
    console.error(`Binance falló para ${symbol} (${e.message}), probando CoinGecko como respaldo…`);
    return await fetchCoinGeckoDailyCloses(symbol, limit);
  }
}
async function fetchRatioHistory(cfg, limit = MC_HISTORY_DAYS) {
  if (!cfg.priceSymbols || cfg.priceSymbols.length === 0) return null;
  if (cfg.priceMode === "ratio" && cfg.priceSymbols.length === 2) {
    const [symA, symB] = cfg.priceSymbols;
    const [closesA, closesB] = await Promise.all([
      fetchDailyClosesWithFallback(symA, limit),
      fetchDailyClosesWithFallback(symB, limit)
    ]);
    const n = Math.min(closesA.length, closesB.length);
    const ratios = [];
    for (let i = 0; i < n; i++) ratios.push(closesA[i] / closesB[i]);
    return ratios;
  }
  return await fetchDailyClosesWithFallback(cfg.priceSymbols[0], limit);
}
function dailyReturnsFromCloses(closes) {
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return returns;
}
function pickWeightedBlockStart(nReturns, blockSize, halflifeDays) {
  const maxInicio = nReturns - blockSize;
  if (maxInicio <= 0) return 0;
  const lambda = Math.log(2) / halflifeDays;
  const pesos = [];
  let total = 0;
  for (let i = 0; i <= maxInicio; i++) {
    const antiguedad = maxInicio - i;
    const peso = Math.exp(-lambda * antiguedad);
    total += peso;
    pesos.push(total);
  }
  const r = Math.random() * total;
  let lo = 0, hi = pesos.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pesos[mid] < r) lo = mid + 1; else hi = mid;
  }
  return lo;
}
export function estimatePositionValueV2(simPrice, entryPrice, rangeMin, rangeMax, initialUSD, feesPerDay, days) {
  const sqrtEntry = Math.sqrt(entryPrice), sqrtA = Math.sqrt(rangeMin), sqrtB = Math.sqrt(rangeMax);
  const { amount0: u0, amount1: u1 } = getAmountsForLiquidity(1, sqrtEntry, sqrtA, sqrtB);
  const denomEntry = u0 * entryPrice + u1;
  if (!(denomEntry > 0)) return null;
  const Lusd = initialUSD / denomEntry;
  const sqrtSim = Math.sqrt(simPrice);
  const { amount0: xSim, amount1: ySim } = getAmountsForLiquidity(Lusd, sqrtSim, sqrtA, sqrtB);
  const positionValueEstimate = xSim * simPrice + ySim;
  const feesEstimate = feesPerDay * days;
  const totalValueEstimate = positionValueEstimate + feesEstimate;
  return {
    valueUSD: totalValueEstimate,
    returnPct: ((totalValueEstimate - initialUSD) / initialUSD) * 100,
    gainUSD: totalValueEstimate - initialUSD
  };
}
function bootstrapMontecarlo(returns, dias, nSims, priceStart, rangeMin, rangeMax, blockSize, halflifeDays) {
  const resultados = [];
  let tocaArriba = 0, tocaAbajo = 0;
  for (let sim = 0; sim < nSims; sim++) {
    let precio = priceStart, arriba = false, abajo = false, diasSimulados = 0;
    while (diasSimulados < dias) {
      const inicio = pickWeightedBlockStart(returns.length, blockSize, halflifeDays);
      for (let j = 0; j < blockSize && diasSimulados < dias; j++, diasSimulados++) {
        precio = precio * (1 + returns[inicio + j]);
        if (precio >= rangeMax) arriba = true;
        if (precio <= rangeMin) abajo = true;
      }
    }
    resultados.push({ pct: (precio - priceStart) / priceStart * 100, precioFinal: precio });
    if (arriba) tocaArriba++;
    if (abajo) tocaAbajo++;
  }
  resultados.sort((a, b) => a.pct - b.pct);
  const percentil = (p) => resultados[Math.min(resultados.length - 1, Math.floor(resultados.length * p))];
  const p10 = percentil(0.10), p50 = percentil(0.50), p90 = percentil(0.90);
  return {
    pTocaArriba: tocaArriba / nSims,
    pTocaAbajo: tocaAbajo / nSims,
    p10: p10.pct, p50: p50.pct, p90: p90.pct,
    precioP10: p10.precioFinal, precioP50: p50.precioFinal, precioP90: p90.precioFinal
  };
}
async function computeMonteCarloScenarios(cfg, r) {
  try {
    const closes = await fetchRatioHistory(cfg);
    if (!closes || closes.length < MC_BLOCK_SIZE * 4) return null;
    const returns = dailyReturnsFromCloses(closes);
    const media = returns.reduce((a, b) => a + b, 0) / returns.length;
    const returnsNeutros = returns.map(x => x - media);

    const neutro = bootstrapMontecarlo(returnsNeutros, MC_DAYS, MC_SIMULATIONS, r.priceNow, r.priceMin, r.priceMax, MC_BLOCK_SIZE, MC_EWMA_HALFLIFE_DAYS);
    const tendencia = bootstrapMontecarlo(returns, MC_DAYS, MC_SIMULATIONS, r.priceNow, r.priceMin, r.priceMax, MC_BLOCK_SIZE, MC_EWMA_HALFLIFE_DAYS);

    const entryApprox = r.entryPrice || Math.sqrt(r.priceMin * r.priceMax);
    const daysTracked = r.openedAt ? (Date.now() - new Date(r.openedAt).getTime()) / (1000 * 60 * 60 * 24) : null;
    const feesPerDay = (daysTracked && daysTracked > 0) ? r.feesValueUSD / daysTracked : 0;
    const traducir = (mc) => ({
      ...mc,
      valorP10: estimatePositionValueV2(mc.precioP10, entryApprox, r.priceMin, r.priceMax, r.initialUSD, feesPerDay, MC_DAYS),
      valorP50: estimatePositionValueV2(mc.precioP50, entryApprox, r.priceMin, r.priceMax, r.initialUSD, feesPerDay, MC_DAYS),
      valorP90: estimatePositionValueV2(mc.precioP90, entryApprox, r.priceMin, r.priceMax, r.initialUSD, feesPerDay, MC_DAYS)
    });

    return { neutro: traducir(neutro), tendencia: traducir(tendencia), diasHistorico: returns.length, feesPerDay };
  } catch (e) {
    console.error(`Montecarlo omitido (${cfg.label}): ${e.message}`);
    return null;
  }
}

// ---------- Historial persistente ----------
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch (e) {
    return { positions: {} };
  }
}
function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}
function appendToHistory(history, tokenId, entry) {
  if (!history.positions[tokenId]) history.positions[tokenId] = [];
  history.positions[tokenId].push(entry);
  if (history.positions[tokenId].length > MAX_HISTORY_PER_POSITION) {
    history.positions[tokenId] = history.positions[tokenId].slice(-MAX_HISTORY_PER_POSITION);
  }
}

async function checkPosition(cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpc, undefined, { batchMaxCount: 1 });
  const pm = new ethers.Contract(cfg.positionManager, PM_ABI, provider);
  const factory = new ethers.Contract(cfg.factory, FACTORY_ABI, provider);

  const pos = await pm.positions(cfg.tokenId);
  const poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const slot0 = await pool.slot0();

  const token0 = new ethers.Contract(pos.token0, ERC20_ABI, provider);
  const token1 = new ethers.Contract(pos.token1, ERC20_ABI, provider);
  const [sym0, dec0, sym1, dec1] = await Promise.all([
    token0.symbol(), token0.decimals(), token1.symbol(), token1.decimals()
  ]);
  const d0 = Number(dec0), d1 = Number(dec1);

  const currentTick = Number(slot0.tick);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);
  const inRange = currentTick >= tickLower && currentTick < tickUpper;

  const priceNow = tickToPrice(currentTick, d0, d1);
  const priceMin = tickToPrice(tickLower, d0, d1);
  const priceMax = tickToPrice(tickUpper, d0, d1);
  const rangeWidth = priceMax - priceMin;
  const distToLower = ((priceNow - priceMin) / rangeWidth * 100).toFixed(1);
  const distToUpper = ((priceMax - priceNow) / rangeWidth * 100).toFixed(1);

  const sqrtP = Number(slot0.sqrtPriceX96) / 2 ** 96;
  const sqrtA = tickToSqrtPrice(tickLower);
  const sqrtB = tickToSqrtPrice(tickUpper);
  const liquidity = Number(pos.liquidity);
  const { amount0, amount1 } = getAmountsForLiquidity(liquidity, sqrtP, sqrtA, sqrtB);
  const amount0Human = amount0 / 10 ** d0;
  const amount1Human = amount1 / 10 ** d1;

  let fee0Human = 0, fee1Human = 0;
  try {
    const [fee0, fee1] = await pm.collect.staticCall(
      { tokenId: cfg.tokenId, recipient: WALLET, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
      { from: WALLET }
    );
    fee0Human = Number(fee0) / 10 ** d0;
    fee1Human = Number(fee1) / 10 ** d1;
  } catch (e) {
    console.error(`No se pudieron leer fees de ${cfg.label}:`, e.message);
  }

  const otherTokenAddress = sym0 === "WETH" ? pos.token1 : pos.token0;
  const feeTierBps = Number(pos.fee);
  const chainSlug = cfg.chainSlug || (/base/i.test(cfg.label) ? "base" : /arbitrum/i.test(cfg.label) ? "arbitrum" : "");

  return {
    label: cfg.label, tokenId: String(cfg.tokenId), inRange, sym0, sym1, priceNow, priceMin, priceMax,
    distToLower, distToUpper, amount0Human, amount1Human, fee0Human, fee1Human,
    initialUSD: cfg.initialUSD, openedAt: cfg.openedAt || null, entryPrice: cfg.entryPrice || null,
    otherTokenAddress, feeTierBps, chainSlug
  };
}

// ---------- Reservas fuera de LP (saldo de wallet vs un momento de referencia) ----------
async function checkReserve(cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpc, undefined, { batchMaxCount: 1 });
  const token = new ethers.Contract(cfg.tokenAddress, ERC20_ABI, provider);
  const [sym, dec, balanceRaw] = await Promise.all([
    token.symbol(), token.decimals(), token.balanceOf(WALLET)
  ]);
  const balanceHuman = Number(balanceRaw) / 10 ** Number(dec);
  return { label: cfg.label, sym, balanceHuman, initialAmount: cfg.initialAmount, initialUSD: cfg.initialUSD, setAsideAt: cfg.setAsideAt, note: cfg.note || null };
}

function buildReserveMessage(r, priceUsd, now) {
  if (priceUsd == null) {
    return `🪙 *${r.label}* — ${now}\nSaldo: ${r.balanceHuman.toFixed(3)} ${r.sym}\n⚠️ Sin precio USD disponible ahora mismo, no se puede comparar con la referencia.`;
  }
  const valueUSD = r.balanceHuman * priceUsd;
  const deltaUSD = valueUSD - r.initialUSD;
  const deltaPct = r.initialUSD > 0 ? (deltaUSD / r.initialUSD) * 100 : null;
  const fmt = (v) => (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
  const setAsideStr = r.setAsideAt ? new Date(r.setAsideAt).toLocaleDateString("es-ES") : "fecha no registrada";

  let msg = `🪙 *${r.label}* — ${now}\n`;
  msg += `Saldo actual: ${r.balanceHuman.toFixed(3)} ${r.sym} (valor: $${valueUSD.toFixed(2)})\n`;
  msg += `Referencia al apartarla (${setAsideStr}): ${r.initialAmount.toFixed(3)} ${r.sym} ≈ $${r.initialUSD.toFixed(2)}\n`;
  msg += `Diferencia vs esa referencia: ${fmt(deltaUSD)}${deltaPct !== null ? ` (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)` : ""}`;
  if (r.note) msg += `\n\n_(${r.note})_`;
  return msg;
}

// ---------- Rango sugerido a partir del movimiento real de precio observado ----------
export function computeSuggestedRange(positionHistory, bufferPct = 10) {
  const withPrice = positionHistory.filter(h => typeof h.priceNow === "number");
  if (withPrice.length < 15) return null;
  const prices = withPrice.map(h => h.priceNow);
  const observedMin = Math.min(...prices);
  const observedMax = Math.max(...prices);
  const pad = (observedMax - observedMin) * (bufferPct / 100);
  return {
    min: observedMin - pad,
    max: observedMax + pad,
    daysSpan: (new Date(withPrice[withPrice.length - 1].t) - new Date(withPrice[0].t)) / (1000 * 60 * 60 * 24)
  };
}

export function buildActionSteps(r, targetMin, targetMax) {
  const openUrl = r.chainSlug
    ? `https://app.uniswap.org/positions/create/v3?currencyA=NATIVE&currencyB=${r.otherTokenAddress}&chain=${r.chainSlug}&fee=${r.feeTierBps}`
    : null;
  return {
    targetMin, targetMax,
    closeUrl: "https://app.uniswap.org/positions",
    openUrl
  };
}

const WIDE_MARGIN_THRESHOLD = 30;
const MIN_DAYS_FOR_RANGE_SUGGESTION = 3;
const RECOMMENDED_DAYS_BEFORE_ACTING = 21;
const MIN_USD_TO_JUSTIFY_GAS = 15;

export function buildSuggestion(r, positionHistory) {
  const msgs = [];
  let action = null;

  if (!r.inRange) {
    const suggestedOut = computeSuggestedRange(positionHistory);
    if (suggestedOut) action = buildActionSteps(r, suggestedOut.min, suggestedOut.max);
    return {
      text: "Fuera de rango: no genera fees ahora mismo. Valora reequilibrar el rango o esperar a que el precio vuelva.",
      action
    };
  }

  const marginLower = parseFloat(r.distToLower);
  const marginUpper = parseFloat(r.distToUpper);

  if (marginLower < 10 || marginUpper < 10) {
    msgs.push("Cerca del límite del rango (<10% de margen). Vigila, podría salir pronto.");
  }

  const openedAtStr = r.openedAt || (positionHistory.length ? positionHistory[0].t : null);
  const daysTracked = openedAtStr ? (Date.now() - new Date(openedAtStr).getTime()) / (1000 * 60 * 60 * 24) : null;

  if (r.totalReturnPct !== null && r.totalReturnPct < 0) {
    if (daysTracked !== null && daysTracked < MIN_DAYS_FOR_RANGE_SUGGESTION) {
      msgs.push(`Rendimiento negativo, pero es pronto (${daysTracked.toFixed(1)} días de seguimiento) — las fees suelen tardar en compensar el movimiento inicial, no hay prisa por actuar.`);
    } else {
      msgs.push("Rendimiento negativo desde el depósito (las fees aún no compensan el movimiento de precio).");
    }
  }

  const isWide = marginLower > WIDE_MARGIN_THRESHOLD && marginUpper > WIDE_MARGIN_THRESHOLD;
  if (isWide && daysTracked !== null && daysTracked >= MIN_DAYS_FOR_RANGE_SUGGESTION) {
    const suggested = computeSuggestedRange(positionHistory);
    if (suggested) {
      const tone = (r.totalReturnPct !== null && r.totalReturnPct >= 0)
        ? "Vas positivo, pero el rango tiene margen de sobra a ambos lados — podrías estrecharlo para capturar más fees por cada dólar aportado, a cambio de más mantenimiento y riesgo de salir de rango antes."
        : "El rango actual parece más ancho de lo que el precio ha necesitado, diluyendo las fees.";
      let msg = `${tone} Basado en el movimiento real de los últimos ${suggested.daysSpan.toFixed(1)} días, un rango más ajustado sería aprox. ${suggested.min.toFixed(4)} – ${suggested.max.toFixed(4)} (actual: ${r.priceMin.toFixed(4)} – ${r.priceMax.toFixed(4)}). Verifica esta cifra tú mismo antes de actuar — es una estimación simple, no sustituye tu criterio.`;

      const reasons = [];
      if (daysTracked < RECOMMENDED_DAYS_BEFORE_ACTING) {
        reasons.push(`solo hay ${daysTracked.toFixed(1)} días de historial (recomendado esperar a ~${RECOMMENDED_DAYS_BEFORE_ACTING} para fiarte más del rango calculado)`);
      }
      if (r.positionValueUSD !== null && r.positionValueUSD < MIN_USD_TO_JUSTIFY_GAS) {
        reasons.push(`la posición son $${r.positionValueUSD.toFixed(2)} — con ese tamaño, el gas de retirar + abrir de nuevo puede comerse buena parte o toda la mejora esperada`);
      }
      if (reasons.length > 0) {
        msg += ` 🕐 Mi valoración: de momento esperaría, porque ${reasons.join(" y ")}.`;
      } else {
        msg += ` 🕐 Mi valoración: con este historial y este tamaño de posición, ya es razonable planteárselo en serio si el gas actual no es excesivo.`;
      }

      msgs.push(msg);
      action = buildActionSteps(r, suggested.min, suggested.max);
    }
  }

  if (positionHistory.length >= 3) {
    const recentLower = positionHistory.slice(-3).map(h => h.distToLower);
    const recentUpper = positionHistory.slice(-3).map(h => h.distToUpper);
    const narrowingLower = recentLower[0] > recentLower[1] && recentLower[1] > recentLower[2] && (recentLower[0] - recentLower[2]) > 5;
    const narrowingUpper = recentUpper[0] > recentUpper[1] && recentUpper[1] > recentUpper[2] && (recentUpper[0] - recentUpper[2]) > 5;
    if (narrowingLower && marginLower >= 10) {
      msgs.push("El precio se acerca al límite inferior de forma sostenida en las últimas lecturas — vigila, podría tocar reequilibrar pronto.");
    }
    if (narrowingUpper && marginUpper >= 10) {
      msgs.push("El precio se acerca al límite superior de forma sostenida en las últimas lecturas — vigila, podría tocar reequilibrar pronto.");
    }
  }

  if (msgs.length === 0) msgs.push("Sin acción necesaria, todo dentro de parámetros normales.");
  return { text: msgs.join(" "), action };
}

export function buildColloquialMcSummary(mc, initialUSD) {
  const p10 = mc.neutro.valorP10.returnPct;
  const p50 = mc.neutro.valorP50.returnPct;
  const p90 = mc.neutro.valorP90.returnPct;
  const dollarAt = (pct) => initialUSD * (1 + pct / 100);
  const fmtPct = (p) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
  const fmtDollar = (p) => `$${dollarAt(p).toFixed(2)}`;

  const FLOOR_MATCH_THRESHOLD_PCT = 0.5;
  const tendP10 = mc.tendencia.valorP10.returnPct;
  const tendP90 = mc.tendencia.valorP90.returnPct;
  let floorNote = "";
  if (Math.abs(p10 - tendP10) < FLOOR_MATCH_THRESHOLD_PCT) {
    floorNote = " Ese peor caso es el mismo tanto si el precio se mueve errático como si sigue la racha actual — no es casualidad: en ese punto la posición ya salió del rango y se queda fija en un solo token, así que hay un límite real a partir de ahí, no una caída sin fondo.";
  } else if (Math.abs(p90 - tendP90) < FLOOR_MATCH_THRESHOLD_PCT) {
    floorNote = " Ese mejor caso es el mismo en los dos escenarios por el mismo motivo: la posición ya salió del rango por arriba y se queda fija, así que a partir de ahí no sigue ganando más por este mecanismo.";
  }

  const direction = (pct) => pct >= 0 ? "ganar" : "perder";
  return `🗣️ *En plata:* con lo que tienes puesto (${initialUSD.toFixed(2)}$), en el peor de los casos razonables no deberías bajar de ${fmtDollar(p10)} (${direction(p10)} ${Math.abs(p10).toFixed(1)}% aprox.).${floorNote} Lo más probable es acabar cerca de ${fmtDollar(p50)} (${fmtPct(p50)}), y en un escenario favorable, ${fmtDollar(p90)} (${fmtPct(p90)}).`;
}

function buildPositionMessage(r, now, positionHistory, mc) {
  if (r.error) return `⚠️ *${r.label}*\n${now}\nError leyendo datos: ${r.error}`;

  const icon = r.inRange ? "🟢" : "🔴";
  const status = r.inRange ? "dentro de rango" : "FUERA DE RANGO";
  const valueLine = r.positionValueUSD !== null
    ? `Valor actual: $${r.positionValueUSD.toFixed(2)} · Fees ganadas: $${r.feesValueUSD.toFixed(2)}\nRendimiento total: ${r.totalReturnPct.toFixed(1)}%`
    : `Fees ganadas: ${r.fee0Human.toFixed(6)} ${r.sym0} + ${r.fee1Human.toFixed(6)} ${r.sym1} (sin precio USD disponible)`;

  const entryLine = r.entryPrice
    ? `${r.entryPrice.toFixed(4)} (real)`
    : `${Math.sqrt(r.priceMin * r.priceMax).toFixed(4)} (aprox., centro del rango — sin entrada real registrada)`;
  const openedDateStr = r.openedAt ? new Date(r.openedAt).toLocaleDateString("es-ES") : "fecha no registrada";

  let msg = `${icon} *${r.label}* — ${now}\n${status} — ${r.sym1}/${r.sym0}: ${r.priceNow.toFixed(4)}\nRango: ${r.priceMin.toFixed(4)} – ${r.priceMax.toFixed(4)} · Entrada: ${entryLine}\nDepósito inicial: $${r.initialUSD.toFixed(2)} (${openedDateStr})\nMargen: ${r.distToLower}% / ${r.distToUpper}%\n${valueLine}`;

  const sign = (v) => v >= 0 ? "+" : "";
  const fmt = (v) => (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
  if (r.positionValueUSD !== null && r.vsHoldUSD !== null) {
    const gainUSD = r.positionValueUSD + r.feesValueUSD - r.initialUSD;
    const priceOnlyUSD = gainUSD - r.vsHoldUSD;
    const daysTracked = r.openedAt ? (Date.now() - new Date(r.openedAt).getTime()) / (1000 * 60 * 60 * 24) : null;
    const vsHoldPct = r.initialUSD > 0 ? (r.vsHoldUSD / r.initialUSD) * 100 : null;
    const priceOnlyPct = r.initialUSD > 0 ? (priceOnlyUSD / r.initialUSD) * 100 : null;
    const pctStr = (p) => p !== null ? ` (${p >= 0 ? "+" : ""}${p.toFixed(1)}%)` : "";

    msg += `\n\nvs Hold: ${fmt(r.vsHoldUSD)}${pctStr(vsHoldPct)}`;
    msg += `\n📊 *Desglose*${daysTracked !== null ? ` (${daysTracked.toFixed(1)} días)` : ""} _(esto ya ha pasado de verdad, no es una estimación)_: de ${fmt(gainUSD)} totales (Valor actual $${r.positionValueUSD.toFixed(2)} + Fees $${r.feesValueUSD.toFixed(2)} − Depósito $${r.initialUSD.toFixed(2)}) → ${fmt(r.vsHoldUSD)}${pctStr(vsHoldPct)} por ser LP (fees − IL) · ${fmt(priceOnlyUSD)}${pctStr(priceOnlyPct)} solo por movimiento de precio.`;

    const REF_AMOUNT = 1000;
    if (r.initialUSD > 0) {
      const factor = REF_AMOUNT / r.initialUSD;
      const gainScaled = gainUSD * factor;
      const vsHoldScaled = r.vsHoldUSD * factor;
      const priceOnlyScaled = priceOnlyUSD * factor;
      msg += `\n💡 Con ${REF_AMOUNT}€ en vez de $${r.initialUSD.toFixed(2)}: ganancia aprox. ${fmt(gainScaled)} (${fmt(vsHoldScaled)} LP · ${fmt(priceOnlyScaled)} precio). Estimación lineal simple del mismo periodo ya vivido (no una proyección a futuro) — el gas pesa menos proporcionalmente con más capital, así que lo real tendería a ser algo mejor que esto.`;
    }
  }

  if (mc) {
    const REF_AMOUNT = 1000;
    const factor = REF_AMOUNT / r.initialUSD;
    const fmtValScaled = (v) => {
      const gainScaled = v.gainUSD * factor;
      const valueScaled = REF_AMOUNT + gainScaled;
      return (v.returnPct >= 0 ? "+" : "") + "$" + valueScaled.toFixed(2) + ` (${v.returnPct >= 0 ? "+" : ""}${v.returnPct.toFixed(1)}%)`;
    };
    msg += `\n\n🎲 *Simulación (${mc.diasHistorico} días de histórico real, ${MC_DAYS} días vista)* _(esto es una estimación con base estadística real, no una predicción — por eso van dos escenarios y tres cifras, para no fingir una certeza que no existe)_:`;
    msg += `\nEscenario neutro (sin asumir ninguna dirección): tocar máx ${(mc.neutro.pTocaArriba * 100).toFixed(1)}% · tocar mín ${(mc.neutro.pTocaAbajo * 100).toFixed(1)}%`;
    msg += `\n  Con ${REF_AMOUNT}€ en vez de $${r.initialUSD.toFixed(2)} — pesimista ${fmtValScaled(mc.neutro.valorP10)} · mediana ${fmtValScaled(mc.neutro.valorP50)} · optimista ${fmtValScaled(mc.neutro.valorP90)}`;
    msg += `\nSi la tendencia reciente continuara (apuesta direccional, no neutral): tocar máx ${(mc.tendencia.pTocaArriba * 100).toFixed(1)}% · tocar mín ${(mc.tendencia.pTocaAbajo * 100).toFixed(1)}%`;
    msg += `\n  Con ${REF_AMOUNT}€ en vez de $${r.initialUSD.toFixed(2)} — pesimista ${fmtValScaled(mc.tendencia.valorP10)} · mediana ${fmtValScaled(mc.tendencia.valorP50)} · optimista ${fmtValScaled(mc.tendencia.valorP90)}`;
    msg += `\n_(El % es el mismo con $${r.initialUSD.toFixed(2)} o con ${REF_AMOUNT}€ — solo cambia la cifra en dinero. Calculado con el movimiento de precio simulado + impermanent loss + fees a tu ritmo actual de $${mc.feesPerDay.toFixed(5)}/día. No es una garantía.)_`;
    msg += `\n\n${buildColloquialMcSummary(mc, r.initialUSD)}`;
  }

  msg += `\n👉 ${r.suggestion.text}`;

  if (r.vsHoldApprox) {
    msg += `\n\n_vs hold es aproximado (no se pudo reconstruir el reparto real de entrada — falta precio histórico o precio de entrada)._`;
  }
  return msg;
}

async function sendTelegram(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "Markdown" })
    });
    if (!res.ok) {
      console.error("Error enviando a Telegram:", await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("Error de red enviando a Telegram:", e.message);
    return false;
  }
}

async function main() {
  const history = loadHistory();

  const raw = [];
  for (const cfg of POSITIONS) {
    try {
      raw.push(await checkPosition(cfg));
    } catch (e) {
      console.error(`Error en ${cfg.label}:`, e.message);
      raw.push({ label: cfg.label, error: e.message });
    }
  }

  const rawReserves = [];
  for (const cfg of RESERVES) {
    try {
      rawReserves.push(await checkReserve(cfg));
    } catch (e) {
      console.error(`Error en reserva ${cfg.label}:`, e.message);
      rawReserves.push({ label: cfg.label, error: e.message });
    }
  }

  const symbols = [...new Set([
    ...raw.filter(r => !r.error).flatMap(r => [r.sym0, r.sym1]),
    ...rawReserves.filter(r => !r.error).map(r => r.sym)
  ])];
  const prices = await getUsdPrices(symbols);

  const results = [];
  for (const r of raw) {
    if (r.error) { results.push(r); continue; }
    const p0 = prices[r.sym0], p1 = prices[r.sym1];
    let positionValueUSD = null, feesValueUSD = null, totalReturnPct = null, ilPct = null, vsHoldUSD = null, vsHoldApprox = false;
    if (p0 != null && p1 != null) {
      positionValueUSD = r.amount0Human * p0 + r.amount1Human * p1;
      feesValueUSD = r.fee0Human * p0 + r.fee1Human * p1;
      totalReturnPct = ((positionValueUSD + feesValueUSD - r.initialUSD) / r.initialUSD) * 100;

      let holdValueUSD = null;
      if (r.entryPrice && r.openedAt) {
        const price0EntryUsd = await fetchHistoricalUsdPrice(r.sym0, r.openedAt);
        if (price0EntryUsd != null) {
          const entryAmounts = reconstructEntryAmounts(r.entryPrice, r.priceMin, r.priceMax, r.initialUSD, price0EntryUsd);
          if (entryAmounts) {
            holdValueUSD = computeRealHoldValueUsd(entryAmounts.amount0Entry, entryAmounts.amount1Entry, p0, p1);
          }
        }
      }
      if (holdValueUSD === null) {
        console.error(`vs Hold aproximado para ${r.label}: no se pudo reconstruir el reparto real de entrada (50/50 asumido).`);
        vsHoldApprox = true;
        const entryApprox = r.entryPrice || Math.sqrt(r.priceMin * r.priceMax);
        holdValueUSD = approxHoldValueUsd50_50(r.priceNow, entryApprox, r.initialUSD);
      }
      ilPct = ((positionValueUSD - holdValueUSD) / holdValueUSD) * 100;
      vsHoldUSD = (positionValueUSD + feesValueUSD) - holdValueUSD;
    }
    const withCalc = { ...r, positionValueUSD, feesValueUSD, totalReturnPct, ilPct, vsHoldUSD, vsHoldApprox };
    const positionHistory = history.positions[r.tokenId] || [];
    const suggestion = buildSuggestion(withCalc, positionHistory);
    results.push({ ...withCalc, suggestion });
  }

  const nowIso = new Date().toISOString();
  results.forEach(r => {
    if (r.error) return;
    appendToHistory(history, r.tokenId, {
      t: nowIso,
      inRange: r.inRange,
      distToLower: parseFloat(r.distToLower),
      distToUpper: parseFloat(r.distToUpper),
      totalReturnPct: r.totalReturnPct,
      priceNow: r.priceNow,
      positionValueUSD: r.positionValueUSD,
      feesValueUSD: r.feesValueUSD,
      ilPct: r.ilPct,
      vsHoldUSD: r.vsHoldUSD,
      entryPriceUsed: !!r.entryPrice,
      vsHoldApprox: !!r.vsHoldApprox
    });
  });
  saveHistory(history);

  results.forEach(r => console.log(r));
  rawReserves.forEach(r => console.log(r));

  const now = new Date().toLocaleString("es-ES", { timeZone: "Europe/Madrid" });
  const cfgByTokenId = {};
  POSITIONS.forEach(cfg => { cfgByTokenId[String(cfg.tokenId)] = cfg; });

  let anyTelegramFailed = false;
  for (const r of results) {
    let mc = null;
    if (!r.error) {
      const cfg = cfgByTokenId[r.tokenId];
      if (cfg) mc = await computeMonteCarloScenarios(cfg, r);
    }
    const ok = await sendTelegram(buildPositionMessage(r, now, history.positions[r.tokenId] || [], mc));
    if (!ok) anyTelegramFailed = true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  for (const r of rawReserves) {
    if (r.error) {
      await sendTelegram(`⚠️ *${r.label}*\n${now}\nError leyendo saldo: ${r.error}`);
      anyTelegramFailed = true;
      continue;
    }
    const ok = await sendTelegram(buildReserveMessage(r, prices[r.sym], now));
    if (!ok) anyTelegramFailed = true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (anyTelegramFailed) {
    console.error("Al menos un mensaje de Telegram no se pudo enviar. Marcando la ejecución como fallida.");
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
