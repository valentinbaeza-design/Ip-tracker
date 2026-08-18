// check-alerts.js
// Revisa alerts.json, compara con el precio en vivo de oilpriceapi.com,
// y manda un aviso a Telegram cuando una alerta se cumple.
//
// Secrets necesarios en GitHub Actions:
//   TELEGRAM_BOT_TOKEN   (ya lo tienes del bot de Pools)
//   TELEGRAM_CHAT_ID     (ya lo tienes del bot de Pools)
//   OILPRICEAPI_KEY      (nuevo — tu clave de oilpriceapi.com)

import fs from "fs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OILPRICEAPI_KEY = process.env.OILPRICEAPI_KEY;

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

async function main() {
  if (!fs.existsSync("alerts.json")) {
    console.log("No hay alerts.json en el repo, nada que revisar.");
    return;
  }
  const raw = fs.readFileSync("alerts.json", "utf8");
  const { alerts } = JSON.parse(raw);
  if (!alerts || alerts.length === 0) {
    console.log("alerts.json sin alertas pendientes.");
    return;
  }

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
      const msg =
        `${emoji} <b>Alerta de precio cumplida — ${alert.instrument}</b>\n\n` +
        `Dirección: ${alert.direction}\n` +
        `Nivel disparador: ${alert.triggerPrice}\n` +
        `Precio actual: ${currentPrice}\n` +
        (alert.note ? `Nota: ${alert.note}\n` : "") +
        `\n👉 Revisa el panel y decide — esto no abre ninguna operación por ti.\n` +
        `Recuerda eliminar o editar esta alerta en alerts.json si actúas, o seguirás recibiendo el aviso en cada revisión mientras siga cumpliéndose.`;
      await sendTelegram(msg);
      console.log("Alerta enviada a Telegram.");
    }
  }
}

main().catch(e => {
  console.error("Error general:", e);
  process.exit(1);
});
