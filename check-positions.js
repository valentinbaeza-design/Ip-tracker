import { ethers } from "ethers";
import fs from "fs";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const WALLET = process.env.WALLET_ADDRESS;

const config = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url)));
const POSITIONS = config.positions;

const HISTORY_FILE = new URL("./history.json", import.meta.url);
const MAX_HISTORY_PER_POSITION = 200; // ~33 días a razón de 6 lecturas/día

const PM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)"
];
const FACTORY_ABI = ["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"];
const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"];
const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

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
// Reconstruye cuántos tokens de cada uno se depositaron REALMENTE al abrir la posición,
// usando la misma matemática de liquidez concentrada que ya se usa para el valor actual
// (getAmountsForLiquidity), evaluada en el precio de ENTRADA en vez del precio de ahora.
// Antes, el código asumía 50/50 en valor al entrar — casi nunca es cierto en V3: la
// proporción real depende de dónde caía el precio de entrada dentro del rango.
//
// Requiere price0EntryUsd (precio absoluto en USD de token0 el día de apertura) como ancla;
// price1EntryUsd se deriva de ahí y de entryPrice (no hace falta pedirlo aparte).
// Devuelve null si los datos de entrada no son válidos (rango cero, precio <= 0, etc.).
export function reconstructEntryAmounts(entryPrice, rangeMin, rangeMax, initialUSD, price0EntryUsd) {
  if (!(entryPrice > 0) || !(rangeMin > 0) || !(rangeMax > rangeMin) || !(initialUSD > 0) || !(price0EntryUsd > 0)) {
    return null;
  }
  const price1EntryUsd = price0EntryUsd / entryPrice;
  const sqrtP0 = Math.sqrt(entryPrice);
  const sqrtA = Math.sqrt(rangeMin);
  const sqrtB = Math.sqrt(rangeMax);
  // L=1 para obtener solo la PROPORCIÓN entre token0/token1 a ese precio; se escala después.
  const { amount0: u0, amount1: u1 } = getAmountsForLiquidity(1, sqrtP0, sqrtA, sqrtB);
  const unscaledValueUsd = u0 * price0EntryUsd + u1 * price1EntryUsd;
  if (!(unscaledValueUsd > 0)) return null;
  const scale = initialUSD / unscaledValueUsd;
  return { amount0Entry: u0 * scale, amount1Entry: u1 * scale, price1EntryUsd };
}

// Valor en USD de "haber holdeado" los tokens depositados en vez de aportarlos como liquidez,
// valorados a precios ACTUALES (ya se tienen de getUsdPrices, no hace falta precio histórico aquí).
export function computeRealHoldValueUsd(amount0Entry, amount1Entry, price0NowUsd, price1NowUsd) {
  return amount0Entry * price0NowUsd + amount1Entry * price1NowUsd;
}

// Fallback explícito (misma fórmula que existía antes de Fase 2): asume 50/50 en valor al
// entrar. Se usa SOLO cuando no se pudo reconstruir el reparto real (p.ej. sin precio
// histórico disponible), y el resultado se marca como aproximado en vez de mostrarse como
// si fuera un dato cierto — mismo principio que el modelo de estado de Fase 1.
export function approxHoldValueUsd50_50(priceNow, entryApprox, initialUSD) {
  const ratio = priceNow / entryApprox;
  return initialUSD * (0.5 + 0.5 * ratio);
}
// ---------- Fin Fase 2 ----------

// Mapa símbolo -> id de CoinGecko. ÚNICA fuente: tanto getUsdPrices() (precio actual) como
// fetchHistoricalUsdPrice() (precio en una fecha pasada) leen de aquí. Antes había dos mapas
// idénticos mantenidos a mano por separado (uno dentro de getUsdPrices, otro aquí) — el
// comentario decía "compartido" pero no lo era, así que añadir un token nuevo en un sitio
// sin acordarse del otro rompía silenciosamente vs Hold o el valor en USD según cuál te
// olvidaras. Unificado para que solo haga falta tocar un sitio.
const CG_ID_BY_SYMBOL = {
  WETH: "ethereum", ETH: "ethereum",
  USDC: "usd-coin",
  ARB: "arbitrum",
  WBTC: "wrapped-bitcoin", BTC: "bitcoin"
};
const STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USD₮0"]); // precio ~1 USD, no hace falta histórico

