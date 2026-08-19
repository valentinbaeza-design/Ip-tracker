// check-alerts.js
// Evaluación periódica (cada 4h) de las alertas de precio: tendencia reciente del proxy
// y estado de la calibración proxy↔bróker. NO dispara el aviso de "alerta cumplida" —
// eso lo hace check-trigger.js cada 15 min, con datos más frescos (API Ninjas).
// Este script es el análisis de fondo, no el guardián rápido.
//
// Secrets necesarios en GitHub Actions:
//   TELEGRAM_BOT_TOKEN   (ya lo tienes del bot de Pools)
//   TELEGRAM_CHAT_ID     (ya lo tienes del bot de Pools)
//   APININJAS_KEY        (precio actual, mismo que usa check-trigger.js)
//   ALPHAVANTAGE_KEY     (tendencia del proxy + calibración — opcional, se omite si no está)

import fs from "fs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APININJAS_KEY = process.env.APININJAS_KEY;
const ALPHAVANTAGE_KEY = process.env.ALPHAVANTAGE_KEY;

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
  });
  if (!res.ok) {
    console.error("Error enviando a Telegram:", await res.text());
  }
}

function priceCodeToApiNinjasName(priceCode) {
  return priceCode.replace(/_USD$/i, "").toLowerCase();
}

async function getPrice(priceCode) {
  const name = priceCodeToApiNinjasName(priceCode);
  const url = `https://api.api-ninjas.com/v1/commodityprice?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { "X-Api-Key": APININJAS_KEY } });
  if (!res.ok) throw new Error(`API Ninjas HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (typeof json.price !== "number") throw new Error("Formato de respuesta no reconocido: " + JSON.stringify(json));
  return json.price;
}

async function getAlphaVantagePrice(symbol) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${ALPHAVANTAGE_KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  const series = json["Time Series (Daily)"];
  if (!series) throw new Error("Respuesta no reconocida de Alpha Vantage: " + JSON.stringify(json).slice(0, 200));
  const dates = Object.keys(series).sort().reverse(); // más reciente primero
  return dates.slice(0, 10).map(d => parseFloat(series[d]["4. close"]));
}

async function checkCalibrations() {
  if (!fs.existsSync("calibration.json")) {
    console.log("No hay calibration.json en el repo, nada que revisar.");
    return;
  }
  if (!ALPHAVANTAGE_KEY) {
    console.log("Sin ALPHAVANTAGE_KEY configurada, se omite la revisión de calibración.");
    return;
  }
  const { calibrations } = JSON.parse(fs.readFileSync("calibration.json", "utf8"));
  if (!calibrations || calibrations.length === 0) return;

  for (const cal of calibrations) {
    try {
      const closes = await getAlphaVantagePrice(cal.proxySymbol);
      const daysSince = (Date.now() - new Date(cal.calibratedAt).getTime()) / (1000 * 60 * 60 * 24);

      // Detección de posible split: un salto varias veces mayor que el movimiento
      // típico reciente, en un instrumento que no suele moverse tanto, es sospechoso.
      let splitSuspected = false;
      if (closes.length >= 5) {
        const lastMove = Math.abs(closes[0] - closes[1]) / closes[1];
        const priorMoves = [];
        for (let i = 1; i < closes.length - 1; i++) {
          priorMoves.push(Math.abs(closes[i] - closes[i + 1]) / closes[i + 1]);
        }
        const avgMove = priorMoves.reduce((a, b) => a + b, 0) / priorMoves.length;
        if (avgMove > 0 && lastMove > avgMove * 5 && lastMove > 0.15) splitSuspected = true;
      }

      if (splitSuspected) {
        await sendTelegram(
          `⚠️ <b>Posible split detectado — ${cal.instrument}</b>\n\n` +
          `${cal.proxySymbol} ha dado un salto de precio mucho mayor de lo habitual (de ${closes[1]} a ${closes[0]}).\n` +
          `Esto suele ser la firma de un contra-split del ETF, no un movimiento real del mercado.\n\n` +
          `👉 Recalibra en el panel antes de fiarte del ratio actual (×${cal.ratio}).`
        );
        console.log(`${cal.instrument}: posible split detectado, aviso enviado.`);
      } else if (daysSince > (cal.maxDaysBeforeReminder || 14)) {
        await sendTelegram(
          `🔧 <b>Recordatorio de calibración — ${cal.instrument}</b>\n\n` +
          `Han pasado ${Math.floor(daysSince)} días desde tu última calibración (ratio ×${cal.ratio}).\n` +
          `👉 Cuando tengas un momento con eToro abierto, recalibra en el panel para mantener la traducción de niveles precisa.`
        );
        console.log(`${cal.instrument}: recordatorio de calibración enviado (${Math.floor(daysSince)} días).`);
      } else {
        console.log(`${cal.instrument}: calibración OK (${Math.floor(daysSince)} días, sin anomalías).`);
      }
    } catch (e) {
      console.error(`Error revisando calibración de ${cal.instrument}:`, e.message);
    }
  }
}

