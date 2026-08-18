// check-alerts.js
// Revisa alerts.json (alertas de precio) y calibration.json (calibración proxy↔bróker),
// y manda avisos a Telegram cuando corresponde.
//
// Secrets necesarios en GitHub Actions:
//   TELEGRAM_BOT_TOKEN   (ya lo tienes del bot de Pools)
//   TELEGRAM_CHAT_ID     (ya lo tienes del bot de Pools)
//   OILPRICEAPI_KEY      (para alertas de precio)
//   ALPHAVANTAGE_KEY     (para revisión de calibración — opcional, se omite si no está)

import fs from "fs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OILPRICEAPI_KEY = process.env.OILPRICEAPI_KEY;
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

async function getPrice(priceCode) {
  const url = `https://api.oilpriceapi.com/v1/prices/latest?by_code=${encodeURIComponent(priceCode)}`;
  const res = await fetch(url, { headers: { Authorization: "Token " + OILPRICEAPI_KEY } });
  if (!res.ok) throw new Error(`oilpriceapi HTTP ${res.status}`);
  const json = await res.json();
  if (json.data && typeof json.data.price === "number") return json.data.price;
  if (typeof json.price === "number") return json.price;
  throw new Error("Formato de respuesta no reconocido: " + JSON.stringify(json));
}

// Se cumple la alerta si:
// - COMPRAR: el precio ha bajado hasta el nivel disparador o por debajo (zona de compra alcanzada)
// - CORTO:   el precio ha subido hasta el nivel disparador o por encima (zona de venta alcanzada)
function isTriggered(alert, currentPrice) {
  if (alert.direction === "COMPRAR") return currentPrice <= alert.triggerPrice;
  if (alert.direction === "CORTO") return currentPrice >= alert.triggerPrice;
  return false;
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

        if (isTriggered(alert, currentPrice)) {
          const emoji = alert.direction === "COMPRAR" ? "🟢" : "🔴";
          let setupLines = "";
          if (alert.precioSL) setupLines += `Stop Loss sugerido: ${alert.precioSL}\n`;
          if (alert.precioTP) setupLines += `Take Profit sugerido: ${alert.precioTP}\n`;
          if (alert.apalancamiento) setupLines += `Apalancamiento sugerido: ${alert.apalancamiento}x\n`;
          if (alert.invertido) setupLines += `Importe sugerido: $${alert.invertido}\n`;
          let riskLine = "";
          if (alert.precioSL && alert.invertido) {
            const distanciaPct = Math.abs(alert.triggerPrice - alert.precioSL) / alert.triggerPrice;
            const lev = alert.apalancamiento || 1;
            const maxPerdida = alert.invertido * distanciaPct * lev;
            riskLine = `Pérdida máxima estimada si salta el SL: $${maxPerdida.toFixed(2)}\n`;
          }
          const msg =
            `${emoji} <b>Alerta de precio cumplida — ${alert.instrument}</b>\n\n` +
            `Dirección: ${alert.direction}\n` +
            `Nivel disparador (= entrada sugerida): ${alert.triggerPrice}\n` +
            `Precio actual: ${currentPrice}\n` +
            setupLines +
            riskLine +
            (alert.note ? `Nota: ${alert.note}\n` : "") +
            `\n👉 Estos valores son una propuesta guardada por ti mismo en base al análisis previo — revísalos contra el precio real en eToro antes de aplicarlos, no los copies a ciegas.\n` +
            `Recuerda eliminar o editar esta alerta en alerts.json si actúas, o seguirás recibiendo el aviso en cada revisión mientras siga cumpliéndose.`;
          await sendTelegram(msg);
          console.log("Alerta enviada a Telegram.");
        }
      }
    }
  }

  await checkCalibrations();
}

main().catch(e => {
  console.error("Error general:", e);
  process.exit(1);
});
