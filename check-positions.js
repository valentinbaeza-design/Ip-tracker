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

function tickToPrice(tick, dec0, dec1) {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}
function tickToSqrtPrice(tick) {
  return Math.sqrt(Math.pow(1.0001, tick));
}
function getAmountsForLiquidity(liquidity, sqrtP, sqrtA, sqrtB) {
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

async function getUsdPrices(symbols) {
  const map = { WETH: "ethereum", ETH: "ethereum", USDC: "usd-coin", ARB: "arbitrum" };
  const ids = [...new Set(symbols.map(s => map[s]).filter(Boolean))];
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`);
    const data = await res.json();
    const out = {};
    for (const s of symbols) out[s] = map[s] && data[map[s]] ? data[map[s]].usd : null;
    return out;
  } catch (e) {
    console.error("Error obteniendo precios USD:", e.message);
    return {};
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
function computeSuggestedRange(positionHistory, bufferPct = 10) {
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
function buildActionSteps(r, targetMin, targetMax) {
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

function buildSuggestion(r, positionHistory) {
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

function buildPositionMessage(r, now) {
  if (r.error) return `⚠️ *${r.label}*\n${now}\nError leyendo datos: ${r.error}`;

  const icon = r.inRange ? "🟢" : "🔴";
  const status = r.inRange ? "dentro de rango" : "FUERA DE RANGO";
  const valueLine = r.positionValueUSD !== null
    ? `Valor actual: $${r.positionValueUSD.toFixed(2)} · Fees ganadas: $${r.feesValueUSD.toFixed(2)}\nRendimiento total: ${r.totalReturnPct.toFixed(1)}%`
    : `Fees ganadas: ${r.fee0Human.toFixed(6)} ${r.sym0} + ${r.fee1Human.toFixed(6)} ${r.sym1} (sin precio USD disponible)`;
  const ilLine = r.ilPct !== null ? `IL aprox. vs entrada: ${r.ilPct.toFixed(2)}% · vs hold 50/50: ${r.vsHoldUSD >= 0 ? "+" : ""}$${r.vsHoldUSD.toFixed(2)}` : "";

  let msg = `${icon} *${r.label}* — ${now}\n${status} — ${r.sym1}/${r.sym0}: ${r.priceNow.toFixed(4)}\nMargen: ${r.distToLower}% / ${r.distToUpper}%\n${valueLine}\n${ilLine}\n👉 ${r.suggestion.text}`;

  const action = r.suggestion.action;
  if (action) {
    msg += `\n\n*Pasos para reequilibrar:*\n`;
    msg += `1️⃣ Cierra/retira la posición actual: revisa tu lista en ${action.closeUrl}, busca "*${r.label}*" (NFT #${r.tokenId}) y pulsa en ella → retirar liquidez.\n`;
    if (action.openUrl) {
      msg += `2️⃣ Abre la nueva posición aquí: ${action.openUrl}\n`;
      msg += `3️⃣ Al elegir el rango, usa los botones +/- (nunca escribas el precio directamente) hasta acercarte a: *${action.targetMin.toFixed(4)} – ${action.targetMax.toFixed(4)}*.\n`;
    }
    msg += `\n⚠️ Verifica red y direcciones de contrato antes de firmar. Esto es una propuesta calculada, no una instrucción a ciegas — decide tú si te compensa el gas y el mantenimiento extra.`;
  }

  if (r.ilPct !== null && !r.entryPrice) {
    msg += `\n\n_IL y comparativa vs hold son aproximados (sin precio de entrada exacto registrado)._`;
  }
  return msg;
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "Markdown" })
  });
  if (!res.ok) console.error("Error enviando a Telegram:", await res.text());
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

  const results = raw.map(r => {
    if (r.error) return r;
    const p0 = prices[r.sym0], p1 = prices[r.sym1];
    let positionValueUSD = null, feesValueUSD = null, totalReturnPct = null, ilPct = null, vsHoldUSD = null;
    if (p0 != null && p1 != null) {
      positionValueUSD = r.amount0Human * p0 + r.amount1Human * p1;
      feesValueUSD = r.fee0Human * p0 + r.fee1Human * p1;
      totalReturnPct = ((positionValueUSD + feesValueUSD - r.initialUSD) / r.initialUSD) * 100;

      const entryApprox = r.entryPrice || Math.sqrt(r.priceMin * r.priceMax);
      const ratio = r.priceNow / entryApprox;
      ilPct = (2 * Math.sqrt(ratio) / (1 + ratio) - 1) * 100;
      const holdValueUSD = r.initialUSD * (0.5 + 0.5 * ratio);
      vsHoldUSD = (positionValueUSD + feesValueUSD) - holdValueUSD;
    }
    const withCalc = { ...r, positionValueUSD, feesValueUSD, totalReturnPct, ilPct, vsHoldUSD };
    const positionHistory = history.positions[r.tokenId] || [];
    const suggestion = buildSuggestion(withCalc, positionHistory);
    return { ...withCalc, suggestion };
  });

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
      entryPriceUsed: !!r.entryPrice
    });
  });
  saveHistory(history);

  results.forEach(r => console.log(r));

  const now = new Date().toLocaleString("es-ES", { timeZone: "Europe/Madrid" });
  for (const r of results) {
    await sendTelegram(buildPositionMessage(r, now));
    await new Promise(resolve => setTimeout(resolve, 500)); // pequeña pausa entre mensajes
  }
}

main();