// ---------- Evaluación de tendencia cuando la alerta NO se cumple todavía ----------
// En vez de quedarse en silencio, valora si el movimiento reciente favorece o dificulta
// que se llegue al disparador, y si conviene mantenerlo, acercarlo o dejarlo tal cual.
async function buildTrendEvaluationMessage(alert, currentPrice) {
  const distance = alert.direction === "COMPRAR" ? currentPrice - alert.triggerPrice : alert.triggerPrice - currentPrice;
  const distancePct = (Math.abs(distance) / currentPrice) * 100;

  let trendLine = "";
  let adviceLine = "Sin datos de tendencia disponibles para esta evaluación (falta proxySymbol o ALPHAVANTAGE_KEY) — la alerta sigue activa igualmente.";

  if (alert.proxySymbol && ALPHAVANTAGE_KEY) {
    try {
      const closes = await getAlphaVantagePrice(alert.proxySymbol); // más reciente primero
      if (closes.length >= 6) {
        const latest = closes[0];
        const past = closes[5]; // ~5 sesiones atrás
        const trendPct = ((latest - past) / past) * 100;
        trendLine = `Tendencia reciente (${alert.proxySymbol}, ~5 sesiones): ${trendPct >= 0 ? "+" : ""}${trendPct.toFixed(1)}%.`;

        const favorable = alert.direction === "COMPRAR" ? trendPct < -1 : trendPct > 1;
        const contrary = alert.direction === "COMPRAR" ? trendPct > 1 : trendPct < -1;

        if (favorable) {
          adviceLine = "El movimiento reciente va en la dirección que tu alerta necesita — parece razonable mantenerla tal cual.";
        } else if (contrary) {
          const altTrigger = currentPrice - distance * 0.5;
          adviceLine =
            `El movimiento reciente va en dirección contraria a tu alerta — puede tardar más de lo esperado o no cumplirse pronto. ` +
            `Si prefieres no esperar tanto, podrías considerar un disparador más cercano, aprox. ${altTrigger.toFixed(3)} en lugar del actual (${alert.triggerPrice}). ` +
            `Sería sustituir esta alerta, no añadir una nueva — decide tú si te compensa asumir un precio de entrada peor a cambio de más probabilidad de que se cumpla pronto, o prefieres mantener la actual y esperar más.`;
        } else {
          adviceLine = "Sin tendencia clara en las últimas sesiones — la alerta actual sigue siendo razonable, no hace falta cambiar nada.";
        }
      }
    } catch (e) {
      console.error(`No se pudo evaluar tendencia de ${alert.instrument}:`, e.message);
    }
  }

  let msg = `🔍 <b>Evaluación de alerta — ${alert.instrument}</b>\n\n`;
  msg += `Dirección: ${alert.direction}\n`;
  msg += `Disparador: ${alert.triggerPrice}\n`;
  msg += `Precio actual: ${currentPrice}\n`;
  msg += `Distancia hasta el disparador: ${distancePct.toFixed(1)}%\n`;
  if (trendLine) msg += `${trendLine}\n`;
  msg += `\n👉 ${adviceLine}`;
  if (alert.note) msg += `\n\nNota original: ${alert.note}`;
  return msg;
}

async function main() {
  if (!fs.existsSync("alerts.json")) {
    console.log("No hay alerts.json en el repo, nada que revisar de alertas de precio.");
  } else {
    const raw = fs.readFileSync("alerts.json", "utf8");
    const { alerts } = JSON.parse(raw);
    if (!alerts || alerts.length === 0) {
      console.log("alerts.json sin alertas pendientes.");
    } else {
      // Agrupa por priceCode para no pedir el mismo precio varias veces si hay varias alertas del mismo instrumento
      const priceCache = {};
      for (const alert of alerts) {
        if (!priceCache[alert.priceCode]) {
          try {
            priceCache[alert.priceCode] = await getPrice(alert.priceCode);
          } catch (e) {
            console.error(`Error obteniendo precio de ${alert.priceCode}:`, e.message);
            continue;
          }
        }
        const currentPrice = priceCache[alert.priceCode];
        console.log(`${alert.instrument} (${alert.priceCode}): precio actual ${currentPrice}, disparador ${alert.direction} @ ${alert.triggerPrice}`);

        const evalMsg = await buildTrendEvaluationMessage(alert, currentPrice);
        await sendTelegram(evalMsg);
        console.log("Evaluación de tendencia enviada a Telegram.");
      }
    }
  }

  await checkCalibrations();
}

main().catch(e => {
  console.error("Error general:", e);
  process.exit(1);
});
