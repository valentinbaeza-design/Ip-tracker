// Tests de check-alerts.js — auditoría de la lógica de calibración/tendencia (24/8/2026).
// Criterio de aceptación: el bug de altTrigger para alertas CORTO detectado en esta
// sesión, con test de regresión explícito.
import assert from "assert";
import { computeAltTrigger, evaluateTrendDirection } from "./check-alerts-fixed.js";
import { isTriggered } from "./check-trigger-fixed.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("OK   -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "->", e.message); }
}

// --- Caso 1 (REGRESIÓN, el bug real): CORTO esperando subida de 100 a 120 — el
// disparador alternativo debe quedar ENTRE el precio actual y el original, nunca
// por debajo del precio actual. ---
test("computeAltTrigger (REGRESIÓN CORTO): el resultado debe quedar entre precio actual y disparador, no por debajo del actual", () => {
  const currentPrice = 100, triggerPrice = 120; // CORTO esperando que suba a 120
  const alt = computeAltTrigger(currentPrice, triggerPrice);
  assert.strictEqual(alt, 110, `debe ser el punto medio exacto (110), dio ${alt}`);
  assert.ok(alt > currentPrice, "el disparador alternativo de un CORTO nunca debe quedar por debajo del precio actual");
  assert.ok(alt < triggerPrice, "debe ser más cercano que el disparador original");
});

// --- Caso 2: COMPRAR esperando bajada de 100 a 90 — el alternativo debe quedar entre
// el precio actual y el original, nunca por encima del actual (simétrico al caso 1) ---
test("computeAltTrigger: COMPRAR — el resultado debe quedar entre precio actual y disparador, no por encima del actual", () => {
  const currentPrice = 100, triggerPrice = 90; // COMPRAR esperando que baje a 90
  const alt = computeAltTrigger(currentPrice, triggerPrice);
  assert.strictEqual(alt, 95, `debe ser el punto medio exacto (95), dio ${alt}`);
  assert.ok(alt < currentPrice, "el disparador alternativo de un COMPRAR nunca debe quedar por encima del precio actual");
  assert.ok(alt > triggerPrice, "debe ser más cercano que el disparador original");
});

// --- Caso 3: simetría — el resultado no debe depender de qué precio se pase primero,
// solo importa que sea el punto medio de los dos valores ---
test("computeAltTrigger: es simétrico (punto medio, sin importar el orden de los argumentos)", () => {
  assert.strictEqual(computeAltTrigger(100, 120), computeAltTrigger(120, 100));
});

// --- Caso 4: caso trivial, precio actual == disparador (ya se cumplió, caso límite) ---
test("computeAltTrigger: si precio actual y disparador coinciden, el resultado es el mismo valor", () => {
  assert.strictEqual(computeAltTrigger(100, 100), 100);
});

// --- Caso 5: evaluateTrendDirection — COMPRAR con precio cayendo fuerte debe ser favorable ---
test("evaluateTrendDirection: COMPRAR + precio cayendo fuerte => favorable, no contrary", () => {
  const r = evaluateTrendDirection("COMPRAR", -5, 2);
  assert.strictEqual(r.favorable, true);
  assert.strictEqual(r.contrary, false);
});

// --- Caso 6: evaluateTrendDirection — COMPRAR con precio subiendo fuerte debe ser contrary ---
test("evaluateTrendDirection: COMPRAR + precio subiendo fuerte => contrary, no favorable", () => {
  const r = evaluateTrendDirection("COMPRAR", 5, 2);
  assert.strictEqual(r.favorable, false);
  assert.strictEqual(r.contrary, true);
});

// --- Caso 7: evaluateTrendDirection — CORTO con precio subiendo fuerte debe ser favorable ---
test("evaluateTrendDirection: CORTO + precio subiendo fuerte => favorable, no contrary", () => {
  const r = evaluateTrendDirection("CORTO", 5, 2);
  assert.strictEqual(r.favorable, true);
  assert.strictEqual(r.contrary, false);
});

// --- Caso 8: evaluateTrendDirection — CORTO con precio cayendo fuerte debe ser contrary ---
test("evaluateTrendDirection: CORTO + precio cayendo fuerte => contrary, no favorable", () => {
  const r = evaluateTrendDirection("CORTO", -5, 2);
  assert.strictEqual(r.favorable, false);
  assert.strictEqual(r.contrary, true);
});

// --- Caso 9: evaluateTrendDirection — movimiento dentro de la banda de ruido, ni favorable ni contrary ---
test("evaluateTrendDirection: movimiento dentro del ruido normal => ni favorable ni contrary", () => {
  const r = evaluateTrendDirection("COMPRAR", 1, 2);
  assert.strictEqual(r.favorable, false);
  assert.strictEqual(r.contrary, false);
});

// --- Caso 10: isTriggered — COMPRAR se dispara cuando el precio cae al nivel o por debajo ---
test("isTriggered: COMPRAR se dispara al caer al disparador o por debajo, no antes", () => {
  assert.strictEqual(isTriggered({ direction: "COMPRAR", triggerPrice: 90 }, 85), true);
  assert.strictEqual(isTriggered({ direction: "COMPRAR", triggerPrice: 90 }, 90), true);
  assert.strictEqual(isTriggered({ direction: "COMPRAR", triggerPrice: 90 }, 95), false);
});

// --- Caso 11: isTriggered — CORTO se dispara cuando el precio sube al nivel o por encima ---
test("isTriggered: CORTO se dispara al subir al disparador o por encima, no antes", () => {
  assert.strictEqual(isTriggered({ direction: "CORTO", triggerPrice: 120 }, 125), true);
  assert.strictEqual(isTriggered({ direction: "CORTO", triggerPrice: 120 }, 120), true);
  assert.strictEqual(isTriggered({ direction: "CORTO", triggerPrice: 120 }, 110), false);
});

console.log(`\n${pass} pasadas, ${fail} fallidas`);
process.exit(fail > 0 ? 1 : 0);