// Precio absoluto en USD de un símbolo en una fecha concreta, vía el endpoint /history de
// CoinGecko (formato de fecha requerido: dd-mm-yyyy). Si el símbolo es una stablecoin
// conocida, devuelve 1 directamente sin llamar a la red. Devuelve null si no se puede
// obtener (símbolo no mapeado, fecha sin datos, fallo de red) — el llamador debe tratar
// null como "no disponible", nunca inventar un valor.
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

// ---------- Simulación Montecarlo: probabilidad de tocar el rango en N días ----------
// Diseño (ver conversación): la media histórica es difícil de estimar de forma fiable con
// pocos datos, así que el escenario PRINCIPAL asume que no hay ninguna ventaja direccional
// conocida (se centra la media a 0), y solo se usa el histórico real para la forma/tamaño
// de los movimientos (volatilidad). Aparte, como añadido opcional y claramente distinto, se
// muestra qué pasaría si la tendencia reciente observada continuara — una apuesta
// direccional explícita, no una probabilidad neutral.
const MC_DAYS = 30;
const MC_SIMULATIONS = 5000;
const MC_BLOCK_SIZE = 5; // remuestrea bloques de 5 días seguidos, no días sueltos (conserva algo de la agrupación real de volatilidad)
const MC_HISTORY_DAYS = 500; // ~1.5 años de histórico diario real para estimar la volatilidad
const MC_EWMA_HALFLIFE_DAYS = 60; // los días recientes pesan más que los antiguos al elegir qué bloque remuestrear

async function fetchBinanceDailyCloses(symbol, limit) {
  // api.binance.com bloquea peticiones desde centros de datos de EE.UU. (HTTP 451) —
  // GitHub Actions corre ahí. data-api.binance.vision es el mismo servicio de datos
  // públicos de mercado, sin esa restricción geográfica.
  const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`);
  if (!res.ok) throw new Error(`Binance klines ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  return data.map(k => parseFloat(k[4])); // índice 4 = precio de cierre
}

// Respaldo si Binance (cualquiera de los dos dominios) fallara: CoinGecko, con el mismo
// símbolo traducido a su id de moneda.
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

// Construye la serie histórica diaria del RATIO tal como se usa en la posición (mismas
// unidades que priceNow), a partir de priceMode/priceSymbols ya presentes en config.json.
async function fetchRatioHistory(cfg, limit = MC_HISTORY_DAYS) {
  if (!cfg.priceSymbols || cfg.priceSymbols.length === 0) return null;
  if (cfg.priceMode === "ratio" && cfg.priceSymbols.length === 2) {
    const [symA, symB] = cfg.priceSymbols; // ej. ["ETHUSDT", "ARBUSDT"] -> ratio = A/B (ARB por WETH)
    const [closesA, closesB] = await Promise.all([
      fetchDailyClosesWithFallback(symA, limit),
      fetchDailyClosesWithFallback(symB, limit)
    ]);
    const n = Math.min(closesA.length, closesB.length);
    const ratios = [];
    for (let i = 0; i < n; i++) ratios.push(closesA[i] / closesB[i]);
    return ratios;
  }
  // Modo "direct": un solo símbolo sirve directamente como el ratio (ej. ETHUSDT ~ USDC/WETH,
  // porque USDC vale ~1 USD).
  return await fetchDailyClosesWithFallback(cfg.priceSymbols[0], limit);
}

function dailyReturnsFromCloses(closes) {
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return returns;
}

// Elige un índice de inicio de bloque con más probabilidad cuanto más reciente sea
// (ponderación EWMA), en vez de que todos los tramos del histórico pesen lo mismo.
function pickWeightedBlockStart(nReturns, blockSize, halflifeDays) {
  const maxInicio = nReturns - blockSize;
  if (maxInicio <= 0) return 0;
  const lambda = Math.log(2) / halflifeDays;
  // Peso acumulado: los índices más recientes (más altos) pesan más.
  const pesos = [];
  let total = 0;
  for (let i = 0; i <= maxInicio; i++) {
    const antiguedad = maxInicio - i; // 0 = el más reciente
    const peso = Math.exp(-lambda * antiguedad);
    total += peso;
    pesos.push(total);
  }
  const r = Math.random() * total;
  // Búsqueda simple (el array ya está ordenado ascendente)
  let lo = 0, hi = pesos.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pesos[mid] < r) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Traduce un precio simulado a valor estimado de la posición y rendimiento, usando la
// MISMA matemática de liquidez acotada que el resto del script (getAmountsForLiquidity),
// en vez de la fórmula cerrada de IL de rango completo (V2/50-50) que se usaba antes.
// Ventaja añadida sobre la fórmula anterior: si el precio simulado sale del rango
// [rangeMin, rangeMax], el resultado refleja correctamente que la posición pasa a ser
// 100% de un solo token (la fórmula cerrada anterior no modelaba eso, seguía aplicando
// la misma curva más allá de los límites).
//
// CORRECCIÓN (detectada por Valen el 24/8: "por qué el pesimista sale mejor que el
// optimista"): el valor se calcula en términos de TOKEN1 (multiplicando el token0 por
// el precio), no de token0 (dividiendo el token1 entre el precio) como en el primer
// intento. price = cantidad de token1 por token0 (ej. USDC por WETH), así que 1 unidad
// de token0 vale exactamente "price" unidades de token1 — para pasar todo a la misma
// unidad hay que multiplicar el lado de token0 por el precio, no dividir el lado de
// token1. La primera versión lo hacía al revés, lo cual equivalía silenciosamente a
// asumir que el precio absoluto del token1 (no del token0) es el que sube al mover el
// ratio — backwards para un par como WETH/USDC, donde es evidente que el que se mueve
// es el ETH, no el USDC.
//
// Simplificación que SÍ se mantiene (fuera del alcance de este fix): se asume que el
// precio absoluto en USD de token1 se mantiene constante durante la simulación, y solo
// se mueve el RATIO simulado (equivalente a asumir que solo se mueve el token0, que es
// lo económicamente razonable cuando token1 es una stablecoin — para pares sin
// stablecoin, como WETH/ARB, es una simplificación más discutible, documentada aquí).
export function estimatePositionValueV2(simPrice, entryPrice, rangeMin, rangeMax, initialUSD, feesPerDay, days) {
  const sqrtEntry = Math.sqrt(entryPrice), sqrtA = Math.sqrt(rangeMin), sqrtB = Math.sqrt(rangeMax);
  const { amount0: u0, amount1: u1 } = getAmountsForLiquidity(1, sqrtEntry, sqrtA, sqrtB);
  const denomEntry = u0 * entryPrice + u1; // valor de entrada en unidades "token1-equivalente"
  if (!(denomEntry > 0)) return null;
  const Lusd = initialUSD / denomEntry; // liquidez escalada para que el valor de entrada cuadre con initialUSD
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

// Calcula ambos escenarios (neutro por defecto + tendencia observada como añadido opcional)
// para una posición, usando histórico real de Binance. Si algo falla (símbolo no
// reconocido, error de red), devuelve null y el mensaje simplemente omite este bloque.
async function computeMonteCarloScenarios(cfg, r) {
  try {
    const closes = await fetchRatioHistory(cfg);
    if (!closes || closes.length < MC_BLOCK_SIZE * 4) return null; // muy poco histórico para que tenga sentido
    const returns = dailyReturnsFromCloses(closes);
    const media = returns.reduce((a, b) => a + b, 0) / returns.length;
    const returnsNeutros = returns.map(x => x - media); // fuerza dirección neutra, conserva la forma/volatilidad real

    const neutro = bootstrapMontecarlo(returnsNeutros, MC_DAYS, MC_SIMULATIONS, r.priceNow, r.priceMin, r.priceMax, MC_BLOCK_SIZE, MC_EWMA_HALFLIFE_DAYS);
    const tendencia = bootstrapMontecarlo(returns, MC_DAYS, MC_SIMULATIONS, r.priceNow, r.priceMin, r.priceMax, MC_BLOCK_SIZE, MC_EWMA_HALFLIFE_DAYS);

    // Traducir cada percentil de precio a valor estimado en $ y rendimiento %, con las
    // mismas fórmulas que ya usa el resto del script (no una cifra nueva sin relación).
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

  // Dirección del token "otro" (el que no es WETH), para construir el enlace de apertura
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

// ---------- Rango sugerido a partir del movimiento real de precio observado ----------
export function computeSuggestedRange(positionHistory, bufferPct = 10) {
  const withPrice = positionHistory.filter(h => typeof h.priceNow === "number");
  if (withPrice.length < 15) return null; // poco histórico todavía, no proponer nada
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

// ---------- Pasos concretos de reequilibrio (enlaces + instrucciones) ----------
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

// ---------- Sugerencia de actuación, ahora con memoria ----------
const WIDE_MARGIN_THRESHOLD = 30; // % de margen a partir del cual se considera "holgado"
const MIN_DAYS_FOR_RANGE_SUGGESTION = 3; // mínimo técnico para poder calcular algo
const RECOMMENDED_DAYS_BEFORE_ACTING = 21; // con menos, la propuesta es orientativa, no una recomendación firme
const MIN_USD_TO_JUSTIFY_GAS = 15; // por debajo de esto, el gas de retirar+abrir probablemente se come la mejora

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

      // Justificación con datos de si merece la pena actuar YA o esperar
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

// ---------- Lectura coloquial del Montecarlo ----------
// Traduce los tres percentiles del escenario neutro a una frase en lenguaje llano,
// con las cifras reales de la posición (no la referencia de 1000€, que es solo para
// comparar posiciones entre sí). Detecta además el "efecto suelo/techo": cuando el
// percentil 10 (o 90) coincide entre el escenario neutro y el de tendencia, es porque
// el precio simulado ya salió del rango en ambos casos — la posición se queda fija en
// un solo token y deja de perder (o ganar) más por este mecanismo, así que el resultado
// converge. Vale la pena explicarlo, porque si no parece una casualidad rara.
export function buildColloquialMcSummary(mc, initialUSD) {
  const p10 = mc.neutro.valorP10.returnPct;
  const p50 = mc.neutro.valorP50.returnPct;
  const p90 = mc.neutro.valorP90.returnPct;
  const dollarAt = (pct) => initialUSD * (1 + pct / 100);
  const fmtPct = (p) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
  const fmtDollar = (p) => `$${dollarAt(p).toFixed(2)}`;

  const FLOOR_MATCH_THRESHOLD_PCT = 0.5; // diferencia máxima para considerar que es el mismo "suelo"
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

  // Desglose: cuánto de la ganancia viene genuinamente de ser LP (fees - IL) vs. solo del
  // movimiento de precio (esto último lo habrías ganado igual con solo holdear los tokens).
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

    // Proyección a un importe de referencia (1.000€), escalando linealmente el mismo desglose
    // YA OBSERVADO (mismo periodo real, sin extrapolar en el tiempo — por eso es fiable).
    const REF_AMOUNT = 1000;
    if (r.initialUSD > 0) {
      const factor = REF_AMOUNT / r.initialUSD;
      const gainScaled = gainUSD * factor;
      const vsHoldScaled = r.vsHoldUSD * factor;
      const priceOnlyScaled = priceOnlyUSD * factor;
      msg += `\n💡 Con ${REF_AMOUNT}€ en vez de $${r.initialUSD.toFixed(2)}: ganancia aprox. ${fmt(gainScaled)} (${fmt(vsHoldScaled)} LP · ${fmt(priceOnlyScaled)} precio). Estimación lineal simple del mismo periodo ya vivido (no una proyección a futuro) — el gas pesa menos proporcionalmente con más capital, así que lo real tendería a ser algo mejor que esto.`;
      // Nota: aquí ya NO se extrapola linealmente a 30 días — esa parte del mensaje se
      // sustituyó por la simulación Montecarlo de abajo, que sí modela la incertidumbre
      // en vez de proyectar un ritmo corto de forma ingenua (ver conversación del 22/8).
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

// Fase 3: un fallo de Telegram ya no pasa desapercibido. sendTelegram devuelve
// true/false; main() lleva la cuenta y marca el proceso como fallido al final
// (después de guardar history.json, que es lo importante que no se debe perder)
// para que la ejecución aparezca en rojo en GitHub Actions en vez de en verde
// como si todo hubiera ido bien.
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

  const symbols = [...new Set(raw.filter(r => !r.error).flatMap(r => [r.sym0, r.sym1]))];
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

      // Fase 2: vs Hold real, reconstruyendo el reparto de tokens que de verdad tenías al
      // entrar (no un 50/50 asumido). Necesita el precio de entrada real (Fase 1) y un
      // precio histórico absoluto para el día de apertura.
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
        // Fallback: sin precio de entrada real, sin fecha de apertura, o sin precio
        // histórico disponible ese día. Se avisa explícitamente, no se presenta como cierto.
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

  // Añadir la lectura de hoy al historial (antes de enviar el mensaje, para que
  // la próxima ejecución ya vea esta como "reciente")
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
    await new Promise(resolve => setTimeout(resolve, 500)); // pequeña pausa entre mensajes
  }

  if (anyTelegramFailed) {
    // history.json ya se guardó arriba, así que no se pierde nada — pero la ejecución
    // debe quedar marcada como fallida para que se note en GitHub Actions.
    console.error("Al menos un mensaje de Telegram no se pudo enviar. Marcando la ejecución como fallida.");
    process.exitCode = 1;
  }
}

// Solo ejecuta main() si el script se corre directamente (node check-positions.js),
// no cuando se importa como módulo desde los tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
